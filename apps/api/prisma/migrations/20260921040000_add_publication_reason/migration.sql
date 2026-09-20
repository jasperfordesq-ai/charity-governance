BEGIN;

-- Why this publication is queued.
--
-- Until now a DocumentPublication row could only mean one thing — a document
-- had just been uploaded — because nothing ever re-queued one. Republishing on
-- change gives the same row a second and third life, and an operator looking at
-- a stuck row needs to know which: a CREATE that never landed is a page that
-- does not exist, a METADATA that never landed is a page whose recorded
-- approval dates are stale, and a FILE that never landed is a page carrying the
-- previous version of the document. Those are three different conversations
-- with a charity.
CREATE TYPE "DocumentPublicationReason" AS ENUM (
    'CREATE',
    'METADATA',
    'FILE'
);

-- Defaulted rather than nullable, and backfilled to CREATE, because that is
-- what every existing row actually is: the only path that has ever enqueued a
-- publication is document creation. A nullable column would leave "unknown"
-- as a permanent third state for rows whose reason is not in doubt.
ALTER TABLE "DocumentPublication"
    ADD COLUMN "reason" "DocumentPublicationReason" NOT NULL DEFAULT 'CREATE';

-- When the row was last re-queued, and by which change. NULL on a row that has
-- only ever been published once, which is the common case and reads correctly
-- as "never republished".
ALTER TABLE "DocumentPublication"
    ADD COLUMN "requeuedAt" TIMESTAMP(3);

ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_requeue_consistent"
        CHECK (
            -- A re-queue is by definition not the first publication, so it
            -- cannot be a CREATE. This is what stops a re-queue path from
            -- forgetting to record why, leaving a row that claims to be a fresh
            -- upload while pointing at a page that already exists.
            "requeuedAt" IS NULL OR "reason" <> 'CREATE'
        );

COMMIT;
