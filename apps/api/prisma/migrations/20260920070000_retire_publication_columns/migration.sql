BEGIN;

-- Where the deleted document's bytes were, copied at retirement. The Confluence
-- eraser addresses the page through `targetRef` and must never fall back to
-- this; it exists because DocumentStorageDeletion.storagePath is NOT NULL and
-- the Document row is gone by the time an erasure can be requested, so there
-- would otherwise be nothing to tell an operator which document a row is for.
ALTER TABLE "DocumentPublication"
    ADD COLUMN "retiredAt" TIMESTAMP(3),
    ADD COLUMN "retiredStoragePath" TEXT,
    ADD COLUMN "erasureRequestedAt" TIMESTAMP(3),
    ADD COLUMN "erasureDeletionId" TEXT;

ALTER TABLE "DocumentPublication"
    DROP CONSTRAINT "DocumentPublication_state_consistent";

ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_state_consistent"
        CHECK (
            (
                "state" = 'PENDING'
                AND "processedAt" IS NULL
                AND "publishedAt" IS NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NOT NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
                AND "retiredAt" IS NULL
            ) OR (
                "state" = 'DEAD_LETTER'
                AND "processedAt" IS NULL
                AND "deadLetteredAt" IS NOT NULL
                AND "terminalReason" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "attempts" >= 1
                AND "retiredAt" IS NULL
            ) OR (
                "state" = 'PROCESSED'
                AND "processedAt" IS NOT NULL
                AND "publishedAt" IS NOT NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "lastError" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
                AND "retiredAt" IS NULL
            ) OR (
                -- Retirement deliberately constrains only what it owns. A row
                -- can be retired out of any of the three states above, so its
                -- history fields — publishedAt, processedAt, deadLetteredAt,
                -- terminalReason, alertedAt — are whatever that state left and
                -- are not re-stated here. What retirement DOES assert: the page
                -- is still named, nothing will retry it, and no worker holds it.
                "state" = 'RETIRED'
                AND "retiredAt" IS NOT NULL
                AND "pageId" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
            )
        );

-- An erasure request is a stamped pair or neither half, and it can only be made
-- against a retired row: the two-step workflow is delete the document first,
-- then erase the Confluence copy. Allowing a request against a PROCESSED row
-- would let an administrator destroy the page a live document still points at.
ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_erasure_request_consistent"
        CHECK (
            ("erasureRequestedAt" IS NULL) = ("erasureDeletionId" IS NULL)
            AND ("erasureRequestedAt" IS NULL OR "state" = 'RETIRED')
            AND ("erasureDeletionId" IS NULL
                 OR ("erasureDeletionId" = btrim("erasureDeletionId")
                     AND char_length("erasureDeletionId") BETWEEN 1 AND 200))
            AND ("retiredStoragePath" IS NULL OR char_length("retiredStoragePath") <= 500)
        );

COMMIT;
