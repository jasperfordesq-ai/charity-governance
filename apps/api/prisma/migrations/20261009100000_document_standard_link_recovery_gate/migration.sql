BEGIN;
-- A Vault document cannot change charity after linked governance evidence
-- has been recorded. This also keeps link recovery checks bound to one org.
CREATE FUNCTION "Document_charity_immutable_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId" THEN
    RAISE EXCEPTION 'Document charity identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_Document_charity_immutable"
  BEFORE UPDATE OF "organisationId" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_charity_immutable_fn"();

-- Standard links can block document removal/purge. Until link changes have
-- independently replayable facts, freeze all direct writers after document
-- recovery binding. Link rows have no organisationId, so derive the charity
-- from the referenced document and check both sides of a retargeting UPDATE.
CREATE FUNCTION "DocumentStandardLink_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE old_charity TEXT; new_charity TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "organisationId" INTO old_charity FROM "Document" WHERE id=OLD."documentId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "organisationId" INTO new_charity FROM "Document" WHERE id=NEW."documentId";
  END IF;
  PERFORM 1 FROM "Organisation"
    WHERE id IN (old_charity, new_charity) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId" IN (old_charity, new_charity)) THEN
    RAISE EXCEPTION 'Document standard link change requires independent recovery authority';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_DocumentStandardLink_recovery_gate"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentStandardLink"
  FOR EACH ROW EXECUTE FUNCTION "DocumentStandardLink_recovery_gate_fn"();
COMMIT;
