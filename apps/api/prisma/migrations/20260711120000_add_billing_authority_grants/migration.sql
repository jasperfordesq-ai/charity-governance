-- P0-07 billing capabilities are provider-hosted bearer authority. Persist an
-- actor/session/version-bound grant before any claimant is introduced, and
-- prevent an ownership change from silently outliving an issued capability.

BEGIN;

ALTER TYPE "AuthSessionRevocationReason"
    ADD VALUE IF NOT EXISTS 'USER_SESSION_REVOKED';
ALTER TYPE "AuthSessionRevocationReason"
    ADD VALUE IF NOT EXISTS 'USER_ALL_SESSIONS_REVOKED';

CREATE TYPE "BillingAuthorityGrantKind" AS ENUM (
    'CHECKOUT',
    'PORTAL'
);

CREATE TYPE "BillingAuthorityGrantState" AS ENUM (
    'CLAIMED',
    'PROVIDER_STARTED',
    'CAPABILITY_ISSUED',
    'RELEASED'
);

CREATE TYPE "BillingAuthorityGrantReleaseReason" AS ENUM (
    'PROVIDER_CONFIRMED_NOT_ISSUED',
    'PROVIDER_CAPABILITY_REVOKED',
    'PROVIDER_CAPABILITY_TERMINAL',
    'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED',
    'RESTRICTED_OPERATOR_ATTESTATION'
);

-- PostgreSQL requires an exact unique key for the composite session/actor FK.
-- The id remains the primary identity; this redundant key proves that a grant's
-- actorSessionId belongs to its actorUserId without denormalising tenant data.
CREATE UNIQUE INDEX "AuthSession_id_userId_key"
    ON "AuthSession"("id", "userId");

CREATE TABLE "BillingAuthorityGrant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisationId" TEXT NOT NULL,
    "kind" "BillingAuthorityGrantKind" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorSessionId" TEXT NOT NULL,
    "actorMembershipVersion" INTEGER NOT NULL,
    "state" "BillingAuthorityGrantState" NOT NULL DEFAULT 'CLAIMED',
    "providerResourceId" TEXT,
    "safeReleaseAfter" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerStartedAt" TIMESTAMP(3),
    "capabilityIssuedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" "BillingAuthorityGrantReleaseReason",
    "releaseActor" TEXT,
    "releaseEvidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAuthorityGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingAuthorityGrant_actor_membership_version_check"
        CHECK ("actorMembershipVersion" >= 1),
    CONSTRAINT "BillingAuthorityGrant_provider_resource_evidence_check"
        CHECK (
            "providerResourceId" IS NULL
            OR (
                "providerResourceId" = BTRIM("providerResourceId")
                AND CHAR_LENGTH("providerResourceId") BETWEEN 1 AND 255
                AND "providerResourceId" !~ '[[:cntrl:]]'
            )
        ),
    CONSTRAINT "BillingAuthorityGrant_release_evidence_check"
        CHECK (
            (
                "releaseActor" IS NULL
                OR (
                    "releaseActor" = BTRIM("releaseActor")
                    AND CHAR_LENGTH("releaseActor") BETWEEN 1 AND 160
                    AND "releaseActor" !~ '[[:cntrl:]]'
                )
            )
            AND (
                "releaseEvidence" IS NULL
                OR (
                    JSONB_TYPEOF("releaseEvidence") = 'object'
                    AND OCTET_LENGTH("releaseEvidence"::TEXT) <= 8192
                )
            )
        ),
    CONSTRAINT "BillingAuthorityGrant_timeline_check"
        CHECK (
            "claimedAt" = "createdAt"
            AND (
                "providerStartedAt" IS NULL
                OR "providerStartedAt" >= "claimedAt"
            )
            AND (
                "capabilityIssuedAt" IS NULL
                OR (
                    "providerStartedAt" IS NOT NULL
                    AND "capabilityIssuedAt" >= "providerStartedAt"
                )
            )
            AND (
                "safeReleaseAfter" IS NULL
                OR (
                    "kind" = 'CHECKOUT'::"BillingAuthorityGrantKind"
                    AND "safeReleaseAfter" >= "claimedAt"
                )
            )
            AND (
                "releasedAt" IS NULL
                OR "releasedAt" >= "claimedAt"
            )
        ),
    CONSTRAINT "BillingAuthorityGrant_state_evidence_check"
        CHECK (
            CASE "state"
                WHEN 'CLAIMED'::"BillingAuthorityGrantState" THEN
                    "providerStartedAt" IS NULL
                    AND "capabilityIssuedAt" IS NULL
                    AND "providerResourceId" IS NULL
                    AND "safeReleaseAfter" IS NULL
                    AND "releasedAt" IS NULL
                    AND "releaseReason" IS NULL
                    AND "releaseActor" IS NULL
                    AND "releaseEvidence" IS NULL
                WHEN 'PROVIDER_STARTED'::"BillingAuthorityGrantState" THEN
                    "providerStartedAt" IS NOT NULL
                    AND "capabilityIssuedAt" IS NULL
                    AND "providerResourceId" IS NULL
                    AND "safeReleaseAfter" IS NULL
                    AND "releasedAt" IS NULL
                    AND "releaseReason" IS NULL
                    AND "releaseActor" IS NULL
                    AND "releaseEvidence" IS NULL
                WHEN 'CAPABILITY_ISSUED'::"BillingAuthorityGrantState" THEN
                    "providerStartedAt" IS NOT NULL
                    AND "capabilityIssuedAt" IS NOT NULL
                    AND "providerResourceId" IS NOT NULL
                    AND "releasedAt" IS NULL
                    AND "releaseReason" IS NULL
                    AND "releaseActor" IS NULL
                    AND "releaseEvidence" IS NULL
                    AND CASE "kind"
                        WHEN 'PORTAL'::"BillingAuthorityGrantKind" THEN
                            "safeReleaseAfter" IS NULL
                        WHEN 'CHECKOUT'::"BillingAuthorityGrantKind" THEN
                            "safeReleaseAfter" IS NOT NULL
                        ELSE FALSE
                    END
                WHEN 'RELEASED'::"BillingAuthorityGrantState" THEN
                    "releasedAt" IS NOT NULL
                    AND "releaseReason" IS NOT NULL
                    AND "releaseActor" IS NOT NULL
                    AND "releaseEvidence" IS NOT NULL
                    AND (
                        "capabilityIssuedAt" IS NULL
                        OR "providerResourceId" IS NOT NULL
                    )
                ELSE FALSE
            END
        ),
    CONSTRAINT "BillingAuthorityGrant_portal_never_time_released_check"
        CHECK (
            "kind" <> 'PORTAL'::"BillingAuthorityGrantKind"
            OR (
                "safeReleaseAfter" IS NULL
                AND "releaseReason" IS DISTINCT FROM
                    'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED'::"BillingAuthorityGrantReleaseReason"
            )
        ),
    CONSTRAINT "BillingAuthorityGrant_release_reason_consistency_check"
        CHECK (
            "releaseReason" IS NULL
            OR (
                "releaseReason" = 'RESTRICTED_OPERATOR_ATTESTATION'::"BillingAuthorityGrantReleaseReason"
                AND "kind" = 'PORTAL'::"BillingAuthorityGrantKind"
            )
            OR (
                "releaseReason" = 'PROVIDER_CONFIRMED_NOT_ISSUED'::"BillingAuthorityGrantReleaseReason"
                AND "capabilityIssuedAt" IS NULL
                AND (
                    "kind" = 'CHECKOUT'::"BillingAuthorityGrantKind"
                    OR "releaseActor" = 'SYSTEM:BILLING_SERVICE'
                )
            )
            OR (
                "releaseReason" = 'PROVIDER_CAPABILITY_REVOKED'::"BillingAuthorityGrantReleaseReason"
                AND "kind" = 'CHECKOUT'::"BillingAuthorityGrantKind"
                AND "providerResourceId" IS NOT NULL
                AND "providerStartedAt" IS NOT NULL
            )
            OR (
                "releaseReason" = 'PROVIDER_CAPABILITY_TERMINAL'::"BillingAuthorityGrantReleaseReason"
                AND "kind" = 'CHECKOUT'::"BillingAuthorityGrantKind"
                AND "providerResourceId" IS NOT NULL
                AND "capabilityIssuedAt" IS NOT NULL
            )
            OR (
                "releaseReason" = 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED'::"BillingAuthorityGrantReleaseReason"
                AND "kind" = 'CHECKOUT'::"BillingAuthorityGrantKind"
                AND "capabilityIssuedAt" IS NOT NULL
                AND "providerResourceId" IS NOT NULL
                AND "safeReleaseAfter" IS NOT NULL
                AND "releasedAt" >= "safeReleaseAfter"
            )
        )
);

ALTER TABLE "BillingAuthorityGrant"
    ADD CONSTRAINT "BillingAuthorityGrant_organisationId_fkey"
        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "BillingAuthorityGrant_actorUserId_organisationId_fkey"
        FOREIGN KEY ("actorUserId", "organisationId")
        REFERENCES "User"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "BillingAuthorityGrant_actorSessionId_actorUserId_fkey"
        FOREIGN KEY ("actorSessionId", "actorUserId")
        REFERENCES "AuthSession"("id", "userId")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "BillingAuthorityGrant_providerResourceId_key"
    ON "BillingAuthorityGrant"("providerResourceId");
CREATE UNIQUE INDEX "BillingAuthorityGrant_one_active_per_organisation"
    ON "BillingAuthorityGrant"("organisationId")
    WHERE "state" <> 'RELEASED'::"BillingAuthorityGrantState";
CREATE INDEX "BillingAuthorityGrant_organisationId_state_id_idx"
    ON "BillingAuthorityGrant"("organisationId", "state", "id");
CREATE INDEX "BillingAuthorityGrant_actorUserId_state_id_idx"
    ON "BillingAuthorityGrant"("actorUserId", "state", "id");
CREATE INDEX "BillingAuthorityGrant_actorSessionId_state_id_idx"
    ON "BillingAuthorityGrant"("actorSessionId", "state", "id");
CREATE INDEX "BillingAuthorityGrant_safeReleaseAfter_state_id_idx"
    ON "BillingAuthorityGrant"("safeReleaseAfter", "state", "id");

CREATE FUNCTION "validate_billing_authority_grant_actor"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."state" <> 'CLAIMED'::"BillingAuthorityGrantState" THEN
        RAISE EXCEPTION 'Billing authority grant must begin in CLAIMED state'
            USING ERRCODE = '23514';
    END IF;

    -- Lock the principal hierarchy in the same order used by auth and team
    -- lifecycle work. A future claimant must already hold the Organisation row;
    -- these checks remain a database backstop against an unsafe direct insert.
    PERFORM 1
    FROM "Organisation"
    WHERE "id" = NEW."organisationId"
      AND "lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus"
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing authority grant requires an active organisation'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM "User"
    WHERE "id" = NEW."actorUserId"
      AND "organisationId" = NEW."organisationId"
      AND "role" = 'OWNER'::"UserRole"
      AND "lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND "membershipVersion" = NEW."actorMembershipVersion"
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing authority grant actor is not the current active owner version'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM "AuthSession"
    WHERE "id" = NEW."actorSessionId"
      AND "userId" = NEW."actorUserId"
      AND "revokedAt" IS NULL
      AND "expiresAt" > CURRENT_TIMESTAMP
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing authority grant requires the owner active session'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "BillingAuthorityGrant_validate_actor"
    BEFORE INSERT ON "BillingAuthorityGrant"
    FOR EACH ROW EXECUTE FUNCTION "validate_billing_authority_grant_actor"();

CREATE FUNCTION "guard_billing_authority_grant_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."state" = 'RELEASED'::"BillingAuthorityGrantState" THEN
        RAISE EXCEPTION 'Released billing authority evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
       OR NEW."actorSessionId" IS DISTINCT FROM OLD."actorSessionId"
       OR NEW."actorMembershipVersion" IS DISTINCT FROM OLD."actorMembershipVersion"
       OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Billing authority identity evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."providerStartedAt" IS NOT NULL
       AND NEW."providerStartedAt" IS DISTINCT FROM OLD."providerStartedAt" THEN
        RAISE EXCEPTION 'Billing provider-start evidence is immutable once recorded'
            USING ERRCODE = '55000';
    END IF;
    IF OLD."capabilityIssuedAt" IS NOT NULL
       AND NEW."capabilityIssuedAt" IS DISTINCT FROM OLD."capabilityIssuedAt" THEN
        RAISE EXCEPTION 'Billing capability-issued evidence is immutable once recorded'
            USING ERRCODE = '55000';
    END IF;
    IF OLD."providerResourceId" IS NOT NULL
       AND NEW."providerResourceId" IS DISTINCT FROM OLD."providerResourceId" THEN
        RAISE EXCEPTION 'Billing provider resource evidence is immutable once recorded'
            USING ERRCODE = '55000';
    END IF;
    IF OLD."safeReleaseAfter" IS NOT NULL
       AND NEW."safeReleaseAfter" IS DISTINCT FROM OLD."safeReleaseAfter" THEN
        RAISE EXCEPTION 'Billing safe-release evidence is immutable once recorded'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
        (OLD."state" = 'CLAIMED'::"BillingAuthorityGrantState"
            AND NEW."state" IN (
                'PROVIDER_STARTED'::"BillingAuthorityGrantState",
                'RELEASED'::"BillingAuthorityGrantState"
            ))
        OR
        (OLD."state" = 'PROVIDER_STARTED'::"BillingAuthorityGrantState"
            AND NEW."state" IN (
                'CAPABILITY_ISSUED'::"BillingAuthorityGrantState",
                'RELEASED'::"BillingAuthorityGrantState"
            ))
        OR
        (OLD."state" = 'CAPABILITY_ISSUED'::"BillingAuthorityGrantState"
            AND NEW."state" = 'RELEASED'::"BillingAuthorityGrantState")
    ) THEN
        RAISE EXCEPTION 'Billing authority state transition is not permitted'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "BillingAuthorityGrant_guard_update"
    BEFORE UPDATE ON "BillingAuthorityGrant"
    FOR EACH ROW EXECUTE FUNCTION "guard_billing_authority_grant_update"();

CREATE FUNCTION "reject_billing_authority_grant_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Billing authority evidence must be released, not deleted'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "BillingAuthorityGrant_append_only_delete"
    BEFORE DELETE ON "BillingAuthorityGrant"
    FOR EACH ROW EXECUTE FUNCTION "reject_billing_authority_grant_delete"();

-- Backstop all code paths: a principal bound to an unresolved provider
-- capability cannot have its ownership/lifecycle changed by ad-hoc SQL. The
-- application interlock releases an elapsed CHECKOUT grant first and returns a
-- precise conflict for every other unresolved grant.
CREATE FUNCTION "guard_billing_authority_actor_membership_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW."role" IS DISTINCT FROM OLD."role"
        OR NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
        OR NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
    ) AND EXISTS (
        SELECT 1
        FROM "BillingAuthorityGrant"
        WHERE "actorUserId" = OLD."id"
          AND "organisationId" = OLD."organisationId"
          AND "state" <> 'RELEASED'::"BillingAuthorityGrantState"
    ) THEN
        RAISE EXCEPTION 'Unresolved billing authority blocks actor membership change'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "User_billing_authority_membership_interlock"
    BEFORE UPDATE ON "User"
    FOR EACH ROW EXECUTE FUNCTION "guard_billing_authority_actor_membership_change"();

CREATE FUNCTION "guard_billing_authority_organisation_lifecycle_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
       AND EXISTS (
           SELECT 1
           FROM "BillingAuthorityGrant"
           WHERE "organisationId" = OLD."id"
             AND "state" <> 'RELEASED'::"BillingAuthorityGrantState"
       ) THEN
        RAISE EXCEPTION 'Unresolved billing authority blocks organisation lifecycle change'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "Organisation_billing_authority_lifecycle_interlock"
    BEFORE UPDATE ON "Organisation"
    FOR EACH ROW EXECUTE FUNCTION "guard_billing_authority_organisation_lifecycle_change"();

COMMIT;
