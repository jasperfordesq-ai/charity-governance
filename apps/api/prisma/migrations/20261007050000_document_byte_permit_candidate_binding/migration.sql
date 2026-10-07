BEGIN;
-- An owner-only, immutable local candidate binding. Remote publication must
-- be authenticated by a future caller; this is deliberately not a worker
-- permit. DocumentRecoveryByteFence still rejects
-- every guarded deletion-job update after this migration.
CREATE TABLE "DocumentBytePermitCandidateBinding" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "DocumentRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "outcomeId" TEXT NOT NULL UNIQUE REFERENCES "DocumentRecoveryOutcome"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "claimId" TEXT NOT NULL UNIQUE REFERENCES "DocumentPurgeClaim"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "deletionId" TEXT NOT NULL UNIQUE,
  "installationId" TEXT NOT NULL CHECK ("installationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "operationId" TEXT NOT NULL CHECK ("operationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  "permitEntryDigest" TEXT NOT NULL CHECK ("permitEntryDigest" ~ '^[a-f0-9]{64}$'),
  "permitEnvelopeDigest" TEXT NOT NULL CHECK ("permitEnvelopeDigest" ~ '^[a-f0-9]{64}$'),
  "outcomeEntryDigest" TEXT NOT NULL CHECK ("outcomeEntryDigest" ~ '^[a-f0-9]{64}$'),
  "controlRevision" TEXT NOT NULL CHECK (octet_length("controlRevision") BETWEEN 1 AND 1024),
  "currentAuthorityDigest" TEXT NOT NULL CHECK ("currentAuthorityDigest" ~ '^[a-f0-9]{64}$'),
  provider TEXT NOT NULL CHECK (octet_length(provider) BETWEEN 1 AND 120),
  "storagePath" TEXT NOT NULL CHECK (octet_length("storagePath") BETWEEN 1 AND 2048),
  "objectSha256" TEXT NOT NULL CHECK ("objectSha256" ~ '^[a-f0-9]{64}$'),
  "fileSize" INTEGER NOT NULL CHECK ("fileSize">=0),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentBytePermitCandidateBinding_deletion_fkey"
    FOREIGN KEY ("deletionId","organisationId") REFERENCES "DocumentStorageDeletion"(id,"organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DocumentBytePermitCandidateBinding_org_operation_key" UNIQUE ("organisationId","operationId"),
  CONSTRAINT "DocumentBytePermitCandidateBinding_deletion_org_key" UNIQUE ("deletionId","organisationId")
);
CREATE INDEX "DocumentBytePermitCandidateBinding_org_recorded_idx"
  ON "DocumentBytePermitCandidateBinding"("organisationId","recordedAt",id);

CREATE FUNCTION "DocumentBytePermitCandidateBinding_guard_fn"() RETURNS trigger AS $$
DECLARE prep "DocumentRecoveryPreparation"%ROWTYPE;
  binding "DocumentRecoveryEnforcement"%ROWTYPE;
  execution "DocumentRecoveryExecution"%ROWTYPE;
  outcome "DocumentRecoveryOutcome"%ROWTYPE;
  claim "DocumentPurgeClaim"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
  auth "DocumentPurgeAuthorization"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document byte candidate bindings are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte candidate organisation is unavailable'; END IF;
  SELECT * INTO prep FROM "DocumentRecoveryPreparation" WHERE id=NEW."preparationId";
  SELECT * INTO binding FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId";
  SELECT * INTO execution FROM "DocumentRecoveryExecution" WHERE "preparationId"=NEW."preparationId";
  SELECT * INTO outcome FROM "DocumentRecoveryOutcome" WHERE id=NEW."outcomeId";
  SELECT * INTO claim FROM "DocumentPurgeClaim" WHERE id=NEW."claimId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=NEW."deletionId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  SELECT * INTO auth FROM "DocumentPurgeAuthorization" WHERE id=prep."authorizationId"
    AND "organisationId"=NEW."organisationId";
  IF prep.id IS NULL OR binding.id IS NULL OR execution.id IS NULL
    OR outcome.id IS NULL OR claim.id IS NULL OR job.id IS NULL OR auth.id IS NULL
    OR prep."organisationId"<>NEW."organisationId"
    OR prep."installationId"<>NEW."installationId"
    OR prep."operationId"<>NEW."operationId"
    OR prep."writerEpoch"<>NEW."writerEpoch"
    OR binding."installationId"<>NEW."installationId"
    OR binding."writerId"<>NEW."writerId"
    OR binding."writerEpoch"<>NEW."writerEpoch"
    OR execution."writerId"<>NEW."writerId"
    OR outcome."preparationId"<>prep.id OR outcome."claimId"<>claim.id
    OR claim."organisationId"<>NEW."organisationId"
    OR claim."authorizationId"<>prep."authorizationId"
    OR claim."actorUserId"<>prep."actorUserId"
    OR claim."deletionId"<>job.id
    OR claim."documentId" IS DISTINCT FROM prep.facts::jsonb#>>'{document,id}'
    OR job."sourceDocumentId" IS DISTINCT FROM claim."documentId"
    OR job.state<>'PENDING' OR job.attempts<>0 OR job."claimedAt" IS NOT NULL
    OR job."processedAt" IS NOT NULL OR job."deadLetteredAt" IS NOT NULL
    OR job.provider<>NEW.provider OR job."storagePath"<>NEW."storagePath"
    OR auth."documentId"<>claim."documentId"
    OR auth.provider<>NEW.provider OR auth."storagePath"<>NEW."storagePath"
    OR auth.sha256<>NEW."objectSha256" OR auth."fileSize"<>NEW."fileSize"
    OR NEW.provider IS DISTINCT FROM prep.facts::jsonb#>>'{authorization,provider}'
    OR NEW."storagePath" IS DISTINCT FROM prep.facts::jsonb#>>'{authorization,storagePath}'
    OR NEW."objectSha256" IS DISTINCT FROM prep.facts::jsonb#>>'{authorization,sha256}'
    OR NEW."fileSize" IS DISTINCT FROM (prep.facts::jsonb#>>'{authorization,fileSize}')::integer
    OR EXISTS (SELECT 1 FROM "DocumentPurgeAuthorizationWithdrawal"
      WHERE "authorizationId"=auth.id)
    OR EXISTS (SELECT 1 FROM "Document" WHERE id=claim."documentId"
      AND "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document byte candidate requires exact enforced pending claim and target';
  END IF;
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentBytePermitCandidateBinding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentBytePermitCandidateBinding"
  FOR EACH ROW EXECUTE FUNCTION "DocumentBytePermitCandidateBinding_guard_fn"();
COMMIT;
