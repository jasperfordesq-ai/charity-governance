-- Seven audit event types for the Confluence integration's lifecycle.
--
-- A MIGRATION OF ITS OWN, CONTAINING NOTHING ELSE, DELIBERATELY. PostgreSQL
-- will not let a newly added enum value be USED in the same transaction that
-- added it, and Prisma wraps each migration file in one. A migration that added
-- these values and then wrote a row with one would fail on a fresh database and
-- pass on every database where an earlier deploy had already added them --
-- which is the worst possible failure shape, because it works on the machine of
-- whoever wrote it. Keeping the ALTER TYPEs alone removes the possibility.
--
-- No IF NOT EXISTS: this migration runs once, tracked by _prisma_migrations, and
-- a silent skip would hide a genuine divergence between a database and its
-- migration history.
--
-- WHY THESE SEVEN. A DPO reviewing this system needs to be able to answer, from
-- the audit log alone and without reading the application: when was this charity
-- connected to Confluence, to which site, who chose it, where were its documents
-- pointed, when did the authorisation lapse or get withdrawn, and when did
-- somebody ask for something to be erased from the charity's own site. Every one
-- of those is a question about the charity's data leaving or ceasing to leave
-- CharityPilot, and none of them was answerable before.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_CONNECTED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_SITE_SELECTED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_DISCONNECTED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_PUBLISH_TARGET_CHANGED';
-- Covers both routes to the same condition: a grant Atlassian rejected, and one
-- the dormancy sweep let lapse. The `reason` distinguishes them; the fact that
-- the charity must reconnect is the same, and an operator scanning the log for
-- "why did publishing stop" should not have to know which happened to find it.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_REAUTHORISATION_REQUIRED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'DOCUMENT_PUBLICATION_DEAD_LETTERED';
-- Requested, not performed. Erasure from a charity's own Confluence site is an
-- explicitly authorised action under the owner's 2026-09-19 ruling, and the
-- moment worth recording is the moment somebody asked for it -- a purge that
-- then fails must not remove the record that it was asked for.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'CONFLUENCE_ERASURE_REQUESTED';
