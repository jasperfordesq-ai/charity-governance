-- Ordinary Vault deletion still requires a live document with the exact
-- tenant/path at job insertion. An explicit Confluence erasure is requested
-- only after that document is gone, so its source identity must instead be
-- proven by the retired publication already stamped with this deletion ID.
-- Both the stamp and job insert occur in one application transaction.
CREATE OR REPLACE FUNCTION "guard_storage_deletion_source_document"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sourceDocumentId" IS NOT NULL THEN
      IF NEW."provider" = 'confluence' THEN
        IF NOT EXISTS (
          SELECT 1 FROM "DocumentPublication" publication
          WHERE publication."organisationId" = NEW."organisationId"
            AND publication."documentId" = NEW."sourceDocumentId"
            AND publication."provider" = 'confluence'
            AND publication."state" = 'RETIRED'
            AND publication."erasureDeletionId" = NEW."id"
            AND COALESCE(publication."retiredStoragePath", 'publication:' || publication."id") = NEW."storagePath"
        ) THEN
          RAISE EXCEPTION 'Confluence erasure source document must match the linked retired publication';
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM "Document" document
        WHERE document."id" = NEW."sourceDocumentId"
          AND document."organisationId" = NEW."organisationId"
          AND document."fileUrl" = NEW."storagePath"
      ) THEN
        RAISE EXCEPTION 'Storage deletion source document must match a live tenant document and path';
      END IF;
    END IF;
  ELSIF NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId" THEN
    RAISE EXCEPTION 'Storage deletion source document identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
