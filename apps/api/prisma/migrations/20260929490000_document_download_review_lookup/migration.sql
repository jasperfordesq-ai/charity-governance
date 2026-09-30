-- Build the review-receipt lookup without blocking writes to the existing
-- append-only download ledger. This must be a separate migration because
-- PostgreSQL cannot create the index concurrently inside the preceding
-- column/constraint migration's transaction.
CREATE INDEX CONCURRENTLY "DocumentDownloadPreparationAudit_review_receipt_idx"
  ON "DocumentDownloadPreparationAudit"("organisationId", "documentId", "actorUserId", "documentUpdatedAt", "reviewSha256");
