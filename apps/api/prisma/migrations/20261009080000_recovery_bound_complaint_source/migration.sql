BEGIN;
-- Complaint creation and edits have no independently committed full-source
-- replay fact. Once a charity binds complaint recovery, freeze ordinary
-- inserts and updates until the approved source protocol is implemented.
-- Permanent purge uses DELETE and its separate same-transaction execution
-- gate; this trigger does not alter that path.
CREATE FUNCTION "ComplaintRecord_source_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE charity_id TEXT;
BEGIN
  charity_id := CASE WHEN TG_OP='INSERT' THEN NEW."organisationId" ELSE OLD."organisationId" END;
  PERFORM 1 FROM "Organisation" WHERE id=charity_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
    WHERE "organisationId"=charity_id) THEN
    RAISE EXCEPTION 'Complaint source change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_ComplaintRecord_source_recovery_gate"
  BEFORE INSERT OR UPDATE ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_source_recovery_gate_fn"();
COMMIT;
