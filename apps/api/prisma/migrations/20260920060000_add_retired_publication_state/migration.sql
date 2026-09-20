-- An ordinary CharityPilot deletion removes our record and its reference only;
-- destroying the Confluence source requires an explicit erasure workflow
-- (owner's ruling, 2026-09-19). A publication whose document has been deleted
-- therefore has to keep naming its page rather than being erased or discarded,
-- and no existing state says that: PENDING means "still trying", DEAD_LETTER
-- means "the publish failed", PROCESSED means "published and current".
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+
-- provided the new value is not used in the same transaction; this migration
-- only declares it, and 20260920070000 is where it is first used. IF NOT EXISTS
-- keeps a re-run against an already-migrated database from failing.
ALTER TYPE "DocumentPublicationState"
    ADD VALUE IF NOT EXISTS 'RETIRED';
