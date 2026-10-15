BEGIN;
CREATE TABLE "ConfluenceCopyRecoveryCapture" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "reviewId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL CHECK ("installationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "operationId" TEXT NOT NULL CHECK ("operationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  "sourceRevision" TEXT NOT NULL CHECK ("sourceRevision" ~ '^[a-f0-9]{40}$'),
  "actorUserId" TEXT NOT NULL,
  "factsRevision" INTEGER NOT NULL CHECK ("factsRevision" BETWEEN 1 AND 10000),
  "previousFactsDigest" TEXT CHECK ("previousFactsDigest" ~ '^[a-f0-9]{64}$'),
  "capturedAt" TIMESTAMP(3) NOT NULL,
  facts TEXT NOT NULL CHECK (octet_length(facts) BETWEEN 1 AND 16777216),
  "factsDigest" TEXT NOT NULL CHECK ("factsDigest" ~ '^[a-f0-9]{64}$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceCopyCapture_org_operation_key" UNIQUE("organisationId","operationId"),
  CONSTRAINT "ConfluenceCopyCapture_org_review_revision_key" UNIQUE("organisationId","reviewId","factsRevision"),
  CONSTRAINT "ConfluenceCopyCapture_review_fkey" FOREIGN KEY("reviewId","organisationId")
    REFERENCES "ConfluenceRetainedCopyReview"(id,"organisationId") ON DELETE RESTRICT
);

-- Normalize only the named SQL timestamp columns to the API's exact UTC-ms
-- representation. The nested review JSON is left untouched.
CREATE FUNCTION "ConfluenceCopyCapture_timestamp_row"(row_data JSONB, date_keys TEXT[]) RETURNS JSONB
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_object_agg(key, CASE WHEN key=ANY(date_keys)
    THEN to_jsonb(to_char((value#>>'{}')::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ELSE value END) FROM jsonb_each(row_data)
$$;

CREATE FUNCTION "ConfluenceCopyRecoveryCapture_guard_fn"() RETURNS trigger AS $$
DECLARE r public."ConfluenceRetainedCopyReview"%ROWTYPE;
  rw public."ConfluenceRetainedCopyReviewWithdrawal"%ROWTYPE;
  s public."ConfluenceSyntheticCopyScope"%ROWTYPE;
  p public."ConfluenceRetainedCopyPermission"%ROWTYPE;
  pw public."ConfluenceRetainedCopyPermissionWithdrawal"%ROWTYPE;
  prior public."ConfluenceCopyRecoveryCapture"%ROWTYPE;
  expected JSONB; payload JSONB; old_payload JSONB; component TEXT; recorded_time TIMESTAMP;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence recovery captures are append-only'; END IF;
  IF octet_length(NEW.facts) NOT BETWEEN 1 AND 16777216 THEN
    RAISE EXCEPTION 'Confluence recovery capture facts exceed capacity';
  END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE') THEN
    RAISE EXCEPTION 'Confluence recovery capture requires active charity Owner';
  END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence recovery capture requires active charity Owner'; END IF;
  SELECT * INTO r FROM public."ConfluenceRetainedCopyReview"
    WHERE id=NEW."reviewId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence recovery capture review not found in charity'; END IF;
  SELECT * INTO rw FROM public."ConfluenceRetainedCopyReviewWithdrawal"
    WHERE "reviewId"=r.id AND "organisationId"=NEW."organisationId";
  SELECT * INTO s FROM public."ConfluenceSyntheticCopyScope"
    WHERE "reviewId"=r.id AND "organisationId"=NEW."organisationId";
  SELECT * INTO p FROM public."ConfluenceRetainedCopyPermission"
    WHERE "reviewId"=r.id AND "organisationId"=NEW."organisationId";
  SELECT * INTO pw FROM public."ConfluenceRetainedCopyPermissionWithdrawal"
    WHERE "permissionId"=p.id AND "organisationId"=NEW."organisationId";
  SELECT * INTO prior FROM public."ConfluenceCopyRecoveryCapture"
    WHERE "reviewId"=r.id AND "organisationId"=NEW."organisationId" ORDER BY "factsRevision" DESC LIMIT 1;
  IF prior.id IS NULL THEN
    IF NEW."factsRevision"<>1 OR NEW."previousFactsDigest" IS NOT NULL THEN
      RAISE EXCEPTION 'Confluence recovery capture initial lineage mismatch';
    END IF;
  ELSIF NEW."factsRevision"<>prior."factsRevision"+1
    OR NEW."previousFactsDigest" IS DISTINCT FROM prior."factsDigest"
    OR NEW."installationId"<>prior."installationId" OR NEW."writerEpoch"<>prior."writerEpoch"
    OR NEW."capturedAt"<prior."capturedAt" THEN
    RAISE EXCEPTION 'Confluence recovery capture predecessor mismatch';
  END IF;
  expected:=jsonb_build_object('format',1,'kind','CONFLUENCE_COPY_DECISION_STATE_V1',
    'installationId',NEW."installationId",'organisationId',NEW."organisationId",'operationId',NEW."operationId",
    'writerEpoch',NEW."writerEpoch",'sourceRevision',NEW."sourceRevision",'factsRevision',NEW."factsRevision",
    'previousFactsDigest',NEW."previousFactsDigest",
    'capturedAt',to_char(NEW."capturedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'review',public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(r),ARRAY['reviewedAt','expiresAt','recordedAt']),
    'reviewWithdrawal',CASE WHEN rw.id IS NULL THEN 'null'::jsonb ELSE public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(rw),ARRAY['occurredAt']) END,
    'scope',CASE WHEN s.id IS NULL THEN 'null'::jsonb ELSE public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(s),ARRAY['registeredAt','expiresAt']) END,
    'permission',CASE WHEN p.id IS NULL THEN 'null'::jsonb ELSE public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(p),ARRAY['connectionGeneration','issuedAt','expiresAt']) END,
    'permissionWithdrawal',CASE WHEN pw.id IS NULL THEN 'null'::jsonb ELSE public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(pw),ARRAY['occurredAt']) END);
  payload:=NEW.facts::jsonb;
  IF payload IS DISTINCT FROM expected
    OR NEW."factsDigest"<>encode(sha256(convert_to(NEW.facts,'UTF8')),'hex')
    OR NEW."capturedAt"<r."recordedAt" OR NEW."capturedAt">timezone('UTC',clock_timestamp()) THEN
    RAISE EXCEPTION 'Confluence recovery capture requires complete committed facts and matching digest';
  END IF;
  old_payload:=prior.facts::jsonb;
  FOREACH component IN ARRAY ARRAY['reviewWithdrawal','scope','permission','permissionWithdrawal'] LOOP
    recorded_time:=COALESCE((payload->component->>'occurredAt')::timestamp,
      (payload->component->>'registeredAt')::timestamp,(payload->component->>'issuedAt')::timestamp);
    IF recorded_time>NEW."capturedAt" OR (prior.id IS NOT NULL AND (
      (old_payload->component<>'null'::jsonb AND old_payload->component IS DISTINCT FROM payload->component)
      OR (old_payload->component='null'::jsonb AND recorded_time<prior."capturedAt"))) THEN
      RAISE EXCEPTION 'Confluence recovery capture dropped or backdated committed evidence';
    END IF;
  END LOOP;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "ConfluenceCopyRecoveryCapture_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "ConfluenceCopyRecoveryCapture" FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyRecoveryCapture_guard_fn"();
CREATE TRIGGER "ConfluenceCopyRecoveryCapture_truncate_guard" BEFORE TRUNCATE
  ON "ConfluenceCopyRecoveryCapture" FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyRecoveryCapture_guard_fn"();
COMMIT;
