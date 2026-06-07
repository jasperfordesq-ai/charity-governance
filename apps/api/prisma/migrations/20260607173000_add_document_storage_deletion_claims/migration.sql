-- AlterTable
ALTER TABLE "DocumentStorageDeletion" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_processedAt_claimedAt_createdAt_idx" ON "DocumentStorageDeletion"("processedAt", "claimedAt", "createdAt");
