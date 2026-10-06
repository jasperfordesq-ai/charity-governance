BEGIN;
-- Complaint policy decisions are not yet published to independent recovery
-- authority. Keep them frozen after binding until that operation exists.
-- The existing _00_copy_lock also locks Organisation; repeat the lock here
-- so this gate's ordering does not depend on trigger name or future changes.
CREATE FUNCTION "ComplaintPolicyRevision_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."recordClass"='COMPLAINT' THEN
    PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
        WHERE "organisationId"=NEW."organisationId") THEN
      RAISE EXCEPTION 'Complaint policy revision requires independent recovery authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyRevision_01_recovery_gate"
  BEFORE INSERT ON "DataRetentionPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPolicyRevision_recovery_gate_fn"();

CREATE FUNCTION "ComplaintPolicyWithdrawal_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE policy_class TEXT;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT "recordClass" INTO policy_class FROM "DataRetentionPolicyRevision"
    WHERE id=NEW."policyId" AND "organisationId"=NEW."organisationId";
  IF policy_class='COMPLAINT' AND EXISTS (
    SELECT 1 FROM "ComplaintRecoveryEnforcement"
      WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Complaint policy withdrawal requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyWithdrawal_01_recovery_gate"
  BEFORE INSERT ON "DataRetentionPolicyWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPolicyWithdrawal_recovery_gate_fn"();
COMMIT;
