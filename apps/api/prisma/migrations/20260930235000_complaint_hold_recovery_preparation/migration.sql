BEGIN;
-- Candidate preservation decision only. No hold change or execution permission.
CREATE TABLE "ComplaintHoldRecoveryPreparation" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "complaintId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  facts TEXT NOT NULL CHECK (octet_length(facts) BETWEEN 1 AND 8192),
  "factsDigest" TEXT NOT NULL CHECK ("factsDigest" ~ '^[a-f0-9]{64}$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organisationId","operationId")
);
CREATE FUNCTION "ComplaintHoldRecoveryPreparation_guard_fn"() RETURNS trigger AS $$
DECLARE payload JSONB; complaint "ComplaintRecord"%ROWTYPE; previous "ComplaintHoldEvent"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Hold recovery preparations are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role IN ('OWNER','ADMIN') AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hold preparation requires active charity administrator'; END IF;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hold preparation requires same-charity complaint'; END IF;
  SELECT * INTO previous FROM "ComplaintHoldEvent" WHERE "complaintId"=NEW."complaintId" AND "organisationId"=NEW."organisationId"
    ORDER BY revision DESC LIMIT 1;
  payload:=NEW.facts::jsonb;
  IF payload->>'format' IS DISTINCT FROM '1' OR payload->>'action' IS DISTINCT FROM 'COMPLAINT_HOLD_PREPARATION'
    OR payload->>'organisationId' IS DISTINCT FROM NEW."organisationId"
    OR payload->>'installationId' IS DISTINCT FROM NEW."installationId"
    OR payload->>'operationId' IS DISTINCT FROM NEW."operationId"
    OR payload->>'actorUserId' IS DISTINCT FROM NEW."actorUserId"
    OR payload->>'writerEpoch' IS DISTINCT FROM NEW."writerEpoch"::text
    OR payload#>>'{complaint,id}' IS DISTINCT FROM complaint.id
    OR payload#>>'{complaint,organisationId}' IS DISTINCT FROM complaint."organisationId"
    OR payload#>>'{complaint,revision}' IS DISTINCT FROM complaint.revision::text
    OR payload#>>'{decision,actorUserId}' IS DISTINCT FROM NEW."actorUserId"
    OR payload#>>'{decision,recordRevision}' IS DISTINCT FROM complaint.revision::text
    OR payload#>>'{decision,revision}' IS DISTINCT FROM (COALESCE(previous.revision,0)+1)::text
    OR payload#>>'{decision,held}' IS DISTINCT FROM (NOT COALESCE(previous.held,false))::text
    OR NEW."factsDigest"<>encode(sha256(convert_to(NEW.facts,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Hold recovery preparation identity or dependency mismatch';
  END IF;
  IF previous.id IS NULL THEN
    IF payload->'previousHold' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Hold recovery preparation previous decision mismatch';
    END IF;
  ELSIF ((payload->'previousHold')-'occurredAt') IS DISTINCT FROM (to_jsonb(previous)-'occurredAt')
    OR ((payload#>>'{previousHold,occurredAt}')::timestamptz AT TIME ZONE 'UTC') IS DISTINCT FROM previous."occurredAt" THEN
    RAISE EXCEPTION 'Hold recovery preparation previous decision mismatch';
  END IF;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintHoldRecoveryPreparation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintHoldRecoveryPreparation"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintHoldRecoveryPreparation_guard_fn"();
COMMIT;
