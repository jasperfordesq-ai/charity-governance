-- A standard may only be newly linked to a CURRENT document. Existing links
-- remain when a document later becomes historical: they are part of the
-- governance evidence trail, not a claim that the file is still current.
CREATE FUNCTION "DocumentStandardLink_current_document_fn"() RETURNS trigger AS $$
DECLARE
    document_lifecycle "DocumentLifecycleStatus";
BEGIN
    -- The row lock serialises insertion with a concurrent lifecycle update.
    SELECT "lifecycleStatus" INTO document_lifecycle
    FROM "Document"
    WHERE "id" = NEW."documentId"
    FOR SHARE;

    IF FOUND AND document_lifecycle <> 'CURRENT' THEN
        RAISE EXCEPTION 'Document standard link requires current document'
            USING ERRCODE = '23514';
    END IF;

    -- An absent document is rejected by the existing foreign key.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStandardLink_current_document"
    BEFORE INSERT OR UPDATE ON "DocumentStandardLink"
    FOR EACH ROW EXECUTE FUNCTION "DocumentStandardLink_current_document_fn"();
