BEGIN;
-- Copy authority, preservation, and observation writes cannot be replayed
-- independently yet. Freeze each family after its recovery binding is sealed.
-- The organisation row lock serializes this check with binding insertion.
CREATE FUNCTION "DocumentCopy_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document copy change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "ComplaintCopy_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Complaint copy change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_DocumentCopyAuthority_recovery_gate"
  BEFORE INSERT ON "DocumentCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopy_recovery_gate_fn"();
CREATE TRIGGER "A_DocumentCopyHold_recovery_gate"
  BEFORE INSERT ON "DocumentCopyHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopy_recovery_gate_fn"();
CREATE TRIGGER "A_DocumentCopyObservation_recovery_gate"
  BEFORE INSERT ON "DocumentPurgeDispositionEvent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopy_recovery_gate_fn"();

CREATE TRIGGER "A_ComplaintCopyAuthority_recovery_gate"
  BEFORE INSERT ON "ComplaintCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopy_recovery_gate_fn"();
CREATE TRIGGER "A_ComplaintCopyHold_recovery_gate"
  BEFORE INSERT ON "ComplaintCopyHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopy_recovery_gate_fn"();
CREATE TRIGGER "A_ComplaintCopyObservation_recovery_gate"
  BEFORE INSERT ON "ComplaintPurgeDispositionEvent"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopy_recovery_gate_fn"();
COMMIT;
