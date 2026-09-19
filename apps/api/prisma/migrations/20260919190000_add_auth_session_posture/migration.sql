-- Every auth session gains a posture: what kind of client it belongs to, and
-- how much that session may do. The posture is chosen once, by whoever typed
-- the password, and is immutable thereafter.
--
-- Defaults preserve today's behaviour exactly. Every existing row, and every
-- row inserted by code that does not yet know about these columns, is a web
-- session with full authority — which is what every session is today. Nothing
-- about the web application changes.
--
-- The defaults are also load-bearing for two writers outside the API that
-- insert into "AuthSession" with an explicit column list: e2e/helpers/db.ts
-- and scripts/verify-team-lifecycle-upgrade.mjs. Adding a column without a
-- default would break both, and the first of those has its column list pinned
-- by a regular expression in scripts/check-local-docker.test.mjs.
--
-- Both guard functions are replaced rather than dropped, so the triggers
-- installed by 20260711030000_add_team_lifecycle_security keep pointing at the
-- same names and that migration's file is left untouched — a test reads it
-- byte for byte.
--
-- Why the family guard matters more than the update guard: rotation mints a
-- NEW session row for the same family on every refresh, copying a handful of
-- fields. It already fails to copy deviceLabel, which is why no device label
-- has survived fifteen minutes since that column was added. A posture lost the
-- same way would not blank a label, it would silently restore the session to
-- full authority. Pinning the posture per family means a rotation that forgets
-- to copy it raises 23514 and the refresh fails, instead of succeeding with a
-- session wider than the one it replaced.
BEGIN;

-- AddEnum
CREATE TYPE "AuthSessionClientKind" AS ENUM ('WEB', 'MCP_CONNECTOR');

-- AddEnum
CREATE TYPE "AuthSessionAccessLevel" AS ENUM ('READ', 'WRITE', 'ADMIN');

-- AlterTable
-- One statement with defaults, deliberately not the add-nullable/backfill/
-- SET NOT NULL dance: PostgreSQL 11+ adds a defaulted NOT NULL column without
-- rewriting the table, and SET NOT NULL is a blocked rule in the blue-green
-- deploy gate.
ALTER TABLE "AuthSession"
    ADD COLUMN "clientKind" "AuthSessionClientKind" NOT NULL DEFAULT 'WEB'::"AuthSessionClientKind",
    ADD COLUMN "accessLevel" "AuthSessionAccessLevel" NOT NULL DEFAULT 'ADMIN'::"AuthSessionAccessLevel";

-- The web application has no way to ask for a narrowed session and no UI that
-- would explain one, so a narrowed web session could only arrive by accident.
-- This keeps that contract explicit until the web side is ready to relax it.
ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_web_is_admin_check"
        CHECK (
            "clientKind" <> 'WEB'::"AuthSessionClientKind"
            OR "accessLevel" = 'ADMIN'::"AuthSessionAccessLevel"
        );

-- Posture joins the immutable set. A session may be revoked, but it may never
-- be promoted: raising accessLevel on a live row would hand more authority to
-- a credential that is already in someone's hands.
CREATE OR REPLACE FUNCTION "guard_auth_session_update"()
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
       OR NEW."clientKind" IS DISTINCT FROM OLD."clientKind"
       OR NEW."accessLevel" IS DISTINCT FROM OLD."accessLevel"
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

-- A session family is already pinned to one user and one creation instant for
-- its whole lifetime. It is now pinned to one posture as well, so a successor
-- row cannot quietly differ from the row it replaces.
CREATE OR REPLACE FUNCTION "guard_auth_session_principal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_organisation_id TEXT;
    organisation_status "OrganisationLifecycleStatus";
    user_status "UserLifecycleStatus";
    existing_family_user_id TEXT;
    existing_family_created_at TIMESTAMP(3);
    existing_family_client_kind "AuthSessionClientKind";
    existing_family_access_level "AuthSessionAccessLevel";
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

    SELECT "userId", "familyCreatedAt", "clientKind", "accessLevel"
    INTO existing_family_user_id, existing_family_created_at,
         existing_family_client_kind, existing_family_access_level
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

    IF existing_family_user_id IS NOT NULL
       AND (
           existing_family_client_kind IS DISTINCT FROM NEW."clientKind"
           OR existing_family_access_level IS DISTINCT FROM NEW."accessLevel"
       ) THEN
        RAISE EXCEPTION 'Auth session family posture is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
