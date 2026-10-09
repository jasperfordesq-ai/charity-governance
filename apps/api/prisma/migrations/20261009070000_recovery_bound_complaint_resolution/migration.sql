BEGIN;
-- Resolution and withdrawal evidence can change an anchor-based complaint
-- retention decision. Until each decision has independently published replay
-- facts, the ordinary database writer must stop after recovery binding.
-- The charity lock serializes this check with binding activation.
CREATE FUNCTION "ComplaintResolutionEvidence_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Complaint resolution requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_ComplaintResolutionEvidence_recovery_gate"
  BEFORE INSERT ON "ComplaintResolutionEvidence"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintResolutionEvidence_recovery_gate_fn"();
COMMIT;
