BEGIN;

-- The explicit Confluence erasure workflow (Task 4) validates a 10-500
-- character reason and records who asked, then discarded both -- the route
-- enforced them only through the TypeScript type, never wrote them anywhere.
-- Asking for a reason and throwing it away is worse than not asking, because
-- it implies a record exists. A DPO or regulator asking who authorised
-- destroying a specific Confluence page, and why, must get an actual answer
-- from this row.
--
-- Both columns are nullable: most rows in this queue are the ordinary,
-- unattended Supabase cleanup every document deletion enqueues, which nobody
-- explicitly "requests" -- it just happens as a consequence of deleting the
-- document. Only a row created by `requestConfluenceErasure` carries these,
-- and it always writes both together, which the consistency check below
-- enforces the same way `DocumentPublication_erasure_request_consistent`
-- enforces its own paired columns.
ALTER TABLE "DocumentStorageDeletion"
    ADD COLUMN "reason" TEXT,
    ADD COLUMN "requestedById" TEXT;

ALTER TABLE "DocumentStorageDeletion"
    ADD CONSTRAINT "DocumentStorageDeletion_request_consistent"
        CHECK (
            ("reason" IS NULL) = ("requestedById" IS NULL)
            AND ("reason" IS NULL
                 OR ("reason" = btrim("reason")
                     AND char_length("reason") BETWEEN 10 AND 500
                     AND replace("reason", E'\n', '') !~ '[[:cntrl:]]'))
            AND ("requestedById" IS NULL
                 OR char_length("requestedById") BETWEEN 1 AND 200)
        );

COMMIT;
