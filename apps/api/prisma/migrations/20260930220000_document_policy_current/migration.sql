BEGIN;
-- The existing lifecycle guards validate the selected policy. This additional
-- guard refuses ambiguity when another approval has not been withdrawn.
-- Policy writers take the same organisation lock since migration 2100.
CREATE FUNCTION "DocumentLifecycle_current_policy_fn"() RETURNS trigger AS $$
DECLARE selected_policy TEXT;
BEGIN
  IF TG_TABLE_NAME='Document' THEN
    IF OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NULL THEN RETURN NEW; END IF;
    selected_policy:=NEW."recoveryPolicyId";
  ELSIF TG_TABLE_NAME='DocumentPurgeAuthorization' THEN
    selected_policy:=NEW."policyId";
  ELSE
    SELECT "policyId" INTO selected_policy FROM "DocumentPurgeAuthorization"
      WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p
    WHERE p."organisationId"=NEW."organisationId" AND p."recordClass"='VAULT_DRAFT'
      AND p.state='APPROVED' AND p.id IS DISTINCT FROM selected_policy
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    IF TG_TABLE_NAME='Document' THEN
      RAISE EXCEPTION 'An approved current draft recovery policy is required';
    ELSIF TG_TABLE_NAME='DocumentPurgeAuthorization' THEN
      RAISE EXCEPTION 'Purge authorization requires a current approved draft policy';
    ELSE
      RAISE EXCEPTION 'Purge claim requires a current approved draft policy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Document_policy_current" BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "DocumentLifecycle_current_policy_fn"();
CREATE TRIGGER "DocumentPurgeAuthorization_policy_current" BEFORE INSERT ON "DocumentPurgeAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "DocumentLifecycle_current_policy_fn"();
CREATE TRIGGER "DocumentPurgeClaim_policy_current" BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentLifecycle_current_policy_fn"();
COMMIT;
