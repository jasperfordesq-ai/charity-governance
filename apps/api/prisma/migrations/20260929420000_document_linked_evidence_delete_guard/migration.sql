-- Existing standard and Confluence citation rows cascade when a document is
-- removed. Require their separate reviewed removal first, including for a
-- privileged direct DELETE that bypasses the ordinary Vault API.
CREATE FUNCTION "Document_linked_evidence_delete_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentStandardLink" WHERE "documentId" = OLD."id")
     OR EXISTS (SELECT 1 FROM "ConfluenceReference"
                WHERE "documentId" = OLD."id" AND "organisationId" = OLD."organisationId") THEN
    RAISE EXCEPTION 'Linked document evidence requires separate review before record removal'
      USING ERRCODE = '23514', CONSTRAINT = 'Document_linked_evidence_delete_guard';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "Document_linked_evidence_delete_guard"
  BEFORE DELETE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_linked_evidence_delete_guard_fn"();
