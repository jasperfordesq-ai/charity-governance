-- An approval belongs to a session FAMILY, not to a single session row.
--
-- Found by the live suite, which granted an approval and then could not spend
-- it. Rotation mints a new "AuthSession" row on every refresh, so the id a
-- request carries changes roughly every fifteen minutes, and certainly between
-- one connector process and the next. An approval bound to that id is dead
-- before anyone can type a password, which is the one thing it exists to wait
-- for.
--
-- The family identifier is stable for the life of a sign-in and is exactly the
-- boundary the rule wanted in the first place: one connector installation's
-- session. A second connector, signed in separately, has a different family and
-- still cannot spend the first one's approval.
--
-- Renamed rather than left misleading. This table has never existed outside a
-- disposable database, so nothing is reading the old name.
BEGIN;

ALTER TABLE "AuthActionApproval"
    RENAME COLUMN "sessionId" TO "sessionFamilyId";

ALTER INDEX "AuthActionApproval_sessionId_requestDigest_idx"
    RENAME TO "AuthActionApproval_sessionFamilyId_requestDigest_idx";

ALTER INDEX "AuthActionApproval_live_digest_key"
    RENAME TO "AuthActionApproval_live_family_digest_key";

COMMIT;
