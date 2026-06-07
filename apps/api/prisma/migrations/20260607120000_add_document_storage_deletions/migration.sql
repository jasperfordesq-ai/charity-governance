-- CreateTable
CREATE TABLE "DocumentStorageDeletion" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentStorageDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_organisationId_idx" ON "DocumentStorageDeletion"("organisationId");

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_processedAt_createdAt_idx" ON "DocumentStorageDeletion"("processedAt", "createdAt");
