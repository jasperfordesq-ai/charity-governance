BEGIN;
-- The complaint-only recovery policy gate predates document enforcement
-- and the two separately reviewed copy classes. Until all policy changes
-- have independently published replay facts, freeze every class whose
-- primary record family has been bound to recovery enforcement.
CREATE OR REPLACE FUNCTION "ComplaintPolicyRevision_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."recordClass" IN ('COMPLAINT', 'COMPLAINT_COPY', 'VAULT_DRAFT', 'DOCUMENT_COPY') THEN
    PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
    IF (NEW."recordClass" IN ('COMPLAINT', 'COMPLAINT_COPY') AND EXISTS (
      SELECT 1 FROM "ComplaintRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId"))
      OR (NEW."recordClass" IN ('VAULT_DRAFT', 'DOCUMENT_COPY') AND EXISTS (
      SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId")) THEN
      RAISE EXCEPTION 'Policy revision requires independent recovery authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "ComplaintPolicyWithdrawal_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE policy_class TEXT;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT "recordClass" INTO policy_class FROM "DataRetentionPolicyRevision"
    WHERE id=NEW."policyId" AND "organisationId"=NEW."organisationId";
  IF (policy_class IN ('COMPLAINT', 'COMPLAINT_COPY') AND EXISTS (
    SELECT 1 FROM "ComplaintRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId"))
    OR (policy_class IN ('VAULT_DRAFT', 'DOCUMENT_COPY') AND EXISTS (
    SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId")) THEN
    RAISE EXCEPTION 'Policy withdrawal requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
