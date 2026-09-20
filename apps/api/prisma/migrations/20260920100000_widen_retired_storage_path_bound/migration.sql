BEGIN;

-- `retiredStoragePath` is copied from `Document.fileUrl`, and
-- `assertOrganisationStoragePath` permits that path up to 1024 characters —
-- the same bound `DocumentStorageDeletion.storagePath` is written under. The
-- 500-character bound this migration replaces was never derived from that
-- limit; it was simply too low. A document whose path fell between 501 and
-- 1024 characters made `retireConfluencePublication`'s write fail this CHECK,
-- and that write is best-effort by design (an ordinary deletion must never
-- fail on it), so the failure was logged and swallowed — leaving the row
-- stuck PENDING or DEAD_LETTER forever, with a page nothing could ever mark
-- erasable. Raising the bound to match the column it is copied from removes
-- that failure mode outright, rather than truncating a value that would then
-- address nothing.
ALTER TABLE "DocumentPublication"
    DROP CONSTRAINT "DocumentPublication_erasure_request_consistent";

ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_erasure_request_consistent"
        CHECK (
            ("erasureRequestedAt" IS NULL) = ("erasureDeletionId" IS NULL)
            AND ("erasureRequestedAt" IS NULL OR "state" = 'RETIRED')
            AND ("erasureDeletionId" IS NULL
                 OR ("erasureDeletionId" = btrim("erasureDeletionId")
                     AND char_length("erasureDeletionId") BETWEEN 1 AND 200))
            AND ("retiredStoragePath" IS NULL OR char_length("retiredStoragePath") <= 1024)
        );

COMMIT;
