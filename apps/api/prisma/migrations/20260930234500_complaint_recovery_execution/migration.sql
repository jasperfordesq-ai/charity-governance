BEGIN;
-- Inactive until separately approved. No application activation/disable path.
-- A code rollback cannot remove enforcement; replacement needs reconciliation.
CREATE TABLE "ComplaintRecoveryEnforcement" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL UNIQUE REFERENCES "Organisation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "installationId" TEXT NOT NULL CHECK ("installationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "ComplaintRecoveryEnforcement_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Complaint recovery enforcement cannot be removed or changed'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecoveryEnforcement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecoveryEnforcement"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryEnforcement_guard_fn"();

CREATE TABLE "ComplaintRecoveryExecution" (
  id TEXT PRIMARY KEY,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "ComplaintRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "writerId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 10000),
  "entryDigest" TEXT NOT NULL CHECK ("entryDigest" ~ '^[a-f0-9]{64}$'),
  "envelopeDigest" TEXT NOT NULL CHECK ("envelopeDigest" ~ '^[a-f0-9]{64}$'),
  "controlRevision" TEXT NOT NULL CHECK (octet_length("controlRevision") BETWEEN 1 AND 1024),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "ComplaintRecoveryExecution_guard_fn"() RETURNS trigger AS $$
DECLARE preparation "ComplaintRecoveryPreparation"%ROWTYPE;
  binding "ComplaintRecoveryEnforcement"%ROWTYPE;
  complaint "ComplaintRecord"%ROWTYPE; payload JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Complaint recovery executions are append-only'; END IF;
  SELECT * INTO preparation FROM "ComplaintRecoveryPreparation" WHERE id=NEW."preparationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint recovery execution requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=preparation."organisationId" FOR UPDATE;
  SELECT * INTO binding FROM "ComplaintRecoveryEnforcement" WHERE "organisationId"=preparation."organisationId";
  IF NOT FOUND OR binding."installationId"<>preparation."installationId"
    OR binding."writerEpoch"<>preparation."writerEpoch" OR binding."writerId"<>NEW."writerId" THEN
    RAISE EXCEPTION 'Complaint recovery execution requires exact enforced writer';
  END IF;
  payload:=preparation.facts::jsonb;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=payload#>>'{complaint,id}'
    AND "organisationId"=preparation."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint.revision::text IS DISTINCT FROM payload#>>'{complaint,revision}'
    OR complaint."removalId" IS DISTINCT FROM payload#>>'{complaint,removalId}'
    OR (SELECT id FROM "ComplaintHoldEvent" WHERE "organisationId"=preparation."organisationId"
      AND "complaintId"=complaint.id ORDER BY revision DESC LIMIT 1) IS DISTINCT FROM payload#>>'{latestHold,id}'
    OR (SELECT id FROM "ComplaintResolutionEvidence" WHERE "organisationId"=preparation."organisationId"
      AND "complaintId"=complaint.id ORDER BY revision DESC LIMIT 1) IS DISTINCT FROM payload#>>'{resolution,id}' THEN
    RAISE EXCEPTION 'Complaint recovery execution preparation dependencies changed';
  END IF;
  -- The service authenticates remote publication. SQL enforces transaction and
  -- dependency binding; plausible receipt fields alone do not prove remote IO.
  NEW."transactionId":=txid_current();
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecoveryExecution_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecoveryExecution"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryExecution_guard_fn"();

CREATE FUNCTION "ComplaintPurgeClaim_recovery_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId")
    AND NOT EXISTS (SELECT 1 FROM "ComplaintRecoveryExecution" e JOIN "ComplaintRecoveryPreparation" p ON p.id=e."preparationId"
      JOIN "ComplaintRecoveryEnforcement" b ON b."organisationId"=p."organisationId"
      WHERE p."organisationId"=NEW."organisationId" AND p."authorizationId"=NEW."authorizationId"
      AND p."actorUserId"=NEW."actorUserId" AND p.facts::jsonb#>>'{complaint,id}'=NEW."complaintId"
      AND p."installationId"=b."installationId" AND p."writerEpoch"=b."writerEpoch" AND e."writerId"=b."writerId"
      AND e."transactionId"=txid_current()
      AND (SELECT revision::text FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId")
        IS NOT DISTINCT FROM p.facts::jsonb#>>'{complaint,revision}'
      AND (SELECT id FROM "ComplaintHoldEvent" WHERE "complaintId"=NEW."complaintId" AND "organisationId"=NEW."organisationId" ORDER BY revision DESC LIMIT 1)
        IS NOT DISTINCT FROM p.facts::jsonb#>>'{latestHold,id}'
      AND (SELECT id FROM "ComplaintResolutionEvidence" WHERE "complaintId"=NEW."complaintId" AND "organisationId"=NEW."organisationId" ORDER BY revision DESC LIMIT 1)
        IS NOT DISTINCT FROM p.facts::jsonb#>>'{resolution,id}') THEN
    RAISE EXCEPTION 'Complaint purge claim requires same-transaction recovery execution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeClaim_a_recovery" BEFORE INSERT ON "ComplaintPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeClaim_recovery_fn"();

CREATE FUNCTION "ComplaintRecoveryExecution_complete_fn"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ComplaintRecoveryOutcome" o JOIN "ComplaintPurgeClaim" c ON c.id=o."claimId"
    WHERE o."preparationId"=NEW."preparationId" AND o."transactionId"=NEW."transactionId"
      AND c."transactionId"=NEW."transactionId") THEN
    RAISE EXCEPTION 'Complaint recovery execution requires atomic claim and outcome';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ComplaintRecoveryExecution_complete" AFTER INSERT ON "ComplaintRecoveryExecution"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryExecution_complete_fn"();
COMMIT;
