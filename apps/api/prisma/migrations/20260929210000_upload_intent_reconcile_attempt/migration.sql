-- A failed stale-upload reconciliation remains RESERVED for retry. Ordering
-- only by creation time repeatedly selects the same broken first batch and
-- can indefinitely defer cleanup of later orphaned objects.
ALTER TABLE "DocumentUploadIntent"
  ADD COLUMN "lastReconcileAttemptAt" TIMESTAMP(3);

CREATE INDEX "DocumentUploadIntent_reconcile_attempt_idx"
  ON "DocumentUploadIntent"("state", "lastReconcileAttemptAt", "createdAt", "id");

-- Keep the existing identity and state-transition gates. The only new
-- RESERVED -> RESERVED update is an attempt stamp; it does not attach a
-- document, queue erasure or change the provider/object identity.
CREATE OR REPLACE FUNCTION "DocumentUploadIntent_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document upload intent history cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'RESERVED' OR NEW."lastReconcileAttemptAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Document upload intent must start reserved without a reconcile attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW."id", NEW."organisationId", NEW."storagePath", NEW."provider", NEW."createdAt")
    IS DISTINCT FROM
     ROW(OLD."id", OLD."organisationId", OLD."storagePath", OLD."provider", OLD."createdAt") THEN
    RAISE EXCEPTION 'Document upload intent identity is immutable';
  END IF;

  IF OLD."state" = 'RESERVED' AND NEW."state" = 'RESERVED' THEN
    IF NEW."lastReconcileAttemptAt" IS NULL
       OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
       OR NEW."cleanupDeletionId" IS DISTINCT FROM OLD."cleanupDeletionId" THEN
      RAISE EXCEPTION 'Document upload intent attempt stamp is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" <> 'RESERVED' OR NEW."state" NOT IN ('ATTACHED', 'CLEANUP_PENDING')
     OR NEW."lastReconcileAttemptAt" IS DISTINCT FROM OLD."lastReconcileAttemptAt" THEN
    RAISE EXCEPTION 'Document upload intent transition is invalid';
  END IF;

  IF NEW."state" = 'ATTACHED' AND NOT EXISTS (
    SELECT 1 FROM "Document" d
    WHERE d."id" = NEW."documentId"
      AND d."organisationId" = NEW."organisationId"
      AND d."fileUrl" = NEW."storagePath"
  ) THEN
    RAISE EXCEPTION 'Document upload intent attachment must match a live tenant document';
  END IF;
  IF NEW."state" = 'CLEANUP_PENDING' AND NOT EXISTS (
    SELECT 1 FROM "DocumentStorageDeletion" deletion
    WHERE deletion."id" = NEW."cleanupDeletionId"
      AND deletion."organisationId" = NEW."organisationId"
      AND deletion."storagePath" = NEW."storagePath"
      AND deletion."provider" = NEW."provider"
  ) THEN
    RAISE EXCEPTION 'Document upload intent cleanup must match a tenant deletion row';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
