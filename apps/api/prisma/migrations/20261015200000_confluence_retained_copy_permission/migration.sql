BEGIN;
-- Apply hardening through this forward migration without editing a prior
-- migration/checksum. Explicit pg_temp-last lookup prevents temporary-table
-- impersonation even when a restricted session still has database TEMP.
ALTER FUNCTION "ConfluenceRetainedCopyReview_guard_fn"() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "ConfluenceCopyReview_recovery_activation_guard_fn"() SET search_path = pg_catalog, public, pg_temp;
-- Maintenance registration narrows an Owner's later decision to an exact
-- immutable review. It does not classify content by name or a client flag.
CREATE TABLE "ConfluenceSyntheticCopyScope" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "reviewId" TEXT NOT NULL UNIQUE,
  "snapshotSha256" TEXT NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  classification TEXT NOT NULL DEFAULT 'SYNTHETIC_ONLY' CHECK (classification='SYNTHETIC_ONLY'),
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "disposalPolicyEvidenceRef" TEXT NOT NULL CHECK ("disposalPolicyEvidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "approvedById" TEXT NOT NULL,
  "registeredByDbRole" TEXT NOT NULL DEFAULT CURRENT_USER,
  "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceSyntheticScope_review_org_key" UNIQUE("reviewId","organisationId"),
  CONSTRAINT "ConfluenceSyntheticScope_review_fkey" FOREIGN KEY("reviewId","organisationId")
    REFERENCES "ConfluenceRetainedCopyReview"(id,"organisationId") ON DELETE RESTRICT
);
CREATE TABLE "ConfluenceRetainedCopyPermission" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "reviewId" TEXT NOT NULL UNIQUE, "scopeId" TEXT NOT NULL UNIQUE,
  "snapshotSha256" TEXT NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  "actorUserId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "connectionGeneration" TIMESTAMP(3) NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  attestation TEXT NOT NULL CHECK (attestation='AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY'),
  "scopeEvidenceRef" TEXT NOT NULL,
  "disposalPolicyEvidenceRef" TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'OWNER_ATTESTED_SYNTHETIC' CHECK (classification='OWNER_ATTESTED_SYNTHETIC'),
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
  UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceCopyPermission_review_org_key" UNIQUE("reviewId","organisationId"),
  CONSTRAINT "ConfluenceCopyPermission_scope_org_key" UNIQUE("scopeId","organisationId"),
  CONSTRAINT "ConfluenceCopyPermission_review_fkey" FOREIGN KEY("reviewId","organisationId")
    REFERENCES "ConfluenceRetainedCopyReview"(id,"organisationId") ON DELETE RESTRICT,
  CONSTRAINT "ConfluenceCopyPermission_scope_fkey" FOREIGN KEY("scopeId","organisationId")
    REFERENCES "ConfluenceSyntheticCopyScope"(id,"organisationId") ON DELETE RESTRICT
);
CREATE TABLE "ConfluenceRetainedCopyPermissionWithdrawal" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "permissionId" TEXT NOT NULL UNIQUE, "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceCopyPermissionWithdrawal_permission_org_key" UNIQUE("permissionId","organisationId"),
  CONSTRAINT "ConfluenceCopyPermissionWithdrawal_permission_fkey" FOREIGN KEY("permissionId","organisationId")
    REFERENCES "ConfluenceRetainedCopyPermission"(id,"organisationId") ON DELETE RESTRICT
);

CREATE FUNCTION "ConfluenceCopyPermission_current_review"(review_id TEXT, charity_id TEXT) RETURNS void AS $$
DECLARE r "ConfluenceRetainedCopyReview"%ROWTYPE; d "Document"%ROWTYPE; p "DocumentPublication"%ROWTYPE; s JSONB;
BEGIN
  SELECT * INTO r FROM "ConfluenceRetainedCopyReview" WHERE id=review_id AND "organisationId"=charity_id FOR UPDATE;
  IF NOT FOUND OR r."expiresAt"<=timezone('UTC',statement_timestamp())
    OR EXISTS (SELECT 1 FROM "ConfluenceRetainedCopyReviewWithdrawal" WHERE "reviewId"=r.id)
    OR r.review->>'scope' IS DISTINCT FROM 'SYNTHETIC_ONLY'
    OR r.review->>'primaryDisposition' IS DISTINCT FROM 'RETAIN'
    OR r.review->>'copyDisposition' IS DISTINCT FROM 'PURGE' THEN
    RAISE EXCEPTION 'Confluence permission requires a current unwithdrawn synthetic review';
  END IF;
  s := r.review->'snapshot';
  SELECT * INTO d FROM "Document" WHERE id=r."documentId" AND "organisationId"=charity_id FOR UPDATE;
  IF NOT FOUND OR d."deletedAt" IS NOT NULL OR d."deletionHold" OR d."lifecycleStatus"<>'RETIRED'
    OR d."externalPublicationApproved"
    OR (s->>'sourceRevision')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM d."updatedAt" THEN
    RAISE EXCEPTION 'Confluence permission source changed or is not retained and unheld';
  END IF;
  SELECT * INTO p FROM "DocumentPublication" WHERE id=r."publicationId" AND "organisationId"=charity_id FOR UPDATE;
  IF NOT FOUND OR p."documentId"<>d.id OR p.provider<>'confluence' OR p.state<>'RETIRED'
    OR p."claimedAt" IS NOT NULL OR p."erasureDeletionId" IS NOT NULL
    OR p."cloudId" IS DISTINCT FROM s->>'cloudId' OR p."spaceId" IS DISTINCT FROM s->>'spaceId'
    OR p."pageId" IS DISTINCT FROM s->>'pageId'
    OR (s->>'publicationRevision')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM p."updatedAt" THEN
    RAISE EXCEPTION 'Confluence permission publication changed or already has an erasure';
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "ConfluenceCopyPermission_guard_fn"() RETURNS trigger AS $$
DECLARE actor_id TEXT; r "ConfluenceRetainedCopyReview"%ROWTYPE; scope "ConfluenceSyntheticCopyScope"%ROWTYPE;
  integration "OrganisationIntegration"%ROWTYPE;
  clock TIMESTAMP(3) := timezone('UTC',statement_timestamp());
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence permission and scope history is append-only'; END IF;
  IF TG_TABLE_NAME='ConfluenceSyntheticCopyScope' THEN
    IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class
      WHERE oid='public."ConfluenceSyntheticCopyScope"'::regclass) THEN
      RAISE EXCEPTION 'Synthetic copy scope registration requires the maintenance table owner';
    END IF;
    actor_id := NEW."approvedById";
  ELSE actor_id := NEW."actorUserId"; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence permission requires an active charity'; END IF;
  PERFORM 1 FROM "User" WHERE id=actor_id AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence permission requires the active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence permission requires independent recovery recording';
  END IF;
  IF TG_TABLE_NAME='ConfluenceRetainedCopyPermissionWithdrawal' THEN
    PERFORM 1 FROM "ConfluenceRetainedCopyPermission" WHERE id=NEW."permissionId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Confluence permission not found in charity'; END IF;
    NEW."occurredAt" := clock; RETURN NEW;
  END IF;
  PERFORM "ConfluenceCopyPermission_current_review"(NEW."reviewId",NEW."organisationId");
  SELECT * INTO r FROM "ConfluenceRetainedCopyReview" WHERE id=NEW."reviewId" AND "organisationId"=NEW."organisationId";
  IF NEW."snapshotSha256" IS DISTINCT FROM r."snapshotSha256" OR NEW."expiresAt"<=clock OR NEW."expiresAt">r."expiresAt" THEN
    RAISE EXCEPTION 'Confluence permission must bind the exact reviewed digest and expiry';
  END IF;
  IF TG_TABLE_NAME='ConfluenceSyntheticCopyScope' THEN
    NEW."registeredAt" := clock; NEW."registeredByDbRole" := current_user; RETURN NEW;
  END IF;
  SELECT * INTO scope FROM "ConfluenceSyntheticCopyScope" WHERE id=NEW."scopeId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR scope."reviewId"<>r.id OR scope."snapshotSha256"<>NEW."snapshotSha256"
    OR scope.classification<>'SYNTHETIC_ONLY' OR NEW."expiresAt">scope."expiresAt" OR scope."expiresAt"<=clock THEN
    RAISE EXCEPTION 'Confluence permission requires its exact registered synthetic scope';
  END IF;
  IF NEW."scopeEvidenceRef" IS DISTINCT FROM scope."evidenceRef"
    OR NEW."disposalPolicyEvidenceRef" IS DISTINCT FROM scope."disposalPolicyEvidenceRef" THEN
    RAISE EXCEPTION 'Confluence permission must confirm the registered scope and disposal decision evidence';
  END IF;
  SELECT * INTO integration FROM "OrganisationIntegration" WHERE id=NEW."integrationId"
    AND "organisationId"=NEW."organisationId" AND provider='CONFLUENCE' FOR UPDATE;
  IF NOT FOUND OR integration.status<>'CONNECTED' OR integration."connectedAt" IS NULL
    OR NEW."connectionGeneration" IS DISTINCT FROM integration."connectedAt"
    OR integration.config->>'siteId' IS DISTINCT FROM r.review->'snapshot'->>'cloudId'
    OR (integration.config->>'siteUrl' IS DISTINCT FROM r.review->'snapshot'->>'siteOrigin'
      AND integration.config->>'siteUrl' IS DISTINCT FROM (r.review->'snapshot'->>'siteOrigin') || '/')
    OR NOT (ARRAY['read:page:confluence','read:attachment:confluence']::TEXT[] <@ integration."grantedScopes") THEN
    RAISE EXCEPTION 'Confluence permission requires the exact connected grant generation and site';
  END IF;
  NEW."issuedAt" := clock; RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "ConfluenceSyntheticCopyScope_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceSyntheticCopyScope"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
CREATE TRIGGER "ConfluenceSyntheticCopyScope_no_truncate" BEFORE TRUNCATE ON "ConfluenceSyntheticCopyScope"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyPermission_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceRetainedCopyPermission"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyPermission_no_truncate" BEFORE TRUNCATE ON "ConfluenceRetainedCopyPermission"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyPermissionWithdrawal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceRetainedCopyPermissionWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
CREATE TRIGGER "ConfluenceRetainedCopyPermissionWithdrawal_no_truncate" BEFORE TRUNCATE ON "ConfluenceRetainedCopyPermissionWithdrawal"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyPermission_guard_fn"();
COMMIT;
