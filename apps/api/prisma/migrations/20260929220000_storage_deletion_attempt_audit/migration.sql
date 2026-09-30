-- Capture worker outcomes as they become durable, in the same transaction as
-- the deletion row update. Older retry attempts cannot be reconstructed.
CREATE TYPE "DocumentStorageDeletionAttemptOutcome" AS ENUM (
  'RETRY_SCHEDULED', 'DEAD_LETTERED', 'PROCESSED'
);

CREATE TABLE "DocumentStorageDeletionAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deletionId" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "outcome" "DocumentStorageDeletionAttemptOutcome" NOT NULL,
  "terminalReason" "DocumentStorageDeletionTerminalReason",
  "activeObjectAbsentAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentStorageDeletionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentStorageDeletionAttempt_attempt_positive" CHECK ("attemptNumber" > 0),
  CONSTRAINT "DocumentStorageDeletionAttempt_outcome_shape" CHECK (
    ("outcome" = 'DEAD_LETTERED' AND "terminalReason" IS NOT NULL AND "activeObjectAbsentAt" IS NULL)
    OR ("outcome" = 'RETRY_SCHEDULED' AND "terminalReason" IS NULL AND "activeObjectAbsentAt" IS NULL)
    OR ("outcome" = 'PROCESSED' AND "terminalReason" IS NULL)
  )
);

ALTER TABLE "DocumentStorageDeletionAttempt"
  ADD CONSTRAINT "DocumentStorageDeletionAttempt_deletionId_fkey"
  FOREIGN KEY ("deletionId") REFERENCES "DocumentStorageDeletion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "DocumentStorageDeletionAttempt_organisationId_occurredAt_id_idx"
  ON "DocumentStorageDeletionAttempt"("organisationId", "occurredAt", "id");
CREATE INDEX "DocumentStorageDeletionAttempt_deletionId_occurredAt_idx"
  ON "DocumentStorageDeletionAttempt"("deletionId", "occurredAt");

CREATE FUNCTION "capture_document_storage_deletion_attempt"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" = 'PENDING'
     AND NEW."attempts" = OLD."attempts" + 1
     AND NEW."lastAttemptAt" IS NOT NULL
     AND NEW."lastAttemptAt" IS DISTINCT FROM OLD."lastAttemptAt"
     AND NEW."state" IN ('PENDING', 'DEAD_LETTER') THEN
    INSERT INTO "DocumentStorageDeletionAttempt" (
      "deletionId", "organisationId", "provider", "attemptNumber", "outcome",
      "terminalReason", "occurredAt"
    ) VALUES (
      NEW."id", NEW."organisationId", NEW."provider", NEW."attempts",
      CASE WHEN NEW."state" = 'DEAD_LETTER' THEN 'DEAD_LETTERED'::"DocumentStorageDeletionAttemptOutcome"
           ELSE 'RETRY_SCHEDULED'::"DocumentStorageDeletionAttemptOutcome" END,
      NEW."terminalReason", NEW."lastAttemptAt"
    );
  ELSIF OLD."state" = 'PENDING'
        AND NEW."state" = 'PROCESSED'
        AND OLD."processedAt" IS NULL
        AND NEW."processedAt" IS NOT NULL THEN
    INSERT INTO "DocumentStorageDeletionAttempt" (
      "deletionId", "organisationId", "provider", "attemptNumber", "outcome",
      "activeObjectAbsentAt", "occurredAt"
    ) VALUES (
      NEW."id", NEW."organisationId", NEW."provider", OLD."attempts" + 1,
      'PROCESSED', NEW."activeObjectAbsentAt", NEW."processedAt"
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStorageDeletion_attempt_capture"
  AFTER UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "capture_document_storage_deletion_attempt"();

CREATE FUNCTION "guard_document_storage_deletion_attempt_insert"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Document storage deletion attempt events must be captured from a deletion transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStorageDeletionAttempt_capture_only"
  BEFORE INSERT ON "DocumentStorageDeletionAttempt"
  FOR EACH ROW EXECUTE FUNCTION "guard_document_storage_deletion_attempt_insert"();

-- Direct mutations to an attempt row would turn an audit event into a claim.
CREATE FUNCTION "document_storage_deletion_attempt_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Document storage deletion attempt evidence is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStorageDeletionAttempt_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentStorageDeletionAttempt"
  FOR EACH ROW EXECUTE FUNCTION "document_storage_deletion_attempt_append_only"();
