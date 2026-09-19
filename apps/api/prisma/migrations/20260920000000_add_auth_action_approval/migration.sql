-- One human approval for one destructive action, bound to the exact request.
--
-- The alternative that was considered first, and rejected by the owner once the
-- objection was put, is a time window: type the password, and for ten minutes
-- the session may destroy things. A window elevates the agent, not the person.
-- For those ten minutes every instruction the agent holds carries the raised
-- authority, including instructions it read out of a document or a web page.
--
-- An approval carries a digest of the request it approves — session, method,
-- path and a canonical form of the body — so it cannot be spent on a different
-- action however the agent is persuaded in between. It is single-use, and it
-- expires in minutes.
--
-- Not append-only, unlike the activity record beside it: this row is a
-- capability with a lifecycle, and it has to be markable as approved and then
-- as consumed. What it did is recorded in ClientActivityEvent, which is
-- append-only, so the evidence does not depend on this table's honesty.
BEGIN;

-- CreateTable
CREATE TABLE "AuthActionApproval" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- The session that asked. An approval minted for one connector session is
    -- useless to another, so a second agent cannot spend the first one's.
    "sessionId" TEXT NOT NULL,
    -- SHA-256 over session, method, path and canonical body.
    "requestDigest" TEXT NOT NULL,
    -- What the person is being asked to approve, in words, built by the API
    -- from the route it matched. Never from anything the client sent: a summary
    -- the caller can write is a summary the caller can lie in.
    "summary" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "routePattern" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AuthActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthActionApproval_id_organisationId_key"
    ON "AuthActionApproval"("id", "organisationId");

-- CreateIndex
-- Finding the approval a request may spend, and sweeping expired ones.
CREATE INDEX "AuthActionApproval_sessionId_requestDigest_idx"
    ON "AuthActionApproval"("sessionId", "requestDigest");

-- CreateIndex
CREATE INDEX "AuthActionApproval_expiresAt_idx"
    ON "AuthActionApproval"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthActionApproval"
    ADD CONSTRAINT "AuthActionApproval_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthActionApproval"
    ADD CONSTRAINT "AuthActionApproval_userId_organisationId_fkey"
    FOREIGN KEY ("userId", "organisationId") REFERENCES "User"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An approval cannot be consumed before it was approved, and cannot be
-- approved after it expired. Enforced here rather than only in code, because
-- the whole point of the row is that it is the thing standing between an agent
-- and a deletion.
ALTER TABLE "AuthActionApproval"
    ADD CONSTRAINT "AuthActionApproval_consumed_implies_approved_check"
    CHECK ("consumedAt" IS NULL OR "approvedAt" IS NOT NULL);

ALTER TABLE "AuthActionApproval"
    ADD CONSTRAINT "AuthActionApproval_approved_before_expiry_check"
    CHECK ("approvedAt" IS NULL OR "approvedAt" <= "expiresAt");

-- At most one live approval per session and digest. Without this, an agent
-- could ask repeatedly for the same action, collect several approvals from one
-- distracted human, and spend them one after another.
CREATE UNIQUE INDEX "AuthActionApproval_live_digest_key"
    ON "AuthActionApproval"("sessionId", "requestDigest")
    WHERE "consumedAt" IS NULL;

COMMIT;
