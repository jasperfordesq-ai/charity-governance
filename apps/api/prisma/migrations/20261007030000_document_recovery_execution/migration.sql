BEGIN;
-- Inactive until separately approved independent custody and worker fencing.
-- An enforcement row is terminal; a code rollback cannot silently remove it.
CREATE TABLE "DocumentRecoveryEnforcement" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL UNIQUE REFERENCES "Organisation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "installationId" TEXT NOT NULL CHECK ("installationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "DocumentRecoveryEnforcement_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document recovery enforcement cannot be changed'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentRecoveryEnforcement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentRecoveryEnforcement"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryEnforcement_guard_fn"();

CREATE TABLE "DocumentRecoveryExecution" (
  id TEXT PRIMARY KEY,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "DocumentRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 10000),
  "entryDigest" TEXT NOT NULL CHECK ("entryDigest" ~ '^[a-f0-9]{64}$'),
  "envelopeDigest" TEXT NOT NULL CHECK ("envelopeDigest" ~ '^[a-f0-9]{64}$'),
  "controlRevision" TEXT NOT NULL CHECK (octet_length("controlRevision") BETWEEN 1 AND 1024),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "DocumentRecoveryExecution_guard_fn"() RETURNS trigger AS $$
DECLARE preparation "DocumentRecoveryPreparation"%ROWTYPE;
  binding "DocumentRecoveryEnforcement"%ROWTYPE;
  auth "DocumentPurgeAuthorization"%ROWTYPE;
  doc "Document"%ROWTYPE;
  payload JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document recovery executions are append-only'; END IF;
  SELECT * INTO preparation FROM "DocumentRecoveryPreparation" WHERE id=NEW."preparationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Document recovery execution requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=preparation."organisationId" FOR UPDATE;
  SELECT * INTO binding FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=preparation."organisationId";
  IF NOT FOUND OR binding."installationId"<>preparation."installationId"
    OR binding."writerEpoch"<>preparation."writerEpoch" OR binding."writerId"<>NEW."writerId" THEN
    RAISE EXCEPTION 'Document recovery execution requires exact enforced writer';
  END IF;
  payload := preparation.facts::jsonb;
  SELECT * INTO auth FROM "DocumentPurgeAuthorization" WHERE id=preparation."authorizationId"
    AND "organisationId"=preparation."organisationId" FOR UPDATE;
  IF NOT FOUND OR auth."actorUserId"<>preparation."actorUserId"
    OR EXISTS (SELECT 1 FROM "DocumentPurgeAuthorizationWithdrawal" WHERE "authorizationId"=auth.id)
    OR EXISTS (SELECT 1 FROM "DocumentPurgeClaim" WHERE "authorizationId"=auth.id) THEN
    RAISE EXCEPTION 'Document recovery execution authorization changed';
  END IF;
  SELECT * INTO doc FROM "Document" WHERE id=payload#>>'{document,id}'
    AND "organisationId"=preparation."organisationId" FOR UPDATE;
  IF NOT FOUND OR doc."deletedAt" IS NULL OR doc."deletionHold" OR doc."lifecycleStatus"<>'DRAFT'
    OR doc."approvalAsserted" OR doc."approvedByResolutionId" IS NOT NULL
    OR doc."updatedAt" IS DISTINCT FROM ((payload#>>'{document,updatedAt}')::timestamptz AT TIME ZONE 'UTC')
    OR doc."fileUrl" IS DISTINCT FROM payload#>>'{document,fileUrl}'
    OR doc."storageProvider" IS DISTINCT FROM payload#>>'{document,storageProvider}'
    OR doc."recoverySha256" IS DISTINCT FROM payload#>>'{document,recoverySha256}'
    OR doc."fileSize" IS DISTINCT FROM (payload#>>'{document,fileSize}')::integer
    OR auth."documentId" IS DISTINCT FROM doc.id
    OR auth."policyId" IS DISTINCT FROM payload#>>'{policy,id}'
    OR EXISTS (SELECT 1 FROM "DocumentStandardLink" WHERE "documentId"=doc.id)
    OR EXISTS (SELECT 1 FROM "ConfluenceReference" WHERE "documentId"=doc.id)
    OR EXISTS (SELECT 1 FROM "Document" WHERE "supersededByDocumentId"=doc.id) THEN
    RAISE EXCEPTION 'Document recovery execution preparation dependencies changed';
  END IF;
  -- Remote publication is authenticated by the future operation service.
  -- SQL binds only the local dependency and transaction, not remote I/O.
  NEW."transactionId" := txid_current();
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentRecoveryExecution_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentRecoveryExecution"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryExecution_guard_fn"();

CREATE TABLE "DocumentRecoveryOutcome" (
  id TEXT PRIMARY KEY,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "DocumentRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "claimId" TEXT NOT NULL UNIQUE REFERENCES "DocumentPurgeClaim"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "DocumentRecoveryOutcome_guard_fn"() RETURNS trigger AS $$
DECLARE preparation "DocumentRecoveryPreparation"%ROWTYPE;
  claim "DocumentPurgeClaim"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document recovery outcomes are append-only'; END IF;
  SELECT * INTO preparation FROM "DocumentRecoveryPreparation" WHERE id=NEW."preparationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Document recovery outcome requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=preparation."organisationId" FOR UPDATE;
  SELECT * INTO claim FROM "DocumentPurgeClaim" WHERE id=NEW."claimId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=claim."deletionId";
  IF claim.id IS NULL OR claim."transactionId"<>txid_current()
    OR claim."organisationId"<>preparation."organisationId"
    OR claim."authorizationId"<>preparation."authorizationId"
    OR claim."actorUserId"<>preparation."actorUserId"
    OR claim."documentId" IS DISTINCT FROM preparation.facts::jsonb#>>'{document,id}'
    OR job.id IS NULL OR job."organisationId"<>claim."organisationId"
    OR job."sourceDocumentId"<>claim."documentId"
    OR job."storagePath" IS DISTINCT FROM preparation.facts::jsonb#>>'{authorization,storagePath}'
    OR job.provider IS DISTINCT FROM preparation.facts::jsonb#>>'{authorization,provider}'
    OR job.state<>'PENDING' OR job.attempts<>0 OR job."processedAt" IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM "DocumentRecoveryExecution" e
      WHERE e."preparationId"=preparation.id AND e."transactionId"=txid_current())
    OR EXISTS (SELECT 1 FROM "Document" WHERE id=claim."documentId" AND "organisationId"=claim."organisationId") THEN
    RAISE EXCEPTION 'Document recovery outcome requires same-transaction claim and queued job';
  END IF;
  NEW."transactionId" := txid_current();
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentRecoveryOutcome_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentRecoveryOutcome"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryOutcome_guard_fn"();

CREATE FUNCTION "DocumentPurgeClaim_recovery_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId")
    AND NOT EXISTS (SELECT 1 FROM "DocumentRecoveryExecution" e
      JOIN "DocumentRecoveryPreparation" p ON p.id=e."preparationId"
      JOIN "DocumentRecoveryEnforcement" b ON b."organisationId"=p."organisationId"
      WHERE p."organisationId"=NEW."organisationId" AND p."authorizationId"=NEW."authorizationId"
        AND p."actorUserId"=NEW."actorUserId" AND p.facts::jsonb#>>'{document,id}'=NEW."documentId"
        AND p."installationId"=b."installationId" AND p."writerEpoch"=b."writerEpoch"
        AND e."writerId"=b."writerId" AND e."transactionId"=txid_current()) THEN
    RAISE EXCEPTION 'Document purge claim requires same-transaction recovery execution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_a_recovery" BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_recovery_fn"();

CREATE FUNCTION "DocumentRecoveryExecution_complete_fn"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DocumentRecoveryOutcome" o
    JOIN "DocumentPurgeClaim" c ON c.id=o."claimId"
    JOIN "DocumentStorageDeletion" j ON j.id=c."deletionId"
    WHERE o."preparationId"=NEW."preparationId" AND o."transactionId"=NEW."transactionId"
      AND c."transactionId"=NEW."transactionId" AND j."organisationId"=c."organisationId") THEN
    RAISE EXCEPTION 'Document recovery execution requires atomic claim, job and outcome';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "DocumentRecoveryExecution_complete" AFTER INSERT ON "DocumentRecoveryExecution"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryExecution_complete_fn"();
COMMIT;
