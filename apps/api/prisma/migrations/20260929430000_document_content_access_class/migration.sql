-- A visibility decision alone cannot establish that the bytes and metadata
-- are suitable for every active Member. Existing releases remain unassessed
-- until a human reviews them; application reads fail closed in the meantime.
CREATE TYPE "DocumentContentAccessClass" AS ENUM (
  'UNASSESSED', 'MEMBER_SUITABLE', 'RESTRICTED_SENSITIVE'
);

ALTER TABLE "Document"
  ADD COLUMN "contentAccessClass" "DocumentContentAccessClass"
  NOT NULL DEFAULT 'UNASSESSED';

-- Legacy MEMBER_VISIBLE rows need individual content review. NOT VALID keeps
-- those rows for review but rejects new or updated unsafe combinations.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_member_visibility_requires_content_review"
  CHECK (
    "visibility" <> 'MEMBER_VISIBLE'::"DocumentVisibility"
    OR "contentAccessClass" = 'MEMBER_SUITABLE'::"DocumentContentAccessClass"
  ) NOT VALID;

ALTER TABLE "DocumentControlAudit"
  DROP CONSTRAINT "DocumentControlAudit_kind_valid";
ALTER TABLE "DocumentControlAudit"
  ADD CONSTRAINT "DocumentControlAudit_kind_valid"
  CHECK ("kind" IN (
    'LIFECYCLE', 'PUBLICATION', 'PUBLICATION_TARGET', 'BOARD_APPROVAL',
    'METADATA', 'UPLOAD', 'RECORD_DELETE', 'STANDARD_LINK', 'STANDARD_UNLINK',
    'REPLACEMENT', 'DELETION_HOLD', 'CONFLUENCE_REFERENCE', 'STORAGE_PROVIDER',
    'CONTENT_ACCESS'
  ));

-- A reviewed Member audience covers the visible card metadata as well as the
-- stored bytes. A later metadata change must withdraw that assessment and any
-- Member visibility in the same update, including for direct SQL writers.
CREATE FUNCTION "Document_content_access_metadata_guard_fn"()
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
    ) THEN
    RAISE EXCEPTION 'Member content assessment must be withdrawn before document metadata changes';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Document_content_access_metadata_guard"
BEFORE UPDATE ON "Document"
FOR EACH ROW EXECUTE FUNCTION "Document_content_access_metadata_guard_fn"();
