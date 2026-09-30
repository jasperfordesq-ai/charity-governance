-- A queued deletion's provider, target and request provenance are fixed at
-- insertion. Retry and audited dead-letter recovery may update their own
-- state fields, and corrected-path recovery retains its existing guard.
-- This trigger does not scan or rewrite historical rows during deployment.
CREATE FUNCTION "guard_storage_deletion_target_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."targetRef" IS DISTINCT FROM OLD."targetRef"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById" THEN
    RAISE EXCEPTION 'Storage deletion target and request identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentStorageDeletion_target_identity_guard"
  BEFORE UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "guard_storage_deletion_target_identity"();
