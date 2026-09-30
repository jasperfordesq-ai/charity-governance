-- Preserve the provider that actually received each Vault file. Do not infer
-- legacy custody from a charity's current storage preference: it can change.
ALTER TABLE "Document" ADD COLUMN "storageProvider" TEXT;

-- Only backfill from an attached upload reservation for this exact charity,
-- document and path. Ambiguous or older records remain unverified (NULL).
UPDATE "Document" AS document
SET "storageProvider" = matched."provider"
FROM (
  SELECT intent."organisationId", intent."documentId", intent."storagePath",
         MIN(intent."provider") AS "provider"
  FROM "DocumentUploadIntent" AS intent
  WHERE intent."state" = 'ATTACHED'
    AND intent."documentId" IS NOT NULL
  GROUP BY intent."organisationId", intent."documentId", intent."storagePath"
  HAVING COUNT(DISTINCT intent."provider") = 1
) AS matched
WHERE document."organisationId" = matched."organisationId"
  AND document."id" = matched."documentId"
  AND document."fileUrl" = matched."storagePath";

CREATE FUNCTION "guard_document_written_storage_provider"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."storageProvider" IS NOT NULL
     AND NEW."storageProvider" IS DISTINCT FROM OLD."storageProvider" THEN
    RAISE EXCEPTION 'Document written storage provider is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Document_written_storage_provider_guard"
  BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "guard_document_written_storage_provider"();

-- The existing attachment guard proves the exact charity/document/path.
-- Extend it to refuse a contradictory provider for a newly pinned document.
-- An older document with unknown custody can still retain its historical
-- intent; the value is not silently inferred from a later attachment.
CREATE FUNCTION "guard_document_upload_provider_match"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" = 'ATTACHED' AND EXISTS (
    SELECT 1 FROM "Document" document
    WHERE document."id" = NEW."documentId"
      AND document."organisationId" = NEW."organisationId"
      AND document."fileUrl" = NEW."storagePath"
      AND document."storageProvider" IS NOT NULL
      AND document."storageProvider" <> NEW."provider"
  ) THEN
    RAISE EXCEPTION 'Document upload intent provider must match the written document provider';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentUploadIntent_provider_match"
  BEFORE UPDATE ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "guard_document_upload_provider_match"();
