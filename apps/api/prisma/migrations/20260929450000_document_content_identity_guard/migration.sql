-- A Member-suitable assessment is for the reviewed bytes as well as the
-- visible card. Direct writers must withdraw Member access before changing
-- the recorded object identity, provider or file representation.
CREATE OR REPLACE FUNCTION "Document_content_access_metadata_guard_fn"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."contentAccessClass" = 'MEMBER_SUITABLE'::"DocumentContentAccessClass"
    AND NEW."contentAccessClass" = 'MEMBER_SUITABLE'::"DocumentContentAccessClass"
    AND (
      NEW."name" IS DISTINCT FROM OLD."name"
      OR NEW."description" IS DISTINCT FROM OLD."description"
      OR NEW."category" IS DISTINCT FROM OLD."category"
      OR NEW."owner" IS DISTINCT FROM OLD."owner"
      OR NEW."approvedDate" IS DISTINCT FROM OLD."approvedDate"
      OR NEW."nextReviewDate" IS DISTINCT FROM OLD."nextReviewDate"
      OR NEW."boardMinuteReference" IS DISTINCT FROM OLD."boardMinuteReference"
      OR NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl"
      OR NEW."storageProvider" IS DISTINCT FROM OLD."storageProvider"
      OR NEW."fileSize" IS DISTINCT FROM OLD."fileSize"
      OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
      OR NEW."version" IS DISTINCT FROM OLD."version"
    ) THEN
    RAISE EXCEPTION 'Member content assessment must be withdrawn before document contents or metadata change';
  END IF;
  RETURN NEW;
END;
$$;
