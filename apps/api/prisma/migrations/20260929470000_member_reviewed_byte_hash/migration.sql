-- A past suitability decision without a bound byte fingerprint is not proof
-- that the current provider object contains the same reviewed content.
ALTER TABLE "Document" ADD COLUMN "memberReviewedSha256" TEXT;

-- Keep legacy rows for individual re-review. New or updated Member releases
-- must carry a valid digest; application reads also hide legacy nulls.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_member_visibility_requires_reviewed_bytes"
  CHECK (
    "visibility" <> 'MEMBER_VISIBLE'::"DocumentVisibility"
    OR ("memberReviewedSha256" IS NOT NULL
      AND "memberReviewedSha256" ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_reviewed_bytes_only_for_suitable_content"
  CHECK (
    "memberReviewedSha256" IS NULL
    OR "contentAccessClass" = 'MEMBER_SUITABLE'::"DocumentContentAccessClass"
  ) NOT VALID;
