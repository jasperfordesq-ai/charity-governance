-- The platform operator realm learns what kind of client is holding it, and
-- gets its own approvals.
--
-- Two things are being fixed here.
--
-- First, "PlatformOperatorSession" carried no posture at all: a token hash, an
-- expiry and a revocation. The charity side learned the hard way that a session
-- has to know what kind of client minted it, or a credential stolen from one
-- surface works on the other. The operator realm is the surface where that
-- matters most, because an operator session reaches every tenant.
--
-- Second, "AuthActionApproval" cannot be reused for operator actions. It is
-- bound to an organisation twice over — once by "organisationId" and again by
-- the composite foreign key on ("userId", "organisationId") — and an operator
-- is not a "User" and belongs to no organisation. Generalising it would mean
-- two nullable identity columns and a check constraint saying exactly one is
-- set, which is a branching invariant on the single most security-sensitive
-- row in the product. A second, thin table keeps both invariants simple.
--
-- Deliberately NO dataScope column. The charity session has one because a
-- charity session can see personal data. The operator realm exposes none: its
-- tenant summary selects a user COUNT, never users. A flag that never does
-- anything would suggest the rule is configurable. Its absence says it is not.
BEGIN;

-- CreateEnum
CREATE TYPE "OperatorSessionClientKind" AS ENUM ('WEB', 'MCP_CONNECTOR');

-- CreateEnum
CREATE TYPE "OperatorSessionAccessLevel" AS ENUM ('READ', 'WRITE', 'ADMIN');

-- AlterTable
-- Additive with defaults, so the colour still serving traffic keeps working:
-- every session it minted reads back as a WEB session with ADMIN authority,
-- which is exactly what it was.
ALTER TABLE "PlatformOperatorSession"
    ADD COLUMN "clientKind" "OperatorSessionClientKind" NOT NULL DEFAULT 'WEB',
    ADD COLUMN "accessLevel" "OperatorSessionAccessLevel" NOT NULL DEFAULT 'ADMIN',
    -- A family, for the same reason the charity side has one: rotation mints a
    -- new row on every refresh, so an approval bound to the row id is dead
    -- before anyone can type a password. That was a real bug, fixed in
    -- 20260920010000, and there is no reason to learn it twice.
    ADD COLUMN "familyId" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "familyCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "PlatformOperatorSession_familyId_idx"
    ON "PlatformOperatorSession"("familyId");

-- CreateTable
CREATE TABLE "OperatorActionApproval" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    -- The session FAMILY that asked, not the session row. See above.
    "sessionFamilyId" UUID NOT NULL,
    -- SHA-256 over family, method, path and canonical body.
    "requestDigest" TEXT NOT NULL,
    -- Built by the API from the route it matched, never from the request body:
    -- a summary the caller can write is a summary the caller can lie in.
    "summary" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "routePattern" TEXT NOT NULL,
    -- The tenant the action is about, when the route names one. Held so the
    -- person approving sees WHICH charity they are about to close. Not a
    -- foreign key: an approval is evidence of what was asked, and it must
    -- survive the tenant row it refers to.
    "resourceId" TEXT,
    -- The tenant's name as it read when the approval was minted. A person
    -- approving the closure of a charity should see its name, and resolving it
    -- at approval time would show whatever the name says by then.
    "resourceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "OperatorActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperatorActionApproval_id_operatorId_key"
    ON "OperatorActionApproval"("id", "operatorId");

-- CreateIndex
CREATE INDEX "OperatorActionApproval_family_digest_idx"
    ON "OperatorActionApproval"("sessionFamilyId", "requestDigest");

-- CreateIndex
CREATE INDEX "OperatorActionApproval_expiresAt_idx"
    ON "OperatorActionApproval"("expiresAt");

-- AddForeignKey
-- RESTRICT rather than CASCADE: deleting an operator must not silently take
-- the record of what they approved with it.
ALTER TABLE "OperatorActionApproval"
    ADD CONSTRAINT "OperatorActionApproval_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The same two invariants the charity approvals carry, for the same reason:
-- this row is the thing standing between an agent and a closed charity, so it
-- is enforced by the database and not only by the code that writes it.
ALTER TABLE "OperatorActionApproval"
    ADD CONSTRAINT "OperatorActionApproval_consumed_implies_approved_check"
    CHECK ("consumedAt" IS NULL OR "approvedAt" IS NOT NULL);

ALTER TABLE "OperatorActionApproval"
    ADD CONSTRAINT "OperatorActionApproval_approved_before_expiry_check"
    CHECK ("approvedAt" IS NULL OR "approvedAt" <= "expiresAt");

-- At most one live approval per family and digest, so an agent cannot ask
-- repeatedly for the same action, collect several approvals from one
-- distracted person, and spend them one after another.
CREATE UNIQUE INDEX "OperatorActionApproval_live_family_digest_key"
    ON "OperatorActionApproval"("sessionFamilyId", "requestDigest")
    WHERE "consumedAt" IS NULL;

-- Guard the data, not the route.
--
-- Eleven guards in this codebase have been found correct and covered by a test
-- that would have passed just as happily if the guard were deleted. The two
-- rules below are therefore in the database, where no route can forget them:
--
--   1. A session family is pinned to one operator, one creation instant and
--      one posture. A rotation that forgets to carry the posture forward fails
--      the insert rather than quietly restoring a read-only session to full
--      authority.
--   2. A connector session cannot exist for an operator with no second factor
--      enrolled. The login route checks this too, but the login route is a
--      route. This is the rule that holds when somebody writes a second one.
CREATE OR REPLACE FUNCTION "guard_platform_operator_session"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    operator_status "OperatorLifecycleStatus";
    operator_totp_enrolled_at TIMESTAMP(3);
    existing_family_operator_id TEXT;
    existing_family_created_at TIMESTAMP(3);
    existing_family_client_kind "OperatorSessionClientKind";
    existing_family_access_level "OperatorSessionAccessLevel";
BEGIN
    SELECT "lifecycleStatus", "totpEnrolledAt"
    INTO operator_status, operator_totp_enrolled_at
    FROM "PlatformOperator"
    WHERE "id" = NEW."operatorId"
    FOR SHARE;

    IF operator_status IS NULL THEN
        RAISE EXCEPTION 'Platform operator session operator does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF operator_status IS DISTINCT FROM 'ACTIVE'::"OperatorLifecycleStatus" THEN
        RAISE EXCEPTION 'Platform operator sessions require an active operator'
            USING ERRCODE = '23514';
    END IF;

    -- A credential an agent installs, which can close a charity, may not rest
    -- on a password alone.
    IF NEW."clientKind" = 'MCP_CONNECTOR'::"OperatorSessionClientKind"
       AND operator_totp_enrolled_at IS NULL THEN
        RAISE EXCEPTION 'A connector session requires an enrolled second factor'
            USING ERRCODE = '23514';
    END IF;

    SELECT "operatorId", "familyCreatedAt", "clientKind", "accessLevel"
    INTO existing_family_operator_id, existing_family_created_at,
         existing_family_client_kind, existing_family_access_level
    FROM "PlatformOperatorSession"
    WHERE "familyId" = NEW."familyId"
      AND "id" IS DISTINCT FROM NEW."id"
    ORDER BY "id"
    LIMIT 1
    FOR SHARE;

    IF existing_family_operator_id IS NOT NULL
       AND (
           existing_family_operator_id IS DISTINCT FROM NEW."operatorId"
           OR existing_family_created_at IS DISTINCT FROM NEW."familyCreatedAt"
       ) THEN
        RAISE EXCEPTION 'Platform operator session family identity is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    IF existing_family_operator_id IS NOT NULL
       AND (
           existing_family_client_kind IS DISTINCT FROM NEW."clientKind"
           OR existing_family_access_level IS DISTINCT FROM NEW."accessLevel"
       ) THEN
        RAISE EXCEPTION 'Platform operator session family posture is inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_platform_operator_session_trigger"
    BEFORE INSERT OR UPDATE ON "PlatformOperatorSession"
    FOR EACH ROW EXECUTE FUNCTION "guard_platform_operator_session"();

COMMIT;
