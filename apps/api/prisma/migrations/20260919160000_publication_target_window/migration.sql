BEGIN;

-- The create-then-attach window, which the publish worker cannot survive a
-- crash without.
--
-- `20260919140000_add_document_publication` shipped
-- `publication_target_consistent` in a form that reads:
--
--     ("publishedAt" IS NULL AND "pageId" IS NULL AND "cloudId" IS NULL)
--     OR ("publishedAt" IS NOT NULL AND … trimmed, bounded …)
--
-- which makes recording a page id *before* the publish completes impossible: a
-- PENDING row may not carry `publishedAt` (state_consistent), so it may not
-- carry `pageId` either. But `createPage` is deliberately non-idempotent, and
-- the one way this pipeline produces **two pages for one board resolution** is
-- a page id that was learned and then lost. `findPageByTitle` is a search, and
-- Confluence does not promise a page created seconds ago is in its index yet,
-- so a crash between the create and the attachment upload must be recoverable
-- from the row rather than from a search that may not see the page.
--
-- So the window is made expressible: `cloudId` and `pageId` may be recorded
-- while `publishedAt` is still null. Nothing the previous form guaranteed is
-- given up —
--
--   * every id, whenever present, is still trimmed and bounded (Phase 5's
--     `parseConfluenceErasureTarget` refuses an untrimmed id PERMANENTLY, so
--     the database refuses it at write time instead);
--   * a published row still has to say where it published to;
--
-- — and two guarantees are added that the previous form could not state,
-- because it could not describe a half-published row at all:
--
--   * a page id and the site it lives on travel together, always. Either alone
--     names nothing: a page id without a cloud id cannot be addressed, and a
--     cloud id without a page id records a site nothing is on.
--   * an attachment id implies the page it hangs from.
--
-- An empty string also stops being acceptable: `btrim('') = ''` and
-- `char_length('') <= 200` both hold, so the previous form admitted `''` as a
-- published target. `parseConfluenceErasureTarget` refuses it, and so now does
-- the column.

ALTER TABLE "DocumentPublication"
    DROP CONSTRAINT "DocumentPublication_publication_target_consistent";

ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_publication_target_consistent"
        CHECK (
            ("cloudId" IS NULL
             OR ("cloudId" = btrim("cloudId") AND char_length("cloudId") BETWEEN 1 AND 200))
            AND ("pageId" IS NULL
                 OR ("pageId" = btrim("pageId") AND char_length("pageId") BETWEEN 1 AND 200))
            AND ("spaceId" IS NULL
                 OR ("spaceId" = btrim("spaceId") AND char_length("spaceId") BETWEEN 1 AND 200))
            AND ("attachmentId" IS NULL
                 OR ("attachmentId" = btrim("attachmentId") AND char_length("attachmentId") BETWEEN 1 AND 200))
            -- A page and its site travel together or not at all.
            AND ("pageId" IS NULL) = ("cloudId" IS NULL)
            -- An attachment hangs from a page.
            AND ("attachmentId" IS NULL OR "pageId" IS NOT NULL)
            -- A published row must say where it published to.
            AND ("publishedAt" IS NULL OR ("cloudId" IS NOT NULL AND "pageId" IS NOT NULL))
        );

COMMIT;
