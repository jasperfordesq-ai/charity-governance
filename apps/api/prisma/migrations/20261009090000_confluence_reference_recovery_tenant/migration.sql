BEGIN;
-- A cited page is a deletion blocker for its Vault document. Its charity
-- identity must be the document's charity, including for direct SQL writers.
-- Refuse a legacy mismatch for operator review; never silently reassign it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ConfluenceReference" r
    LEFT JOIN "Document" d ON d.id=r."documentId" AND d."organisationId"=r."organisationId"
    WHERE d.id IS NULL) THEN
    RAISE EXCEPTION 'Confluence reference charity/document mismatch requires review';
  END IF;
END $$;

ALTER TABLE "ConfluenceReference" DROP CONSTRAINT "ConfluenceReference_documentId_fkey";
ALTER TABLE "ConfluenceReference" ADD CONSTRAINT "ConfluenceReference_documentId_organisationId_fkey"
  FOREIGN KEY ("documentId", "organisationId") REFERENCES "Document"(id, "organisationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Citation add/remove/edit currently has no independently replayable fact.
-- Serialize with enforcement activation and freeze every writer once bound.
CREATE FUNCTION "ConfluenceReference_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=NEW."organisationId") THEN
      RAISE EXCEPTION 'Confluence reference change requires independent recovery authority';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM "Organisation" WHERE id=OLD."organisationId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=OLD."organisationId") THEN
      RAISE EXCEPTION 'Confluence reference change requires independent recovery authority';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM "Organisation"
    WHERE id IN (OLD."organisationId", NEW."organisationId") ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId" IN (OLD."organisationId", NEW."organisationId")) THEN
    RAISE EXCEPTION 'Confluence reference change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_ConfluenceReference_recovery_gate"
  BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceReference"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceReference_recovery_gate_fn"();
COMMIT;
