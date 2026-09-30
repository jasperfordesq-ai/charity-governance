BEGIN;
-- This relational gate rejects ordinary/direct hold writes after recovery
-- enforcement is bound. It does not authenticate independent publication:
-- the ordinary runtime must also lose INSERT on recovery outcomes, with a
-- separately authenticated executor and provider proof before activation.
CREATE FUNCTION "ComplaintHoldEvent_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
      WHERE "organisationId"=NEW."organisationId")
    AND NOT EXISTS (
      SELECT 1 FROM "ComplaintHoldRecoveryOutcome" o
      JOIN "ComplaintHoldRecoveryPreparation" p ON p.id=o."preparationId"
      JOIN "ComplaintRecoveryEnforcement" b ON b."organisationId"=p."organisationId"
      WHERE o."holdEventId"=NEW.id AND o."transactionId"=txid_current()
        AND p."organisationId"=NEW."organisationId"
        AND p."complaintId"=NEW."complaintId"
        AND p."actorUserId"=NEW."actorUserId"
        AND p."installationId"=b."installationId"
        AND p."writerEpoch"=b."writerEpoch"
        AND p."factsDigest"=encode(sha256(convert_to(p.facts,'UTF8')),'hex')
        AND p.facts::jsonb#>>'{decision,id}'=NEW.id
        AND (p.facts::jsonb#>>'{decision,revision}')::integer=NEW.revision
        AND (p.facts::jsonb#>>'{decision,recordRevision}')::integer=NEW."recordRevision"
        AND (p.facts::jsonb#>>'{decision,held}')::boolean=NEW.held
        AND p.facts::jsonb#>>'{decision,evidenceRef}'=NEW."evidenceRef"
        AND p.facts::jsonb#>>'{decision,reason}'=NEW.reason
    ) THEN
    RAISE EXCEPTION 'Complaint hold requires same-transaction recovery outcome';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The outcome's BEFORE INSERT trigger creates the hold event before its own
-- row exists. A deferred check sees both rows at commit and rolls both back
-- if the exact relationship is missing or changed.
CREATE CONSTRAINT TRIGGER "ComplaintHoldEvent_recovery_gate"
  AFTER INSERT ON "ComplaintHoldEvent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "ComplaintHoldEvent_recovery_gate_fn"();
COMMIT;
