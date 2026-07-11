BEGIN;

-- AddEnum
CREATE TYPE "DocumentStorageDeletionState" AS ENUM ('PENDING', 'DEAD_LETTER', 'PROCESSED');

-- AddEnum
CREATE TYPE "DocumentStorageDeletionTerminalReason" AS ENUM ('MAX_ATTEMPTS_EXHAUSTED', 'PERMANENT_STORAGE_PATH_REJECTED');

-- AddEnum
CREATE TYPE "DocumentStorageDeletionRecoveryActorType" AS ENUM ('TENANT_USER', 'PLATFORM_OPERATOR');

-- AddEnum
CREATE TYPE "DocumentStorageDeletionRecoveryDisposition" AS ENUM ('REQUEUE_UNCHANGED', 'REQUEUE_CORRECTED_PATH', 'COMPLETE_EXTERNALLY_REMEDIATED');

-- AlterTable
ALTER TABLE "DocumentStorageDeletion"
    ADD COLUMN "state" "DocumentStorageDeletionState" NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "deadLetteredAt" TIMESTAMP(3),
    ADD COLUMN "terminalReason" "DocumentStorageDeletionTerminalReason",
    ADD COLUMN "alertClaimToken" TEXT,
    ADD COLUMN "alertClaimedAt" TIMESTAMP(3),
    ADD COLUMN "alertedAt" TIMESTAMP(3),
    ADD COLUMN "lastRecoveryId" TEXT,
    ADD COLUMN "lastRecoveryNonce" TEXT,
    ADD COLUMN "lastRecoveryDisposition" "DocumentStorageDeletionRecoveryDisposition",
    ADD COLUMN "lastRecoveredAt" TIMESTAMP(3);

-- Existing rows become either completed evidence, eligible bounded retries, or
-- terminal evidence when the legacy unbounded worker already exhausted the new limit.
UPDATE "DocumentStorageDeletion"
SET
    "state" = 'PROCESSED',
    "nextAttemptAt" = NULL,
    "claimedAt" = NULL,
    "lastError" = NULL
WHERE "processedAt" IS NOT NULL;

UPDATE "DocumentStorageDeletion"
SET
    "state" = 'DEAD_LETTER',
    "lastAttemptAt" = COALESCE("updatedAt", "createdAt"),
    "nextAttemptAt" = NULL,
    "claimedAt" = NULL,
    "deadLetteredAt" = COALESCE("updatedAt", "createdAt"),
    "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED'
WHERE "processedAt" IS NULL
  AND "attempts" >= 5;

UPDATE "DocumentStorageDeletion"
SET
    "lastAttemptAt" = CASE WHEN "attempts" > 0 THEN COALESCE("updatedAt", "createdAt") ELSE NULL END,
    "nextAttemptAt" = COALESCE("updatedAt", "createdAt")
WHERE "state" = 'PENDING';

-- The legacy worker stored a bounded message per diagnostic field, but their
-- combined representation could exceed the new row-level evidence bound.
-- Normalize existing evidence before installing the constraint so a single
-- historical provider response cannot abort the production migration.
UPDATE "DocumentStorageDeletion"
SET "lastError" = left("lastError", 500)
WHERE "lastError" IS NOT NULL
  AND char_length("lastError") > 500;

-- CreateTable
CREATE TABLE "DocumentStorageDeletionRecovery" (
    "id" TEXT NOT NULL,
    "recoveryNonce" TEXT NOT NULL,
    "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
    "deletionId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "actorType" "DocumentStorageDeletionRecoveryActorType" NOT NULL,
    "actorUserId" TEXT,
    "operatorIdentity" TEXT,
    "reason" TEXT NOT NULL,
    "disposition" "DocumentStorageDeletionRecoveryDisposition" NOT NULL,
    "previousAttempts" INTEGER NOT NULL,
    "previousTerminalReason" "DocumentStorageDeletionTerminalReason" NOT NULL,
    "previousStoragePath" TEXT NOT NULL,
    "correctedStoragePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentStorageDeletionRecovery_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DocumentStorageDeletionRecovery"
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_deletionId_fkey"
    FOREIGN KEY ("deletionId") REFERENCES "DocumentStorageDeletion"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Safety constraints keep the retry state machine fail-closed even when an
-- application regression bypasses the normal service methods.
ALTER TABLE "DocumentStorageDeletion"
    ADD CONSTRAINT "DocumentStorageDeletion_attempts_nonnegative"
        CHECK ("attempts" >= 0),
    ADD CONSTRAINT "DocumentStorageDeletion_lastError_bounded"
        CHECK ("lastError" IS NULL OR char_length("lastError") <= 500),
    ADD CONSTRAINT "DocumentStorageDeletion_alert_claim_consistent"
        CHECK (("alertClaimToken" IS NULL) = ("alertClaimedAt" IS NULL)),
    ADD CONSTRAINT "DocumentStorageDeletion_last_recovery_binding_consistent"
        CHECK (
            ("lastRecoveryId" IS NULL
             AND "lastRecoveryNonce" IS NULL
             AND "lastRecoveryDisposition" IS NULL
             AND "lastRecoveredAt" IS NULL)
            OR
            ("lastRecoveryId" IS NOT NULL
             AND "lastRecoveryNonce" IS NOT NULL
             AND "lastRecoveryDisposition" IS NOT NULL
             AND "lastRecoveredAt" IS NOT NULL)
        ),
    ADD CONSTRAINT "DocumentStorageDeletion_last_recovery_binding_format"
        CHECK (
            "lastRecoveryId" IS NULL OR (
                char_length("lastRecoveryId") BETWEEN 1 AND 200
                AND "lastRecoveryNonce" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
        ),
    ADD CONSTRAINT "DocumentStorageDeletion_state_consistent"
        CHECK (
            (
                "state" = 'PENDING'
                AND "processedAt" IS NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NOT NULL
                AND "attempts" < 5
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
            ) OR (
                "state" = 'DEAD_LETTER'
                AND "processedAt" IS NULL
                AND "deadLetteredAt" IS NOT NULL
                AND "terminalReason" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "attempts" >= 1
            ) OR (
                "state" = 'PROCESSED'
                AND "processedAt" IS NOT NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "lastError" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
            )
        );

ALTER TABLE "DocumentStorageDeletionRecovery"
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_id_bounded"
        CHECK (char_length("id") BETWEEN 1 AND 200),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_nonce_format"
        CHECK ("recoveryNonce" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_previousAttempts_positive"
        CHECK ("previousAttempts" >= 1),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_reason_bounded"
        CHECK (
            "reason" = btrim("reason")
            AND char_length("reason") BETWEEN 10 AND 500
            AND replace("reason", E'\n', '') !~ '[[:cntrl:]]'
        ),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_actor_consistent"
        CHECK (
            ("actorType" = 'TENANT_USER' AND "actorUserId" IS NOT NULL AND "operatorIdentity" IS NULL)
            OR
            ("actorType" = 'PLATFORM_OPERATOR'
             AND "actorUserId" IS NULL
             AND "operatorIdentity" = btrim("operatorIdentity")
             AND char_length("operatorIdentity") BETWEEN 3 AND 160
             AND "operatorIdentity" !~ '[[:cntrl:]]'
             AND "operatorIdentity" !~ '[@:/\\]'
             AND lower("operatorIdentity") NOT IN ('admin', 'administrator', 'operator', 'system', 'unknown'))
        ),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_actor_disposition_authorized"
        CHECK ("actorType" = 'PLATFORM_OPERATOR' OR "disposition" = 'REQUEUE_UNCHANGED'),
    ADD CONSTRAINT "DocumentStorageDeletionRecovery_path_disposition_consistent"
        CHECK (
            ("disposition" = 'REQUEUE_CORRECTED_PATH'
             AND "correctedStoragePath" IS NOT NULL
             AND "correctedStoragePath" = btrim("correctedStoragePath")
             AND char_length("correctedStoragePath") <= 1024
             AND "correctedStoragePath" !~ '[[:cntrl:]]'
             AND "correctedStoragePath" <> "previousStoragePath")
            OR
            ("disposition" <> 'REQUEUE_CORRECTED_PATH' AND "correctedStoragePath" IS NULL)
        );

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_state_nextAttemptAt_claimedAt_createdAt_idx"
    ON "DocumentStorageDeletion"("state", "nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_state_alertedAt_alertClaimedAt_deadLetteredAt_idx"
    ON "DocumentStorageDeletion"("state", "alertedAt", "alertClaimedAt", "deadLetteredAt");

-- CreateIndex
CREATE INDEX "DocumentStorageDeletion_organisationId_state_deadLetteredAt_idx"
    ON "DocumentStorageDeletion"("organisationId", "state", "deadLetteredAt");

-- CreateIndex
CREATE INDEX "DocumentStorageDeletionRecovery_deletionId_createdAt_idx"
    ON "DocumentStorageDeletionRecovery"("deletionId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentStorageDeletionRecovery_organisationId_createdAt_idx"
    ON "DocumentStorageDeletionRecovery"("organisationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentStorageDeletionRecovery_recoveryNonce_key"
    ON "DocumentStorageDeletionRecovery"("recoveryNonce");

CREATE OR REPLACE FUNCTION "validate_document_storage_deletion_recovery"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The application supplies a high-entropy nonce. The database supplies the
    -- transaction identity and never accepts a caller-selected transaction id.
    NEW."transactionId" := txid_current();

    -- Uploads take the same tenant row lock before creating a storage object.
    -- Taking it first here makes direct-SQL recovery obey that serialization
    -- boundary too. Tenant recovery fails closed if the claimed tenant no
    -- longer exists; a named platform operator may still recover intentionally
    -- retained deletion evidence after tenant deletion.
    PERFORM 1
    FROM "Organisation" organisation
    WHERE organisation."id" = NEW."organisationId"
    FOR UPDATE;

    IF NOT FOUND AND NEW."actorType" <> 'PLATFORM_OPERATOR' THEN
        RAISE EXCEPTION 'Document storage deletion recovery organisation does not exist';
    END IF;

    -- Keep the dead letter stable between audit-event insertion and its bound
    -- state transition, including for direct SQL operator recovery.
    PERFORM 1
    FROM "DocumentStorageDeletion" deletion
    WHERE deletion."id" = NEW."deletionId"
      AND deletion."organisationId" = NEW."organisationId"
      AND deletion."state" = 'DEAD_LETTER'
      AND deletion."attempts" = NEW."previousAttempts"
      AND deletion."terminalReason" = NEW."previousTerminalReason"
      AND deletion."storagePath" = NEW."previousStoragePath"
      AND deletion."alertClaimToken" IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Document storage deletion recovery does not match an unclaimed tenant dead letter';
    END IF;

    IF NEW."actorType" = 'TENANT_USER' AND NOT EXISTS (
            SELECT 1
            FROM "User" actor
            WHERE actor."id" = NEW."actorUserId"
              AND actor."organisationId" = NEW."organisationId"
              AND actor."role" IN ('OWNER', 'ADMIN')
              AND actor."lifecycleStatus" = 'ACTIVE'
        ) THEN
        RAISE EXCEPTION 'Document storage deletion recovery requires an active tenant owner or administrator';
    END IF;

    IF NEW."actorType" = 'TENANT_USER' AND NEW."disposition" <> 'REQUEUE_UNCHANGED' THEN
        RAISE EXCEPTION 'Corrected-path and external completion dispositions require platform operations';
    END IF;

    IF NEW."actorType" = 'PLATFORM_OPERATOR' AND (
        NEW."operatorIdentity" IS NULL
        OR char_length(btrim(NEW."operatorIdentity")) NOT BETWEEN 3 AND 160
    ) THEN
        RAISE EXCEPTION 'Document storage deletion recovery requires a named platform operator';
    END IF;

    IF NEW."disposition" = 'REQUEUE_CORRECTED_PATH' AND (
        NEW."correctedStoragePath" IS NULL
        OR left(NEW."correctedStoragePath", char_length(NEW."organisationId") + 1) <> NEW."organisationId" || '/'
        OR right(NEW."correctedStoragePath", 1) = '/'
        OR position('//' in NEW."correctedStoragePath") > 0
        OR position(E'\\\\' in NEW."correctedStoragePath") > 0
        OR NEW."correctedStoragePath" ~ '(^|/)(\\.|\\.\\.)($|/)'
        OR EXISTS (
            SELECT 1 FROM "Document" document
            WHERE document."fileUrl" = NEW."correctedStoragePath"
        )
        OR EXISTS (
            SELECT 1 FROM "DocumentStorageDeletion" other_deletion
            WHERE other_deletion."id" <> NEW."deletionId"
              AND other_deletion."storagePath" = NEW."correctedStoragePath"
        )
    ) THEN
        RAISE EXCEPTION 'Corrected document storage path is not safely scoped to the tenant';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentStorageDeletionRecovery_validate"
    BEFORE INSERT ON "DocumentStorageDeletionRecovery"
    FOR EACH ROW EXECUTE FUNCTION "validate_document_storage_deletion_recovery"();

CREATE OR REPLACE FUNCTION "guard_document_storage_deletion_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    recovery "DocumentStorageDeletionRecovery"%ROWTYPE;
    recovery_transition BOOLEAN := OLD."state" = 'DEAD_LETTER' AND NEW."state" IN ('PENDING', 'PROCESSED');
    corrected_path_transition BOOLEAN := FALSE;
BEGIN
    IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Document storage deletion identity is immutable';
    END IF;

    IF OLD."state" = 'PROCESSED' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Processed document storage deletions are terminal';
    END IF;

    IF NOT recovery_transition AND (
        NEW."lastRecoveryId" IS DISTINCT FROM OLD."lastRecoveryId"
        OR NEW."lastRecoveryNonce" IS DISTINCT FROM OLD."lastRecoveryNonce"
        OR NEW."lastRecoveryDisposition" IS DISTINCT FROM OLD."lastRecoveryDisposition"
        OR NEW."lastRecoveredAt" IS DISTINCT FROM OLD."lastRecoveredAt"
    ) THEN
        RAISE EXCEPTION 'Document storage deletion recovery binding is immutable outside exact dead-letter recovery';
    END IF;

    IF recovery_transition THEN
        SELECT candidate.*
        INTO recovery
        FROM "DocumentStorageDeletionRecovery" candidate
        WHERE candidate."id" = NEW."lastRecoveryId"
          AND candidate."recoveryNonce" = NEW."lastRecoveryNonce"
          AND candidate."transactionId" = txid_current()
          AND candidate."deletionId" = OLD."id"
          AND candidate."organisationId" = OLD."organisationId"
          AND candidate."previousAttempts" = OLD."attempts"
          AND candidate."previousTerminalReason" = OLD."terminalReason"
          AND candidate."previousStoragePath" = OLD."storagePath"
          AND candidate."disposition" = NEW."lastRecoveryDisposition";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Dead-letter recovery requires an exact immutable event from the current transaction';
        END IF;

        IF NEW."lastRecoveredAt" IS NULL THEN
            RAISE EXCEPTION 'Dead-letter recovery requires a persistent recovery binding';
        END IF;

        IF NEW."state" = 'PENDING' THEN
            IF recovery."disposition" NOT IN ('REQUEUE_UNCHANGED', 'REQUEUE_CORRECTED_PATH') THEN
                RAISE EXCEPTION 'Pending recovery disposition is not permitted';
            END IF;
            IF OLD."terminalReason" = 'PERMANENT_STORAGE_PATH_REJECTED'
               AND recovery."disposition" = 'REQUEUE_UNCHANGED' THEN
                RAISE EXCEPTION 'A permanently rejected storage path cannot be requeued unchanged';
            END IF;
            corrected_path_transition := recovery."disposition" = 'REQUEUE_CORRECTED_PATH';
            IF corrected_path_transition AND NEW."storagePath" IS DISTINCT FROM recovery."correctedStoragePath" THEN
                RAISE EXCEPTION 'Corrected-path recovery does not match its immutable event';
            END IF;
            IF NOT corrected_path_transition AND NEW."storagePath" IS DISTINCT FROM OLD."storagePath" THEN
                RAISE EXCEPTION 'Unchanged recovery cannot replace the storage path';
            END IF;
            IF NEW."attempts" <> 0
               OR NEW."lastError" IS NOT NULL
               OR NEW."lastAttemptAt" IS NOT NULL
               OR NEW."deadLetteredAt" IS NOT NULL
               OR NEW."terminalReason" IS NOT NULL
               OR NEW."nextAttemptAt" IS NULL
               OR NEW."claimedAt" IS NOT NULL
               OR NEW."processedAt" IS NOT NULL
               OR NEW."alertClaimToken" IS NOT NULL
               OR NEW."alertClaimedAt" IS NOT NULL
               OR NEW."alertedAt" IS NOT NULL THEN
                RAISE EXCEPTION 'Dead-letter requeue must reset bounded retry and alert state';
            END IF;
        ELSE
            IF recovery."disposition" <> 'COMPLETE_EXTERNALLY_REMEDIATED' THEN
                RAISE EXCEPTION 'External completion requires its explicit audited disposition';
            END IF;
            IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath"
               OR NEW."processedAt" IS NULL
               OR NEW."nextAttemptAt" IS NOT NULL
               OR NEW."claimedAt" IS NOT NULL
               OR NEW."deadLetteredAt" IS NOT NULL
               OR NEW."terminalReason" IS NOT NULL
               OR NEW."lastError" IS NOT NULL
               OR NEW."alertClaimToken" IS NOT NULL
               OR NEW."alertClaimedAt" IS NOT NULL
               OR NEW."alertedAt" IS NOT NULL THEN
                RAISE EXCEPTION 'Externally remediated completion must be terminal and preserve storage identity';
            END IF;
        END IF;
    END IF;

    IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath" AND NOT corrected_path_transition THEN
        RAISE EXCEPTION 'Document storage deletion identity is immutable outside audited corrected-path recovery';
    END IF;

    IF OLD."state" = 'PENDING' AND NEW."state" NOT IN ('PENDING', 'DEAD_LETTER', 'PROCESSED') THEN
        RAISE EXCEPTION 'Document storage deletion pending transition is not permitted';
    END IF;

    IF OLD."state" = 'DEAD_LETTER' AND NEW."state" = 'DEAD_LETTER' AND (
        NEW."attempts" IS DISTINCT FROM OLD."attempts"
        OR NEW."lastError" IS DISTINCT FROM OLD."lastError"
        OR NEW."lastAttemptAt" IS DISTINCT FROM OLD."lastAttemptAt"
        OR NEW."nextAttemptAt" IS DISTINCT FROM OLD."nextAttemptAt"
        OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
        OR NEW."deadLetteredAt" IS DISTINCT FROM OLD."deadLetteredAt"
        OR NEW."terminalReason" IS DISTINCT FROM OLD."terminalReason"
        OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
        OR NEW."lastRecoveryId" IS DISTINCT FROM OLD."lastRecoveryId"
        OR NEW."lastRecoveryNonce" IS DISTINCT FROM OLD."lastRecoveryNonce"
        OR NEW."lastRecoveryDisposition" IS DISTINCT FROM OLD."lastRecoveryDisposition"
        OR NEW."lastRecoveredAt" IS DISTINCT FROM OLD."lastRecoveredAt"
    ) THEN
        RAISE EXCEPTION 'Dead-letter evidence is immutable outside alert acknowledgement and recovery';
    END IF;

    IF OLD."state" = 'DEAD_LETTER' AND NEW."state" NOT IN ('DEAD_LETTER', 'PENDING', 'PROCESSED') THEN
        RAISE EXCEPTION 'Document storage deletion dead-letter transition is not permitted';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentStorageDeletion_guard_update"
    BEFORE UPDATE ON "DocumentStorageDeletion"
    FOR EACH ROW EXECUTE FUNCTION "guard_document_storage_deletion_update"();

CREATE OR REPLACE FUNCTION "guard_document_storage_deletion_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."lastRecoveryId" IS NOT NULL
       OR NEW."lastRecoveryNonce" IS NOT NULL
       OR NEW."lastRecoveryDisposition" IS NOT NULL
       OR NEW."lastRecoveredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'New document storage deletions cannot fabricate recovery bindings';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentStorageDeletion_guard_insert"
    BEFORE INSERT ON "DocumentStorageDeletion"
    FOR EACH ROW EXECUTE FUNCTION "guard_document_storage_deletion_insert"();

CREATE OR REPLACE FUNCTION "document_storage_deletion_evidence_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Document storage deletion recovery evidence is append-only';
END;
$$;

CREATE TRIGGER "DocumentStorageDeletionRecovery_append_only"
    BEFORE UPDATE OR DELETE ON "DocumentStorageDeletionRecovery"
    FOR EACH ROW EXECUTE FUNCTION "document_storage_deletion_evidence_append_only"();

CREATE TRIGGER "DocumentStorageDeletion_no_delete"
    BEFORE DELETE ON "DocumentStorageDeletion"
    FOR EACH ROW EXECUTE FUNCTION "document_storage_deletion_evidence_append_only"();

COMMIT;
