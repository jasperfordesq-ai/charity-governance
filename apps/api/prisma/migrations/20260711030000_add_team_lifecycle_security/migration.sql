-- P0-07 is a fail-closed lifecycle cutover. Block concurrent writers while the
-- legacy ownership and invitation state is checked and upgraded.
BEGIN;

LOCK TABLE "Organisation" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "TeamInvite" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "AuthSession" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Organisation" AS organisation
        LEFT JOIN "User" AS account
          ON account."organisationId" = organisation."id"
        GROUP BY organisation."id"
        HAVING COUNT(*) FILTER (WHERE account."role" = 'OWNER'::"UserRole") <> 1
    ) THEN
        RAISE EXCEPTION
            'P0-07 lifecycle migration refused: every organisation must have exactly one legacy owner'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (SELECT 1 FROM "TeamInvite" WHERE "role" = 'OWNER'::"UserRole") THEN
        RAISE EXCEPTION
            'P0-07 lifecycle migration refused: legacy OWNER invitations require manual resolution'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "TeamInvite"
        WHERE "acceptedAt" IS NOT NULL
          AND "revokedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'P0-07 lifecycle migration refused: an invitation cannot be both accepted and revoked'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE TYPE "OrganisationLifecycleStatus" AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'CLOSED'
);

CREATE TYPE "UserLifecycleStatus" AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'REMOVED'
);

CREATE TYPE "AuthSessionRevocationReason" AS ENUM (
    'LOGOUT',
    'ROTATED',
    'REFRESH_REUSE',
    'PASSWORD_RESET',
    'MEMBER_SUSPENDED',
    'MEMBER_REMOVED',
    'ADMIN_SESSION_REVOKED',
    'ADMIN_ALL_SESSIONS_REVOKED',
    'OWNERSHIP_CHANGED',
    'ORGANISATION_INACTIVE',
    'LEGACY_UNSPECIFIED'
);

CREATE TYPE "SecurityAuditActorKind" AS ENUM (
    'USER',
    'SUPPORT',
    'SYSTEM'
);

CREATE TYPE "SecurityAuditEventType" AS ENUM (
    'MEMBER_SUSPENDED',
    'MEMBER_REACTIVATED',
    'MEMBER_REMOVED',
    'MEMBER_ROLE_CHANGED',
    'OWNERSHIP_TRANSFERRED',
    'OWNERSHIP_RECOVERED',
    'SESSION_REVOKED',
    'ALL_SESSIONS_REVOKED',
    'ORGANISATION_SUSPENDED',
    'ORGANISATION_REACTIVATED',
    'ORGANISATION_CLOSED',
    'INVITE_REVOKED'
);

ALTER TABLE "Organisation"
    ADD COLUMN "lifecycleStatus" "OrganisationLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
    ADD COLUMN "lifecycleVersion" INTEGER;

UPDATE "Organisation"
SET "lifecycleChangedAt" = "createdAt",
    "lifecycleVersion" = 1;

ALTER TABLE "Organisation"
    ALTER COLUMN "lifecycleChangedAt" SET NOT NULL,
    ALTER COLUMN "lifecycleChangedAt" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "lifecycleVersion" SET NOT NULL,
    ALTER COLUMN "lifecycleVersion" SET DEFAULT 1,
    ADD CONSTRAINT "Organisation_lifecycleVersion_check"
        CHECK ("lifecycleVersion" >= 1);

ALTER TABLE "User"
    ADD COLUMN "lifecycleStatus" "UserLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "membershipChangedAt" TIMESTAMP(3),
    ADD COLUMN "membershipVersion" INTEGER;

UPDATE "User"
SET "membershipChangedAt" = "createdAt",
    "membershipVersion" = 1;

ALTER TABLE "User"
    ALTER COLUMN "membershipChangedAt" SET NOT NULL,
    ALTER COLUMN "membershipChangedAt" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "membershipVersion" SET NOT NULL,
    ALTER COLUMN "membershipVersion" SET DEFAULT 1,
    ADD CONSTRAINT "User_membershipVersion_check"
        CHECK ("membershipVersion" >= 1),
    ADD CONSTRAINT "User_owner_must_be_active_check"
        CHECK (
            "role" <> 'OWNER'::"UserRole"
            OR "lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
        );

ALTER TABLE "AuthSession"
    ADD COLUMN "familyId" UUID,
    ADD COLUMN "familyCreatedAt" TIMESTAMP(3),
    ADD COLUMN "deviceLabel" TEXT,
    ADD COLUMN "revocationReason" "AuthSessionRevocationReason";

UPDATE "AuthSession"
SET "familyId" = gen_random_uuid(),
    "familyCreatedAt" = "createdAt",
    "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP),
    "revocationReason" = 'LEGACY_UNSPECIFIED'::"AuthSessionRevocationReason";

ALTER TABLE "AuthSession"
    ALTER COLUMN "familyId" SET NOT NULL,
    ALTER COLUMN "familyId" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "familyCreatedAt" SET NOT NULL,
    ALTER COLUMN "familyCreatedAt" SET DEFAULT CURRENT_TIMESTAMP,
    ADD CONSTRAINT "AuthSession_revocation_tuple_check"
        CHECK (
            ("revokedAt" IS NULL AND "revocationReason" IS NULL)
            OR
            ("revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
        ),
    ADD CONSTRAINT "AuthSession_deviceLabel_check"
        CHECK (
            "deviceLabel" IS NULL
            OR (
                "deviceLabel" = BTRIM("deviceLabel")
                AND CHAR_LENGTH("deviceLabel") BETWEEN 1 AND 120
                AND "deviceLabel" !~ '[[:cntrl:]]'
            )
        ),
    ADD CONSTRAINT "AuthSession_family_timeline_check"
        CHECK ("familyCreatedAt" <= "createdAt");

ALTER TABLE "TeamInvite"
    ADD CONSTRAINT "TeamInvite_non_owner_role_check"
        CHECK ("role" <> 'OWNER'::"UserRole"),
    ADD CONSTRAINT "TeamInvite_terminal_state_check"
        CHECK (NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL));

CREATE TABLE "SecurityAuditEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "type" "SecurityAuditEventType" NOT NULL,
    "actorKind" "SecurityAuditActorKind" NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "subjectSessionId" TEXT,
    "reason" TEXT NOT NULL,
    "context" JSONB,
    "requestId" TEXT,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecurityAuditEvent_evidence_check" CHECK (
        "actorLabel" = BTRIM("actorLabel")
        AND CHAR_LENGTH("actorLabel") BETWEEN 1 AND 160
        AND "actorLabel" !~ '[[:cntrl:]]'
        AND "reason" = BTRIM("reason", ' ' || CHR(10))
        AND CHAR_LENGTH("reason") BETWEEN 1 AND 500
        AND REPLACE("reason", CHR(10), '') !~ '[[:cntrl:]]'
        AND (
            "requestId" IS NULL
            OR (
                "requestId" = BTRIM("requestId")
                AND CHAR_LENGTH("requestId") BETWEEN 1 AND 128
                AND "requestId" !~ '[[:cntrl:]]'
            )
        )
        AND (
            "subjectSessionId" IS NULL
            OR (
                "subjectSessionId" = BTRIM("subjectSessionId")
                AND CHAR_LENGTH("subjectSessionId") BETWEEN 1 AND 160
                AND "subjectSessionId" !~ '[[:cntrl:]]'
            )
        )
        AND (
            "context" IS NULL
            OR (
                JSONB_TYPEOF("context") = 'object'
                AND OCTET_LENGTH("context"::TEXT) <= 8192
            )
        )
        AND "eventVersion" = 1
    ),
    CONSTRAINT "SecurityAuditEvent_actor_check" CHECK (
        ("actorKind" = 'USER'::"SecurityAuditActorKind" AND "actorUserId" IS NOT NULL)
        OR
        ("actorKind" IN (
            'SUPPORT'::"SecurityAuditActorKind",
            'SYSTEM'::"SecurityAuditActorKind"
        ) AND "actorUserId" IS NULL)
    ),
    CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (
        (
            "type" IN (
                'MEMBER_SUSPENDED'::"SecurityAuditEventType",
                'MEMBER_REACTIVATED'::"SecurityAuditEventType",
                'MEMBER_REMOVED'::"SecurityAuditEventType",
                'MEMBER_ROLE_CHANGED'::"SecurityAuditEventType",
                'OWNERSHIP_TRANSFERRED'::"SecurityAuditEventType",
                'OWNERSHIP_RECOVERED'::"SecurityAuditEventType",
                'SESSION_REVOKED'::"SecurityAuditEventType",
                'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType"
            )
            AND "subjectUserId" IS NOT NULL
        )
        OR
        (
            "type" IN (
                'ORGANISATION_SUSPENDED'::"SecurityAuditEventType",
                'ORGANISATION_REACTIVATED'::"SecurityAuditEventType",
                'ORGANISATION_CLOSED'::"SecurityAuditEventType",
                'INVITE_REVOKED'::"SecurityAuditEventType"
            )
        )
    ),
    CONSTRAINT "SecurityAuditEvent_session_subject_check" CHECK (
        ("type" = 'SESSION_REVOKED'::"SecurityAuditEventType" AND "subjectSessionId" IS NOT NULL)
        OR
        ("type" <> 'SESSION_REVOKED'::"SecurityAuditEventType" AND "subjectSessionId" IS NULL)
    )
);

ALTER TABLE "SecurityAuditEvent"
    ADD CONSTRAINT "SecurityAuditEvent_organisationId_fkey"
        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "SecurityAuditEvent_actorUserId_organisationId_fkey"
        FOREIGN KEY ("actorUserId", "organisationId")
        REFERENCES "User"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "SecurityAuditEvent_subjectUserId_organisationId_fkey"
        FOREIGN KEY ("subjectUserId", "organisationId")
        REFERENCES "User"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "User_one_active_owner_per_organisation"
    ON "User" ("organisationId")
    WHERE "role" = 'OWNER'::"UserRole"
      AND "lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus";

CREATE UNIQUE INDEX "AuthSession_one_active_session_per_family"
    ON "AuthSession" ("familyId")
    WHERE "revokedAt" IS NULL;

CREATE INDEX "User_organisationId_lifecycleStatus_role_id_idx"
    ON "User"("organisationId", "lifecycleStatus", "role", "id");
CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_id_idx"
    ON "AuthSession"("userId", "revokedAt", "expiresAt", "id");
CREATE INDEX "AuthSession_userId_familyCreatedAt_familyId_idx"
    ON "AuthSession"("userId", "familyCreatedAt", "familyId");
CREATE INDEX "SecurityAuditEvent_organisationId_occurredAt_id_idx"
    ON "SecurityAuditEvent"("organisationId", "occurredAt", "id");
CREATE INDEX "SecurityAuditEvent_organisationId_subjectUserId_occurredAt_id_idx"
    ON "SecurityAuditEvent"("organisationId", "subjectUserId", "occurredAt", "id");
CREATE INDEX "SecurityAuditEvent_organisationId_actorUserId_occurredAt_id_idx"
    ON "SecurityAuditEvent"("organisationId", "actorUserId", "occurredAt", "id");

CREATE FUNCTION "manage_organisation_lifecycle_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."lifecycleVersion" <> 1 THEN
            RAISE EXCEPTION 'Organisation lifecycleVersion must start at 1'
                USING ERRCODE = '23514';
        END IF;
        NEW."lifecycleChangedAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id" THEN
        RAISE EXCEPTION 'Organisation identity is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus" THEN
        IF OLD."lifecycleStatus" = 'CLOSED'::"OrganisationLifecycleStatus" THEN
            RAISE EXCEPTION 'Closed organisations cannot be reactivated or suspended'
                USING ERRCODE = '23514';
        END IF;

        IF NEW."lifecycleVersion" IS DISTINCT FROM OLD."lifecycleVersion"
           OR NEW."lifecycleChangedAt" IS DISTINCT FROM OLD."lifecycleChangedAt" THEN
            RAISE EXCEPTION 'Organisation lifecycle evidence is database-managed'
                USING ERRCODE = '23514';
        END IF;

        NEW."lifecycleVersion" := OLD."lifecycleVersion" + 1;
        NEW."lifecycleChangedAt" := CURRENT_TIMESTAMP;
    ELSIF NEW."lifecycleVersion" IS DISTINCT FROM OLD."lifecycleVersion"
       OR NEW."lifecycleChangedAt" IS DISTINCT FROM OLD."lifecycleChangedAt" THEN
        RAISE EXCEPTION 'Organisation lifecycle evidence is database-managed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "Organisation_manage_lifecycle_version"
    BEFORE INSERT OR UPDATE ON "Organisation"
    FOR EACH ROW EXECUTE FUNCTION "manage_organisation_lifecycle_version"();

CREATE FUNCTION "manage_user_membership_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."membershipVersion" <> 1 THEN
            RAISE EXCEPTION 'User membershipVersion must start at 1'
                USING ERRCODE = '23514';
        END IF;
        NEW."membershipChangedAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;

    IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId" THEN
        RAISE EXCEPTION 'User organisation membership is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."lifecycleStatus" = 'REMOVED'::"UserLifecycleStatus"
       AND (
           NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
           OR NEW."role" IS DISTINCT FROM OLD."role"
       ) THEN
        RAISE EXCEPTION 'Removed memberships are terminal and immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."role" IS DISTINCT FROM OLD."role"
       OR NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus" THEN
        IF NEW."membershipVersion" IS DISTINCT FROM OLD."membershipVersion"
           OR NEW."membershipChangedAt" IS DISTINCT FROM OLD."membershipChangedAt" THEN
            RAISE EXCEPTION 'User membership evidence is database-managed'
                USING ERRCODE = '23514';
        END IF;

        NEW."membershipVersion" := OLD."membershipVersion" + 1;
        NEW."membershipChangedAt" := CURRENT_TIMESTAMP;
    ELSIF NEW."membershipVersion" IS DISTINCT FROM OLD."membershipVersion"
       OR NEW."membershipChangedAt" IS DISTINCT FROM OLD."membershipChangedAt" THEN
        RAISE EXCEPTION 'User membership evidence is database-managed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "User_manage_membership_version"
    BEFORE INSERT OR UPDATE ON "User"
    FOR EACH ROW EXECUTE FUNCTION "manage_user_membership_version"();

CREATE FUNCTION "assert_exactly_one_active_owner"(target_organisation_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    owner_count INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Organisation" WHERE "id" = target_organisation_id
    ) THEN
        RETURN;
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO owner_count
    FROM "User"
    WHERE "organisationId" = target_organisation_id
      AND "role" = 'OWNER'::"UserRole"
      AND "lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus";

    IF owner_count <> 1 THEN
        RAISE EXCEPTION
            'Organisation % must have exactly one active owner; found %',
            target_organisation_id,
            owner_count
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION "enforce_user_owner_continuity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "assert_exactly_one_active_owner"(OLD."organisationId");
    ELSIF TG_OP = 'INSERT' THEN
        PERFORM "assert_exactly_one_active_owner"(NEW."organisationId");
    ELSE
        PERFORM "assert_exactly_one_active_owner"(OLD."organisationId");
        IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId" THEN
            PERFORM "assert_exactly_one_active_owner"(NEW."organisationId");
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "User_exactly_one_active_owner"
    AFTER INSERT OR UPDATE OR DELETE ON "User"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_user_owner_continuity"();

CREATE FUNCTION "enforce_organisation_owner_continuity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN
        PERFORM "assert_exactly_one_active_owner"(NEW."id");
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Organisation_exactly_one_active_owner"
    AFTER INSERT OR UPDATE OR DELETE ON "Organisation"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_organisation_owner_continuity"();

CREATE FUNCTION "guard_auth_session_principal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_organisation_id TEXT;
    organisation_status "OrganisationLifecycleStatus";
    user_status "UserLifecycleStatus";
    existing_family_user_id TEXT;
    existing_family_created_at TIMESTAMP(3);
BEGIN
    SELECT "organisationId"
    INTO target_organisation_id
    FROM "User"
    WHERE "id" = NEW."userId";

    IF target_organisation_id IS NULL THEN
        RAISE EXCEPTION 'Auth session user does not exist'
            USING ERRCODE = '23503';
    END IF;

    SELECT "lifecycleStatus"
    INTO organisation_status
    FROM "Organisation"
    WHERE "id" = target_organisation_id
    FOR SHARE;

    SELECT "lifecycleStatus"
    INTO user_status
    FROM "User"
    WHERE "id" = NEW."userId"
      AND "organisationId" = target_organisation_id
    FOR SHARE;

    IF organisation_status IS DISTINCT FROM 'ACTIVE'::"OrganisationLifecycleStatus"
       OR user_status IS DISTINCT FROM 'ACTIVE'::"UserLifecycleStatus" THEN
        RAISE EXCEPTION 'Auth sessions require an active organisation and active user'
            USING ERRCODE = '23514';
    END IF;

    SELECT "userId", "familyCreatedAt"
    INTO existing_family_user_id, existing_family_created_at
    FROM "AuthSession"
    WHERE "familyId" = NEW."familyId"
    ORDER BY "id"
    LIMIT 1
    FOR SHARE;

    IF existing_family_user_id IS NOT NULL
       AND (
           existing_family_user_id IS DISTINCT FROM NEW."userId"
           OR existing_family_created_at IS DISTINCT FROM NEW."familyCreatedAt"
       ) THEN
        RAISE EXCEPTION 'Auth session family identity is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthSession_active_principal_insert"
    BEFORE INSERT ON "AuthSession"
    FOR EACH ROW EXECUTE FUNCTION "guard_auth_session_principal"();

CREATE FUNCTION "guard_auth_session_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."refreshTokenHash" IS DISTINCT FROM OLD."refreshTokenHash"
       OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
       OR NEW."familyCreatedAt" IS DISTINCT FROM OLD."familyCreatedAt"
       OR NEW."deviceLabel" IS DISTINCT FROM OLD."deviceLabel"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Auth session identity and expiry evidence are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."revokedAt" IS NOT NULL
       AND (
           NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
           OR NEW."revocationReason" IS DISTINCT FROM OLD."revocationReason"
       ) THEN
        RAISE EXCEPTION 'Auth session revocation evidence is immutable once recorded'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthSession_immutable_identity_and_revocation"
    BEFORE UPDATE ON "AuthSession"
    FOR EACH ROW EXECUTE FUNCTION "guard_auth_session_update"();

CREATE FUNCTION "reject_security_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Security audit events are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "SecurityAuditEvent_append_only"
    BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"
    FOR EACH ROW EXECUTE FUNCTION "reject_security_audit_mutation"();

CREATE FUNCTION "reject_user_hard_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'User memberships must be removed through the auditable lifecycle workflow'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "User_soft_removal_only"
    BEFORE DELETE ON "User"
    FOR EACH ROW EXECUTE FUNCTION "reject_user_hard_delete"();

COMMIT;
