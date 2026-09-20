BEGIN;

-- What the reconcile job last saw on the Confluence side, and how each tenant's
-- last visit ended.
--
-- TRASHED and GONE are separate values because Confluence cannot tell them
-- apart through v2: GET /pages/{id} answers 404 for a page in the trash and for
-- one that has been purged. Only the v1 content read with status=trashed
-- distinguishes them, and the difference is the whole of what a charity needs
-- to know -- one is restorable by them, in their own site's trash, and the
-- other is not restorable by anyone. This is why no copy anywhere in the
-- product is allowed to say "deleted", and why that is pinned by a test.
--
-- UNKNOWN is a determinate value meaning "the site refused to tell us", which
-- is not the same as a NULL remoteState meaning "never checked".
CREATE TYPE "DocumentPublicationRemoteState" AS ENUM (
    'VISIBLE',
    'ARCHIVED',
    'TRASHED',
    'GONE',
    'UNKNOWN'
);

-- How a tenant's reconcile visit ended, or why it was deliberately not visited.
--
-- EXPIRING_SOON and EXPIRED record a ruling, not a technical limit. The DPO
-- ruled on 2026-09-20 that refreshing an Atlassian token as a by-product of an
-- integration doing real work is legitimate, but refreshing one SOLELY to stop
-- an otherwise dormant authorisation expiring is not: unused access should be
-- allowed to lapse and the organisation asked to reconnect. The reconcile job
-- therefore never visits a tenant with nothing to reconcile -- it does not so
-- much as take a token -- and these two values record the lapse approaching and
-- then arriving, rather than a keepalive quietly preventing it.
CREATE TYPE "IntegrationReconcileOutcome" AS ENUM (
    'OK',
    'RECONNECT_REQUIRED',
    'FORBIDDEN',
    'SITE_NOT_ACCESSIBLE',
    'RATE_LIMITED',
    'EXPIRING_SOON',
    'EXPIRED'
);

-- Read-only mirror state. Nothing added here is authoritative about the
-- document: CharityPilot stays authoritative for approvals, deadlines and audit
-- history, and these columns record only what the remote copy looked like when
-- it was last read. That is the DPO-agreed architecture, and it is why every
-- one of them may be stale by up to a reconcile interval with no governance
-- consequence whatsoever.
ALTER TABLE "DocumentPublication"
    ADD COLUMN "remoteState"          "DocumentPublicationRemoteState",
    ADD COLUMN "remoteVersion"        INTEGER,
    ADD COLUMN "remoteTitle"          TEXT,
    ADD COLUMN "remoteStateChangedAt" TIMESTAMP(3),
    ADD COLUMN "lastReconciledAt"     TIMESTAMP(3),
    ADD COLUMN "reconcileAttemptedAt" TIMESTAMP(3),
    ADD COLUMN "reconcileError"       TEXT;

-- Fail closed at the database, as DocumentPublication's other invariants do.
--
-- The load-bearing clause is the last one. `reconcileError` is documented as
-- holding a CODE and never upstream text, because an error string from
-- Atlassian is untrusted data and this column is read straight back onto a
-- screen. A comment cannot enforce that; a pattern can. Anything that tries to
-- store a sentence -- which is what an unwrapped upstream error is -- fails the
-- character class or the 80-character bound and is refused at write time,
-- rather than being discovered when it is rendered.
--
-- The three timestamps answer different questions and the constraint keeps them
-- honest about it:
--   `lastReconciledAt` is the last DETERMINATE answer, so UNKNOWN must not move
--   it -- otherwise "checked 3 days ago" could mean "asked 3 days ago and was
--   refused", which is the opposite of what a reader would take from it.
ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_reconcile_consistent"
        CHECK (
            -- Nothing reconcile-shaped exists without an attempt behind it.
            ("remoteState" IS NULL OR "reconcileAttemptedAt" IS NOT NULL)
            AND ("lastReconciledAt" IS NULL OR "reconcileAttemptedAt" IS NOT NULL)
            -- Never checked means never answered, and never changed.
            AND ("remoteState" IS NOT NULL
                 OR ("lastReconciledAt" IS NULL
                     AND "remoteStateChangedAt" IS NULL
                     AND "remoteVersion" IS NULL
                     AND "remoteTitle" IS NULL))
            -- A determinate answer stamps the determinate clock; UNKNOWN does not.
            --
            -- UNKNOWN is exempt in one direction only. It must not REQUIRE
            -- `lastReconciledAt`, because a 403 on the very first visit is a
            -- legitimate UNKNOWN with no determinate answer ever recorded; but
            -- it must not FORBID one either, because the ordinary case is a row
            -- read successfully yesterday and refused today, which keeps
            -- yesterday's stamp. Both are why this is a one-way implication
            -- and not an equality.
            AND ("remoteState" IS NULL
                 OR "remoteState" = 'UNKNOWN'
                 OR "lastReconciledAt" IS NOT NULL)
            -- A recorded state is a state we have seen, so it has a change time.
            AND ("remoteState" IS NULL OR "remoteStateChangedAt" IS NOT NULL)
            -- Confluence version numbers start at 1.
            AND ("remoteVersion" IS NULL OR "remoteVersion" >= 1)
            AND ("remoteTitle" IS NULL OR char_length("remoteTitle") <= 500)
            -- A CODE, never upstream text, and only where the read was refused.
            AND ("reconcileError" IS NULL
                 OR ("remoteState" = 'UNKNOWN'
                     AND "reconcileError" = btrim("reconcileError")
                     AND char_length("reconcileError") BETWEEN 1 AND 80
                     AND "reconcileError" ~ '^[A-Z][A-Z0-9_]*$'))
        );

-- Drives the reconcile stamp-claim: oldest attempt first, NULLS FIRST, within
-- one provider. Deliberately NOT keyed on `state` the way the outbox index is.
-- The reconciler's question is "which mirrors have I not looked at lately",
-- and a row's publish state is checked after it is claimed, not before -- an
-- index that led with `state` would order the queue by something the claim
-- does not filter on.
CREATE INDEX "DocumentPublication_provider_reconcileAttemptedAt_idx"
    ON "DocumentPublication" ("provider", "reconcileAttemptedAt");

-- Tenant-level reconcile state, plus what the charity DECLARED about the
-- Atlassian environment they connected.
--
-- Dedicated columns rather than `config`, for the same reason the publish space
-- is: `connectConfluence` spreads `config` into its upsert's `update`, so a
-- reconnect -- the recovery action CharityPilot's own error messages recommend
-- -- overwrites it wholesale. A declared residency stored there would be
-- silently erased by the act of reconnecting, and the owner console would go on
-- showing the value it read before.
--
-- DECLARED, never verified. CharityPilot does not control a connected site's
-- residency or plan, and cannot read either from the Atlassian API. Recording
-- what the organisation stated, with who stated it and when, is the only honest
-- form -- which is why `declaredById` is not optional alongside `declaredAt`.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "lastReconcileAt"      TIMESTAMP(3),
    ADD COLUMN "lastReconcileOutcome" "IntegrationReconcileOutcome",
    ADD COLUMN "dormancyNoticedAt"    TIMESTAMP(3),
    ADD COLUMN "declaredPlan"         TEXT,
    ADD COLUMN "declaredResidency"    TEXT,
    ADD COLUMN "declaredAt"           TIMESTAMP(3),
    ADD COLUMN "declaredById"         TEXT;

-- `dormancyNoticedAt` exists so the lapse notice is raised ONCE. Without it the
-- six-hourly sweep would write an audit event every six hours for the thirty
-- days between the warning and the expiry -- about 120 events all saying the
-- same thing, which is how an audit log stops being read. Tying it to the two
-- dormancy outcomes is what stops it being set by anything else and then
-- suppressing a genuine later notice.
--
-- The explicit NOT NULL is not redundant, and leaving it out was a real bug
-- caught by probing this constraint rather than reading it. With a NULL
-- `lastReconcileOutcome`, `NULL IN ('EXPIRING_SOON','EXPIRED')` evaluates to
-- NULL, and a CHECK constraint only refuses FALSE -- so a notice stamped
-- against no outcome at all was accepted by the very constraint written to
-- forbid it.
ALTER TABLE "OrganisationIntegration"
    ADD CONSTRAINT "OrganisationIntegration_dormancy_notice_consistent"
        CHECK (
            "dormancyNoticedAt" IS NULL
            OR ("lastReconcileOutcome" IS NOT NULL
                AND "lastReconcileOutcome" IN ('EXPIRING_SOON', 'EXPIRED'))
        );

ALTER TABLE "OrganisationIntegration"
    ADD CONSTRAINT "OrganisationIntegration_declared_environment_consistent"
        CHECK (
            -- Who said so and when are one fact with what was said.
            ("declaredAt" IS NULL) = ("declaredById" IS NULL)
            AND (("declaredPlan" IS NULL AND "declaredResidency" IS NULL)
                 OR "declaredAt" IS NOT NULL)
            AND ("declaredById" IS NULL
                 OR ("declaredById" = btrim("declaredById")
                     AND char_length("declaredById") BETWEEN 1 AND 200))
            AND ("declaredPlan" IS NULL
                 OR ("declaredPlan" = btrim("declaredPlan")
                     AND char_length("declaredPlan") BETWEEN 1 AND 100))
            AND ("declaredResidency" IS NULL
                 OR ("declaredResidency" = btrim("declaredResidency")
                     AND char_length("declaredResidency") BETWEEN 1 AND 100))
        );

COMMIT;
