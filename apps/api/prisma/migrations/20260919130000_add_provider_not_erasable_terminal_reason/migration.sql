-- A document-storage deletion row whose provider has no eraser registered in
-- this deployment cannot be erased by retrying: retrying cannot acquire a
-- storage backend any more than it can acquire a permission. Such a row
-- dead-letters on its first attempt with its own terminal reason rather than
-- burning the full attempt budget and reporting MAX_ATTEMPTS_EXHAUSTED, which
-- would delay the operator alert by hours and then misdescribe the cause.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+
-- provided the new value is not used in the same transaction; this migration
-- only declares it. IF NOT EXISTS keeps a re-run against an already-migrated
-- database from failing.
ALTER TYPE "DocumentStorageDeletionTerminalReason"
    ADD VALUE IF NOT EXISTS 'PROVIDER_NOT_ERASABLE';
