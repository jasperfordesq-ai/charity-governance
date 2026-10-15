BEGIN;
-- Review evidence only: no FK or exception is added to a deletion queue.
CREATE TABLE "ConfluenceRetainedCopyReview" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "documentId" TEXT NOT NULL,
  "publicationId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "snapshotSha256" TEXT NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  review JSONB NOT NULL CHECK (jsonb_typeof(review)='object'),
  "reviewedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "authorisesProviderIO" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "authorisesProviderIO"),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id,"organisationId")
);
CREATE INDEX "ConfluenceCopyReview_org_publication_recorded_idx"
  ON "ConfluenceRetainedCopyReview"("organisationId","publicationId","recordedAt");

CREATE TABLE "ConfluenceRetainedCopyReviewWithdrawal" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "reviewId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceCopyReviewWithdrawal_review_org_key" UNIQUE ("reviewId","organisationId"),
  CONSTRAINT "ConfluenceCopyReviewWithdrawal_review_fkey" FOREIGN KEY ("reviewId","organisationId") REFERENCES "ConfluenceRetainedCopyReview"(id,"organisationId") ON DELETE RESTRICT
);
CREATE INDEX "ConfluenceCopyReviewWithdrawal_org_occurred_idx"
  ON "ConfluenceRetainedCopyReviewWithdrawal"("organisationId","occurredAt");

CREATE FUNCTION "ConfluenceRetainedCopyReview_guard_fn"() RETURNS trigger AS $$
DECLARE doc "Document"%ROWTYPE; pub "DocumentPublication"%ROWTYPE; snap JSONB;
  actor_id TEXT; evidence_key TEXT; clock TIMESTAMP(3) := timezone('UTC', statement_timestamp());
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Confluence copy reviews are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF TG_TABLE_NAME='ConfluenceRetainedCopyReview' THEN actor_id := NEW."reviewerId";
  ELSE actor_id := NEW."actorUserId"; END IF;
  PERFORM 1 FROM "User" WHERE id=actor_id AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence copy review requires the active charity owner'; END IF;
  -- New review decisions cannot outrun an independently bound history. These
  -- records are non-authorising even when the charity is not yet bound.
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence copy review requires independent recovery recording';
  END IF;
  IF TG_TABLE_NAME='ConfluenceRetainedCopyReviewWithdrawal' THEN
    PERFORM 1 FROM "ConfluenceRetainedCopyReview" WHERE id=NEW."reviewId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Confluence copy review not found in charity'; END IF;
    NEW."occurredAt" := clock;
    RETURN NEW;
  END IF;
  snap := NEW.review->'snapshot';
  FOREACH evidence_key IN ARRAY ARRAY['evidenceRef','retentionDecisionRef','holdReviewRef','inventoryEvidenceRef','syntheticEvidenceRef'] LOOP
    IF jsonb_typeof(NEW.review->evidence_key) IS DISTINCT FROM 'string'
      OR NEW.review->>evidence_key !~ '^[A-Z0-9][A-Z0-9-]{2,119}$' THEN
      RAISE EXCEPTION 'Confluence copy review requires controlled evidence references';
    END IF;
  END LOOP;
  IF NEW.review->>'scope' IS DISTINCT FROM 'SYNTHETIC_ONLY'
    OR NEW.review->>'primaryDisposition' IS DISTINCT FROM 'RETAIN'
    OR NEW.review->>'copyDisposition' IS DISTINCT FROM 'PURGE'
    OR NEW.review->>'reviewerId' IS DISTINCT FROM NEW."reviewerId"
    OR snap->>'organisationId' IS DISTINCT FROM NEW."organisationId"
    OR snap->>'documentId' IS DISTINCT FROM NEW."documentId"
    OR snap->>'publicationId' IS DISTINCT FROM NEW."publicationId"
    OR (NEW.review->>'reviewedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."reviewedAt"
    OR (NEW.review->>'expiresAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."expiresAt"
    OR snap->'inventory'->'complete' IS DISTINCT FROM 'true'::jsonb
    OR snap->'inventory'->>'status' IS DISTINCT FROM 'CURRENT'
    OR (snap->'inventory'->>'observedAt') IS NULL
    OR (snap->'inventory'->>'observedAt')::timestamptz AT TIME ZONE 'UTC' > NEW."reviewedAt"
    OR jsonb_typeof(snap->'sourceSha256') IS DISTINCT FROM 'string'
    OR snap->>'sourceSha256' !~ '^[a-f0-9]{64}$'
    OR NEW."reviewedAt">clock OR NEW."expiresAt"<=clock OR NEW."authorisesProviderIO" THEN
    RAISE EXCEPTION 'Confluence copy review must bind exact non-authorising synthetic scope and time';
  END IF;
  SELECT * INTO doc FROM "Document" WHERE id=NEW."documentId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR doc."deletedAt" IS NOT NULL OR doc."deletionHold" OR doc."lifecycleStatus"<>'RETIRED'
    OR doc."externalPublicationApproved"
    OR snap->>'lifecycleStatus' IS DISTINCT FROM 'RETIRED'
    OR snap->'deletionHold' IS DISTINCT FROM 'false'::jsonb
    OR snap->'externalPublicationApproved' IS DISTINCT FROM 'false'::jsonb
    OR (snap->>'sourceRevision')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM doc."updatedAt" THEN
    RAISE EXCEPTION 'Confluence copy review requires the exact retained unheld retired source';
  END IF;
  SELECT * INTO pub FROM "DocumentPublication" WHERE id=NEW."publicationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR pub."documentId"<>doc.id OR pub.provider<>'confluence' OR pub.state<>'RETIRED'
    OR pub."cloudId" IS NULL OR pub."spaceId" IS NULL OR pub."pageId" IS NULL
    OR pub."erasureDeletionId" IS NOT NULL
    OR snap->>'publicationState' IS DISTINCT FROM 'RETIRED'
    OR snap->>'cloudId' IS DISTINCT FROM pub."cloudId"
    OR snap->>'spaceId' IS DISTINCT FROM pub."spaceId"
    OR snap->>'pageId' IS DISTINCT FROM pub."pageId"
    OR (snap->>'publicationRevision')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM pub."updatedAt" THEN
    RAISE EXCEPTION 'Confluence copy review requires the exact retired publication';
  END IF;
  NEW."recordedAt" := clock;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConfluenceRetainedCopyReview_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceRetainedCopyReview"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceRetainedCopyReview_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyReview_no_truncate" BEFORE TRUNCATE ON "ConfluenceRetainedCopyReview"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceRetainedCopyReview_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyReviewWithdrawal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceRetainedCopyReviewWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceRetainedCopyReview_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyReviewWithdrawal_no_truncate" BEFORE TRUNCATE ON "ConfluenceRetainedCopyReviewWithdrawal"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceRetainedCopyReview_guard_fn"();

-- Binding cannot forget review/withdrawal decisions created before activation.
-- A later independently replayable implementation must replace this refusal.
CREATE FUNCTION "ConfluenceCopyReview_recovery_activation_guard_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ConfluenceRetainedCopyReview" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document recovery binding requires independent Confluence copy review history';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_DocumentRecoveryEnforcement_copy_review_quiescence"
  BEFORE INSERT ON "DocumentRecoveryEnforcement" FOR EACH ROW
  EXECUTE FUNCTION "ConfluenceCopyReview_recovery_activation_guard_fn"();
COMMIT;
