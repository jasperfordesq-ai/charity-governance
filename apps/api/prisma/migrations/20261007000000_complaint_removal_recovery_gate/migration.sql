BEGIN;
-- Removal and restoration are not yet represented by a published recovery
-- operation. Once enforcement is bound, neither the ordinary service nor
-- direct SQL may change recoverability until an exact operation is designed.
-- Lock the same Organisation row as enforcement activation to order races.
CREATE FUNCTION "ComplaintRemoval_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
      WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Complaint removal requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRemoval_recovery_gate" BEFORE INSERT ON "ComplaintRemoval"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRemoval_recovery_gate_fn"();

CREATE FUNCTION "ComplaintRecord_restore_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF OLD."removedAt" IS DISTINCT FROM NEW."removedAt"
    OR OLD."removalId" IS DISTINCT FROM NEW."removalId" THEN
    PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "ComplaintRecoveryEnforcement"
        WHERE "organisationId"=NEW."organisationId") THEN
      RAISE EXCEPTION 'Complaint removal or restoration requires independent recovery authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecord_restore_recovery_gate" BEFORE UPDATE OF "removedAt", "removalId" ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_restore_recovery_gate_fn"();
COMMIT;
