BEGIN;
-- Primary disposal decisions also need independently published replay facts.
-- Claim inserts already require same-transaction recovery execution; freeze
-- only ordinary authorization and withdrawal writers until that path exists.
CREATE FUNCTION "DocumentDisposalDecision_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document disposal decision requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "ComplaintDisposalDecision_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Complaint disposal decision requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_DocumentPurgeAuthorization_recovery_gate"
  BEFORE INSERT ON "DocumentPurgeAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "DocumentDisposalDecision_recovery_gate_fn"();
CREATE TRIGGER "A_DocumentPurgeWithdrawal_recovery_gate"
  BEFORE INSERT ON "DocumentPurgeAuthorizationWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DocumentDisposalDecision_recovery_gate_fn"();
CREATE TRIGGER "A_ComplaintPurgeAuthorization_recovery_gate"
  BEFORE INSERT ON "ComplaintPurgeAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintDisposalDecision_recovery_gate_fn"();
CREATE TRIGGER "A_ComplaintPurgeWithdrawal_recovery_gate"
  BEFORE INSERT ON "ComplaintPurgeAuthorizationWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintDisposalDecision_recovery_gate_fn"();
COMMIT;
