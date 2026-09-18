-- Serialises token refresh across the web process and the background jobs.
-- Atlassian's refresh tokens are single-use: a concurrent refresh invalidates
-- the loser's token and disconnects the charity. Follows the claim idiom
-- already used by DocumentStorageDeletion (claimedAt / alertClaimToken +
-- alertClaimedAt) rather than inventing a new locking mechanism.
--
-- All four columns are nullable or defaulted: purely additive, no existing
-- row is affected, and nothing reads these columns yet.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "refreshClaimedAt" TIMESTAMP(3),
    ADD COLUMN "refreshClaimToken" TEXT,
    ADD COLUMN "refreshFailureCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastRefreshedAt" TIMESTAMP(3);
