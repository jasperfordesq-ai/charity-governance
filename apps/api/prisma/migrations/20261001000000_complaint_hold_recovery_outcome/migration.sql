BEGIN;
-- Inactive internal path. Inserting an outcome applies the exact prepared hold
-- in this transaction. It does not prove independent custody or allow reopening.
CREATE TABLE "ComplaintHoldRecoveryOutcome" (
  id TEXT PRIMARY KEY,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "ComplaintHoldRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "holdEventId" TEXT NOT NULL UNIQUE REFERENCES "ComplaintHoldEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "ComplaintHoldRecoveryOutcome_guard_fn"() RETURNS trigger AS $$
DECLARE preparation "ComplaintHoldRecoveryPreparation"%ROWTYPE; payload JSONB;
  previous "ComplaintHoldEvent"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Hold recovery outcomes are append-only'; END IF;
  SELECT * INTO preparation FROM "ComplaintHoldRecoveryPreparation" WHERE id=NEW."preparationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Hold outcome requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=preparation."organisationId" FOR UPDATE;
  payload:=preparation.facts::jsonb;
  IF preparation."factsDigest"<>encode(sha256(convert_to(preparation.facts,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Hold outcome preparation digest mismatch';
  END IF;
  SELECT * INTO previous FROM "ComplaintHoldEvent" WHERE "organisationId"=preparation."organisationId"
    AND "complaintId"=preparation."complaintId" ORDER BY revision DESC LIMIT 1;
  IF previous.id IS NULL THEN
    IF payload->'previousHold' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Hold outcome previous decision changed';
    END IF;
  ELSIF ((payload->'previousHold')-'occurredAt') IS DISTINCT FROM (to_jsonb(previous)-'occurredAt')
    OR ((payload#>>'{previousHold,occurredAt}')::timestamptz AT TIME ZONE 'UTC') IS DISTINCT FROM previous."occurredAt" THEN
    RAISE EXCEPTION 'Hold outcome previous decision changed';
  END IF;
  -- The ordinary hold trigger rechecks current record revision, active same-
  -- charity Admin/Owner, exact next revision and alternating state under locks.
  NEW."holdEventId":=payload#>>'{decision,id}';
  INSERT INTO "ComplaintHoldEvent" (id,"organisationId","complaintId",revision,"recordRevision",
    held,"actorUserId","evidenceRef",reason)
  VALUES (NEW."holdEventId",preparation."organisationId",preparation."complaintId",
    (payload#>>'{decision,revision}')::integer,(payload#>>'{decision,recordRevision}')::integer,
    (payload#>>'{decision,held}')::boolean,preparation."actorUserId",
    payload#>>'{decision,evidenceRef}',payload#>>'{decision,reason}');
  NEW."transactionId":=txid_current();
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintHoldRecoveryOutcome_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintHoldRecoveryOutcome"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintHoldRecoveryOutcome_guard_fn"();
COMMIT;
