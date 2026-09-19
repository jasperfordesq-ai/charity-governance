-- Where a charity's governance documents are published: the Confluence space
-- an administrator chose, and the site that space belongs to.
--
-- DEDICATED COLUMNS RATHER THAN `config`, DELIBERATELY. Every write to
-- OrganisationIntegration lives inside confluence-connection.service.ts, and
-- connectConfluence builds a `connectingState` that INCLUDES `config` and
-- spreads it into the upsert's `update`. A reconnect therefore overwrites
-- `config` wholesale -- and reconnecting is the recovery action CharityPilot's
-- own error messages recommend. A chosen space stored there would be silently
-- wiped: publication would stop while the row still read CONNECTED, with
-- nothing on screen explaining why. These columns are not part of
-- `connectingState`, so they survive a reconnect by construction.
--
-- publishSpaceSiteId exists because SPACE IDS ARE PER-SITE. A charity that
-- reconnects to a different Atlassian site must not keep a space id that names
-- nothing there; a mismatch against config.siteId reads as "no space chosen".
--
-- All four columns are nullable: purely additive, no existing row is affected,
-- and an organisation that has connected but not yet chosen is exactly the
-- all-NULL state -- connected, and not publishing.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "publishSpaceId" TEXT,
    ADD COLUMN "publishSpaceKey" TEXT,
    ADD COLUMN "publishSpaceName" TEXT,
    ADD COLUMN "publishSpaceSiteId" TEXT;

-- Fail closed at the database, the same way DocumentPublication's
-- publication_target_consistent does, and for two reasons:
--
--  1. The four columns are one fact. A bug that clears the space id without
--     the site id (or writes a key with no id) would leave a half-chosen
--     destination that some later reader could resolve differently from this
--     one.
--  2. Untrimmed ids are refused AT WRITE TIME. A space id with stray
--     whitespace publishes fine and only fails when a charity asks for
--     erasure -- after the Irish copy is gone -- because Phase 5's
--     parseConfluenceErasureTarget requires value = btrim(value) and refuses
--     PERMANENTLY. Cheaper to refuse the write.
--
-- publishSpaceName is exempt from the non-empty test on purpose: it is display
-- text, listSpaces already yields '' for a space Confluence returned without a
-- name, and a nameless space is still a perfectly good destination.
--
-- 48 bytes, comfortably inside PostgreSQL's 63-byte identifier limit.
ALTER TABLE "OrganisationIntegration"
    ADD CONSTRAINT "OrganisationIntegration_publish_space_consistent"
        CHECK (
            ("publishSpaceId" IS NULL) = ("publishSpaceSiteId" IS NULL)
            AND ("publishSpaceId" IS NULL) = ("publishSpaceKey" IS NULL)
            AND ("publishSpaceId" IS NULL) = ("publishSpaceName" IS NULL)
            AND (
                "publishSpaceId" IS NULL
                OR ("publishSpaceId" = btrim("publishSpaceId") AND length("publishSpaceId") > 0)
            )
            AND (
                "publishSpaceSiteId" IS NULL
                OR ("publishSpaceSiteId" = btrim("publishSpaceSiteId") AND length("publishSpaceSiteId") > 0)
            )
            AND (
                "publishSpaceKey" IS NULL
                OR ("publishSpaceKey" = btrim("publishSpaceKey") AND length("publishSpaceKey") > 0)
            )
        );
