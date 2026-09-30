-- Preserve the removed Vault row's identity in the technical deletion job.
-- Legacy and orphan cleanup jobs remain NULL rather than being guessed from
-- matching storage paths after the source record has gone.
ALTER TABLE "DocumentStorageDeletion"
  ADD COLUMN "sourceDocumentId" TEXT;

CREATE FUNCTION "guard_storage_deletion_source_document"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sourceDocumentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Document" document
      WHERE document."id" = NEW."sourceDocumentId"
        AND document."organisationId" = NEW."organisationId"
        AND document."fileUrl" = NEW."storagePath"
    ) THEN
      RAISE EXCEPTION 'Storage deletion source document must match a live tenant document and path';
    END IF;
  ELSIF NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId" THEN
    RAISE EXCEPTION 'Storage deletion source document identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentStorageDeletion_source_document_guard"
  BEFORE INSERT OR UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "guard_storage_deletion_source_document"();
