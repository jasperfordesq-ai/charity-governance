BEGIN;

-- A page in the charity's own Confluence, cited as evidence for one of their
-- governance documents.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE REFERENCE MODEL. THE OPPOSITE DIRECTION FROM PUBLICATION.
-- ─────────────────────────────────────────────────────────────────────────
--
-- `DocumentPublication` records a page CharityPilot CREATED and maintains. This
-- records a page the charity already had, which CharityPilot cites and **never
-- writes to**. That is the architecture the DPO signed off on 2026-09-18:
-- Confluence authoritative for the documents deliberately managed there, and
-- CharityPilot referencing pages and versions rather than duplicating them.
--
-- The two must never be confused, which is why this is a separate table rather
-- than a flag on the publication row. A publication is ours to update, retire
-- and — on an explicit request — erase. A reference is somebody else's page
-- that we point at. Erasing one would mean deleting content a charity wrote
-- themselves, in their own site, that CharityPilot merely happened to cite;
-- there is no code path here that could, and a shared table would eventually
-- have grown one.
--
-- `pageVersion` is recorded because a citation without a version is not
-- evidence. "Our conflicts policy is this page" is a statement that decays
-- silently as the page is edited; "this page at version 7, cited on this date"
-- is one a trustee can check. Nothing here keeps the version current — the
-- point is that it records what was cited, not what is there now.
CREATE TABLE "ConfluenceReference" (
    "id"             TEXT         NOT NULL,
    "organisationId" TEXT         NOT NULL,
    "documentId"     TEXT         NOT NULL,
    -- The site, recorded and never re-resolved, for the same reason the erasure
    -- target records it: a page id means nothing without the site it is in.
    "cloudId"        TEXT         NOT NULL,
    "pageId"         TEXT         NOT NULL,
    "pageTitle"      TEXT         NOT NULL,
    "pageVersion"    INTEGER      NOT NULL,
    "pageUrl"        TEXT,
    "citedAt"        TIMESTAMP(3) NOT NULL,
    "citedById"      TEXT         NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfluenceReference_pkey" PRIMARY KEY ("id")
);

-- One citation per document per page. A charity may cite several pages for one
-- document, and the same page for several documents; citing the same page twice
-- for the same document is the same statement made twice.
CREATE UNIQUE INDEX "ConfluenceReference_documentId_pageId_key"
    ON "ConfluenceReference" ("documentId", "pageId");

CREATE INDEX "ConfluenceReference_organisationId_idx"
    ON "ConfluenceReference" ("organisationId");

-- The same write-time discipline the publication target carries, and for the
-- same reason: an identifier with stray whitespace is accepted here and then
-- refused by whatever later tries to address the page, long after the charity
-- has been told the citation was recorded.
ALTER TABLE "ConfluenceReference"
    ADD CONSTRAINT "ConfluenceReference_identifiers_recordable"
        CHECK (
            "cloudId" = btrim("cloudId")
            AND char_length("cloudId") BETWEEN 1 AND 200
            AND "pageId" = btrim("pageId")
            AND char_length("pageId") BETWEEN 1 AND 200
            AND char_length("pageTitle") BETWEEN 1 AND 500
            -- Confluence versions start at 1. A citation of version 0 is not a
            -- citation of anything.
            AND "pageVersion" >= 1
            AND ("pageUrl" IS NULL OR char_length("pageUrl") BETWEEN 1 AND 2000)
        );

ALTER TABLE "ConfluenceReference"
    ADD CONSTRAINT "ConfluenceReference_organisationId_fkey"
        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE on the document, and deliberately so: a citation is a statement ABOUT
-- a CharityPilot document, and when that document is gone the statement has no
-- subject. Note what this does NOT do — it removes CharityPilot's record of the
-- citation and touches nothing in Confluence, which is the owner's 2026-09-19
-- ruling applied to a page we never owned in the first place.
ALTER TABLE "ConfluenceReference"
    ADD CONSTRAINT "ConfluenceReference_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "Document"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
