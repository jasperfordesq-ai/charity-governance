BEGIN;
-- A reviewed plan alone never releases the retained Document or queues cleanup.
CREATE TABLE "DocumentPurgeAuthorization" (
  "id" TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"("id") ON DELETE RESTRICT,
  "documentId" TEXT NOT NULL,
  "documentRevision" TIMESTAMP(3) NOT NULL,
  "policyId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "reason" TEXT NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500 AND "reason" !~ '[[:cntrl:]]'),
  "storagePath" TEXT NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('local','supabase')),
  "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "fileSize" INTEGER NOT NULL CHECK ("fileSize" >= 0),
  "recoveryUntil" TIMESTAMP(3) NOT NULL,
  "dispositionPlan" JSONB NOT NULL,
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("policyId","organisationId") REFERENCES "DataRetentionPolicyRevision"("id","organisationId") ON DELETE RESTRICT,
  UNIQUE ("id","organisationId")
);
CREATE INDEX "DocumentPurgeAuthorization_organisationId_documentId_authoriz_idx"
  ON "DocumentPurgeAuthorization"("organisationId","documentId","authorizedAt");

CREATE FUNCTION "DocumentPurgeAuthorization_guard_fn"() RETURNS trigger AS $$
DECLARE doc "Document"%ROWTYPE; policy "DataRetentionPolicyRevision"%ROWTYPE;
  area TEXT; entry JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purge authorizations are append-only'; END IF;
  -- Match policy administration's organisation/actor ordering, then recovery's
  -- document/policy ordering. The eventual claim must recheck all these facts.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge authorization requires the active charity owner'; END IF;
  SELECT * INTO doc FROM "Document" WHERE id=NEW."documentId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR doc."deletedAt" IS NULL OR doc."deletionHold" OR doc."lifecycleStatus" <> 'DRAFT'
    OR doc."approvalAsserted" OR doc."approvedByResolutionId" IS NOT NULL THEN
    RAISE EXCEPTION 'Purge authorization requires an unheld removed draft';
  END IF;
  IF NEW."documentRevision" IS DISTINCT FROM doc."updatedAt"
    OR NEW."storagePath" IS DISTINCT FROM doc."fileUrl" OR NEW."provider" IS DISTINCT FROM doc."storageProvider"
    OR NEW."sha256" IS DISTINCT FROM doc."recoverySha256" OR NEW."fileSize" IS DISTINCT FROM doc."fileSize"
    OR NEW."recoveryUntil" IS DISTINCT FROM doc."recoveryUntil" THEN
    RAISE EXCEPTION 'Purge authorization must bind the exact retained revision and object';
  END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=NEW."policyId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR policy.state <> 'APPROVED' OR policy."recordClass" <> 'VAULT_DRAFT'
    OR policy."retentionMode"='PERMANENT'
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id) THEN
    RAISE EXCEPTION 'Purge authorization requires a current approved draft policy';
  END IF;
  -- A replacement policy may be selected, but may not shorten the saved recovery
  -- deadline. Execution also has to wait for its own current retention boundary.
  IF jsonb_typeof(NEW."dispositionPlan") IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(NEW."dispositionPlan")) <> 6 THEN
    RAISE EXCEPTION 'Purge plan must cover all six stores';
  END IF;
  FOREACH area IN ARRAY ARRAY['PRIMARY','VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS'] LOOP
    entry := NEW."dispositionPlan"->area;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Purge plan store is missing'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2
      OR jsonb_typeof(entry->'disposition') IS DISTINCT FROM 'string'
      OR entry->>'disposition' NOT IN ('DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE')
      OR jsonb_typeof(entry->'evidenceRef') IS DISTINCT FROM 'string'
      OR entry->>'evidenceRef' !~ '^[A-Z0-9][A-Z0-9-]{2,119}$' THEN
      RAISE EXCEPTION 'Each purge plan store requires a disposition and controlled evidence';
    END IF;
  END LOOP;
  IF NEW."dispositionPlan"->'PRIMARY'->>'disposition' <> 'DISPOSE' THEN
    RAISE EXCEPTION 'Primary purge requires an explicit disposal plan';
  END IF;
  NEW."authorizedAt" := timezone('UTC', statement_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeAuthorization_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "DocumentPurgeAuthorization" FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeAuthorization_guard_fn"();
COMMIT;
