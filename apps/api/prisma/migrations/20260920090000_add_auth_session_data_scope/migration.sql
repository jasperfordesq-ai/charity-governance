-- A session now carries how much personal data it may see, beside what kind of
-- client it belongs to and how much it may do.
--
-- Until now that was a flag on the connector's command line:
-- `--allow-personal-data`, read from the AI client's own configuration file.
-- The connector already treats that file as something an attacker may write,
-- which is why a stored credential is bound to the host that issued it and
-- refuses to be sent anywhere else. The same file decided whether a trustee's
-- date of birth and home address could leave the building, and nothing but the
-- file was consulted. A coding agent that can edit it, or any process running
-- as the operator, could open the gate without anybody typing a password.
--
-- It is now chosen once, by whoever typed the password, and enforced where
-- every other limit is: on the session row.
--
-- The default is FULL, which is what every session is today, so nothing about
-- the web application changes and no existing row moves. The connector asks
-- for WITHHELD unless a person deliberately asks otherwise at sign-in, which
-- is the same default the flag had.
--
-- Both guard functions are replaced rather than dropped, so the triggers
-- installed by 20260711030000_add_team_lifecycle_security keep pointing at the
-- same names and that migration's file is left untouched — a test reads it
-- byte for byte.
BEGIN;

-- AddEnum
CREATE TYPE "AuthSessionDataScope" AS ENUM ('WITHHELD', 'FULL');

-- AlterTable
-- Defaulted and NOT NULL in one statement, for the reason the posture columns
-- were: PostgreSQL 11+ adds a defaulted NOT NULL column without rewriting the
-- table, and SET NOT NULL is a blocked rule in the blue-green deploy gate.
-- The default is also load-bearing for the writers outside the API that insert
-- into "AuthSession" with an explicit column list.
ALTER TABLE "AuthSession"
    ADD COLUMN "dataScope" "AuthSessionDataScope" NOT NULL DEFAULT 'FULL'::"AuthSessionDataScope";

-- The web application has no way to ask for a narrowed scope and no screen
-- that would explain one, so a narrowed web session could only arrive by
-- accident. This keeps that contract explicit until the web side is ready to
-- relax it, exactly as the access-level constraint beside it does.
ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_web_is_full_scope_check"
        CHECK (
            "clientKind" <> 'WEB'::"AuthSessionClientKind"
            OR "dataScope" = 'FULL'::"AuthSessionDataScope"
        );

-- The scope joins the immutable set. A live session may be revoked, but it may
-- never be widened: raising the scope on a row that is already in somebody's
-- hands would release personal data to a credential nobody re-authorised.
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
       OR NEW."dataScope" IS DISTINCT FROM OLD."dataScope"
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

-- A session family is pinned to one user, one creation instant and one
-- posture. The scope joins the posture: rotation mints a NEW row on every
-- refresh, and a successor that forgot to copy the scope would come back FULL
-- by default — the widest possible failure, and a silent one. Pinning it here
-- means such a rotation raises 23514 and the refresh fails instead.
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
    existing_family_data_scope "AuthSessionDataScope";
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

    SELECT "userId", "familyCreatedAt", "clientKind", "accessLevel", "dataScope"
    INTO existing_family_user_id, existing_family_created_at,
         existing_family_client_kind, existing_family_access_level,
         existing_family_data_scope
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
           OR existing_family_data_scope IS DISTINCT FROM NEW."dataScope"
       ) THEN
        RAISE EXCEPTION 'Auth session family posture is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
