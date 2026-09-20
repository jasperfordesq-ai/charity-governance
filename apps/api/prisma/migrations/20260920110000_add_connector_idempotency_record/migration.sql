-- One connector POST, remembered long enough to answer a retry with the same
-- answer instead of creating a second record.
--
-- The case this exists for is a dropped connection. The API created the
-- governing act, the response never arrived, and the agent has no way to tell
-- that from a request that never ran. Retrying is the only reasonable thing it
-- can do, and without this table retrying makes two acts where a board held
-- one meeting.
--
-- POST only. An update already carries expectedUpdatedAt and a removal already
-- needs a human approval, so both are safe to repeat; a create is the one that
-- duplicates. Restricting it also keeps this table small and its purpose
-- legible, rather than becoming a general response cache.
--
-- The digest binds the key to the request that claimed it. A key reused for a
-- different create is refused rather than answered with the first create's
-- response, because an agent that reuses a key by accident has made a mistake
-- worth being told about, and an agent persuaded into reusing one deliberately
-- must not be able to pass off one record as another.
BEGIN;

-- CreateTable
CREATE TABLE "ConnectorIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- The key as the client sent it. Scoped per user rather than per session:
    -- a session rotates every fifteen minutes, and a retry that crossed a
    -- rotation would otherwise be a first attempt again.
    "key" TEXT NOT NULL,
    -- SHA-256 over method, matched route and a canonical form of the body.
    "requestDigest" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "routePattern" TEXT NOT NULL,
    -- Null until the first attempt has answered. A second request arriving
    -- while it is still null is told the first is in flight, rather than being
    -- allowed to run beside it and create the duplicate this table prevents.
    "completedAt" TIMESTAMP(3),
    "statusCode" INTEGER,
    -- The response as it was sent. Null when it was too large to keep; the
    -- replay then says so rather than inventing a different answer.
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The claim itself. Two requests racing with one key both try to insert here,
-- and exactly one wins; the loser reads the winner's row and is either
-- replayed or told to wait. This unique index is the whole mechanism.
CREATE UNIQUE INDEX "ConnectorIdempotencyRecord_userId_key_key"
    ON "ConnectorIdempotencyRecord"("userId", "key");

-- CreateIndex
CREATE INDEX "ConnectorIdempotencyRecord_expiresAt_idx"
    ON "ConnectorIdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "ConnectorIdempotencyRecord_organisationId_createdAt_idx"
    ON "ConnectorIdempotencyRecord"("organisationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConnectorIdempotencyRecord"
    ADD CONSTRAINT "ConnectorIdempotencyRecord_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConnectorIdempotencyRecord"
    ADD CONSTRAINT "ConnectorIdempotencyRecord_userId_organisationId_fkey"
    FOREIGN KEY ("userId", "organisationId") REFERENCES "User"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A finished row says what it answered. Enforced here rather than only in
-- code, because a row that claims to be finished with no status to replay
-- would answer a retry with nothing at all, which is worse than the duplicate
-- this table exists to prevent.
ALTER TABLE "ConnectorIdempotencyRecord"
    ADD CONSTRAINT "ConnectorIdempotencyRecord_completed_has_status_check"
    CHECK ("completedAt" IS NULL OR "statusCode" IS NOT NULL);

-- And an unfinished row has answered nothing yet.
ALTER TABLE "ConnectorIdempotencyRecord"
    ADD CONSTRAINT "ConnectorIdempotencyRecord_pending_has_no_body_check"
    CHECK ("completedAt" IS NOT NULL OR "responseBody" IS NULL);

COMMIT;
