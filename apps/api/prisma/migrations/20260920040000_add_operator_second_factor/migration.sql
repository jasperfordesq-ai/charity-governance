-- A second factor for platform operator accounts.
--
-- Until now a password alone could suspend every charity on the platform. The
-- owner console design recorded that as an accepted risk and named this as the
-- next piece of work; this is that work.
--
-- Three columns and a table:
--
--   totpSecret       the shared secret, sealed rather than stored in the clear.
--                    Verification needs the plaintext, so it cannot be hashed
--                    the way a password is.
--   totpEnrolledAt   null until a code has been verified once. An operator who
--                    scanned a QR code and never proved they could generate a
--                    code is NOT enrolled, or a mistyped setup would lock them
--                    out of the console permanently.
--   totpPendingAt    when the current unverified secret was issued, so an
--                    abandoned enrolment can be told from a live one.
--
-- Recovery codes live in their own table because each is single-use and has to
-- be individually markable as spent. Storing them as an array on the operator
-- would mean rewriting the whole set to spend one, which is exactly the kind of
-- read-modify-write that loses a concurrent spend.
--
-- Nothing here is required yet. Enrolment is opt-in per operator so the first
-- deployment of this cannot lock anybody out of their own console; requiring it
-- is a later decision with its own migration.
BEGIN;

ALTER TABLE "PlatformOperator"
    ADD COLUMN "totpSecret" JSONB,
    ADD COLUMN "totpEnrolledAt" TIMESTAMP(3),
    ADD COLUMN "totpPendingAt" TIMESTAMP(3);

-- An enrolled operator must have a secret to be enrolled with.
ALTER TABLE "PlatformOperator"
    ADD CONSTRAINT "PlatformOperator_totp_enrolled_has_secret_check"
    CHECK ("totpEnrolledAt" IS NULL OR "totpSecret" IS NOT NULL);

-- CreateTable
CREATE TABLE "PlatformOperatorRecoveryCode" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    -- SHA-256 of the code. Unlike the TOTP secret these are never needed in
    -- the clear: a code is checked by hashing what was typed.
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformOperatorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperatorRecoveryCode_operatorId_codeHash_key"
    ON "PlatformOperatorRecoveryCode"("operatorId", "codeHash");

-- CreateIndex
CREATE INDEX "PlatformOperatorRecoveryCode_operatorId_usedAt_idx"
    ON "PlatformOperatorRecoveryCode"("operatorId", "usedAt");

-- AddForeignKey
-- Cascade, unlike most of this schema: a recovery code has no meaning without
-- the operator it belongs to, and there is no audit value in keeping the hash
-- of a code for an account that no longer exists.
ALTER TABLE "PlatformOperatorRecoveryCode"
    ADD CONSTRAINT "PlatformOperatorRecoveryCode_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
