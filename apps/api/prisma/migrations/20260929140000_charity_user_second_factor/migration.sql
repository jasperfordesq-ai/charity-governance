ALTER TYPE "SecurityAuditEventType" ADD VALUE 'SECOND_FACTOR_ENROLLED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'SECOND_FACTOR_REMOVED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'SECOND_FACTOR_RECOVERY_USED';

CREATE TABLE "UserSecondFactor" (
  "userId" TEXT NOT NULL,
  "secret" JSONB NOT NULL,
  "pendingAt" TIMESTAMP(3),
  "enrolledAt" TIMESTAMP(3),
  "lastUsedStep" INTEGER,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "failedWindowAt" TIMESTAMP(3),
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserSecondFactor_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "UserSecondFactor_attempt_check" CHECK (
    "failedAttempts" >= 0 AND "failedAttempts" <= 5
  ),
  CONSTRAINT "UserSecondFactor_state_check" CHECK (
    ("pendingAt" IS NOT NULL AND "enrolledAt" IS NULL AND "lastUsedStep" IS NULL)
    OR ("pendingAt" IS NULL AND "enrolledAt" IS NOT NULL)
  )
);

CREATE TABLE "UserSecondFactorRecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserSecondFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSecondFactorRecoveryCode_userId_codeHash_key"
  ON "UserSecondFactorRecoveryCode"("userId", "codeHash");
CREATE INDEX "UserSecondFactorRecoveryCode_userId_usedAt_idx"
  ON "UserSecondFactorRecoveryCode"("userId", "usedAt");

ALTER TABLE "UserSecondFactor" ADD CONSTRAINT "UserSecondFactor_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSecondFactorRecoveryCode" ADD CONSTRAINT "UserSecondFactorRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserSecondFactor"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
