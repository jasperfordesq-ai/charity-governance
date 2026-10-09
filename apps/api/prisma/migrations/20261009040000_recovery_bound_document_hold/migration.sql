BEGIN;
-- A direct SQL writer must not change a Vault deletion hold after document
-- recovery binding. The ordinary API is also gated, but the database is the
-- final boundary for all writers until independent hold replay is implemented.
CREATE FUNCTION "DocumentDeletionHold_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."deletionHold" IS DISTINCT FROM OLD."deletionHold" THEN
    PERFORM 1 FROM "Organisation" WHERE id=OLD."organisationId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=OLD."organisationId") THEN
      RAISE EXCEPTION 'Document deletion hold requires independent recovery authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentDeletionHold_recovery_gate"
  BEFORE UPDATE OF "deletionHold" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "DocumentDeletionHold_recovery_gate_fn"();
COMMIT;
