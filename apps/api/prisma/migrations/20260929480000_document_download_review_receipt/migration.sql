-- A suitability review must follow an authenticated preparation of the same
-- stored bytes for the same actor and document revision. Older audit rows
-- remain valid as access evidence but cannot serve as review receipts.
ALTER TABLE "DocumentDownloadPreparationAudit"
  ADD COLUMN "reviewSha256" TEXT,
  ADD COLUMN "documentUpdatedAt" TIMESTAMP(3);

ALTER TABLE "DocumentDownloadPreparationAudit"
  ADD CONSTRAINT "DocumentDownloadPreparationAudit_review_receipt_pair"
  CHECK (
    ("reviewSha256" IS NULL AND "documentUpdatedAt" IS NULL)
    OR ("reviewSha256" IS NOT NULL
      AND "reviewSha256" ~ '^[0-9a-f]{64}$'
      AND "documentUpdatedAt" IS NOT NULL)
  ) NOT VALID;
