BEGIN;

-- How a charity's published pages are SHAPED: naming convention, page body
-- mode, parent page, labels, content-state mirroring, classification.
--
-- A DEDICATED COLUMN, NOT `config`, AND THAT IS A CORRECTNESS REQUIREMENT
-- RATHER THAN A PREFERENCE. It is the third time this codebase has had to make
-- this exact decision, and the reasoning has not changed:
-- `connectConfluence` builds a `connectingState` that INCLUDES `config` and
-- spreads it into its upsert's `update`, so a reconnect -- the recovery action
-- CharityPilot's own error messages recommend -- overwrites `config` wholesale.
--
-- Follow it through for this setting specifically, because it is worse here
-- than it was for the publish space. A charity chooses FULL_BODY pages and
-- publishes thirty governance documents that way. Something goes wrong and an
-- administrator reconnects. The setting stored in `config` is silently erased,
-- the model reverts to STUB_WITH_ATTACHMENT, and the next metadata edit on each
-- document rewrites its page body back to a one-line wrapper -- thirty pages in
-- a charity's own Confluence site quietly rewritten, with nothing on any screen
-- explaining why. The publish space failing this way merely stopped
-- publication; this would change content that was already there.
--
-- This column is not part of `connectingState`, so it survives a reconnect by
-- construction rather than by anybody remembering.
--
-- Nullable, and NULL means "the defaults": exactly the behaviour every existing
-- charity has today. No backfill, because there is nothing to back-fill --
-- DEFAULT_PUBLISHING_MODEL reproduces the current behaviour field for field,
-- and a test asserts it.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "publishingModel" JSONB;

-- A JSON object or nothing. The reader is deliberately lenient about the
-- object's CONTENTS -- an unrecognised value falls back to the current
-- behaviour rather than throwing, so a malformed setting can never stop a
-- charity's documents publishing -- but a non-object here would mean something
-- other than this feature had written the column, and that is worth refusing.
ALTER TABLE "OrganisationIntegration"
    ADD CONSTRAINT "OrganisationIntegration_publishing_model_shape"
        CHECK (
            "publishingModel" IS NULL
            OR jsonb_typeof("publishingModel") = 'object'
        );

COMMIT;
