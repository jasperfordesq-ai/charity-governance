-- CreateEnum
CREATE TYPE "OperatorLifecycleStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "lifecycleStatus" "OperatorLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformOperatorSession" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformOperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_email_key" ON "PlatformOperator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_resetToken_key" ON "PlatformOperator"("resetToken");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperatorSession_tokenHash_key" ON "PlatformOperatorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PlatformOperatorSession_operatorId_revokedAt_expiresAt_idx" ON "PlatformOperatorSession"("operatorId", "revokedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "PlatformOperatorSession" ADD CONSTRAINT "PlatformOperatorSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
