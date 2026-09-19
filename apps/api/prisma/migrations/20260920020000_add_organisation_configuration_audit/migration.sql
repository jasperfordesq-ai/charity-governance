-- A platform operator changing a charity's configuration is an auditable act.
--
-- The owner console can already suspend, reactivate and close a charity, and
-- each of those writes a SecurityAuditEvent naming the operator and the reason.
-- Configuration changes are about to join them: which document storage provider
-- a charity uses, whether it may opt into an alpha provider, and which plan it
-- is on.
--
-- These are not cosmetic settings. The storage provider decides where a
-- charity's files physically live, which is the question the whole EU-residency
-- design turns on, and the plan decides which features exist for them. A change
-- made by somebody at the platform, to somebody else's charity, with no record
-- of who or why, is exactly the gap the audit trail exists to close.
--
-- ADD VALUE IF NOT EXISTS, in its own migration, because PostgreSQL cannot use
-- a new enum value in the same transaction that created it.
ALTER TYPE "SecurityAuditEventType"
    ADD VALUE IF NOT EXISTS 'ORGANISATION_CONFIGURATION_CHANGED';
