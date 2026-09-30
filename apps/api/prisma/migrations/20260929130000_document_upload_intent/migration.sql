CREATE TYPE "DocumentUploadIntentState" AS ENUM ('RESERVED', 'ATTACHED', 'CLEANUP_PENDING');

CREATE TABLE "DocumentUploadIntent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "state" "DocumentUploadIntentState" NOT NULL DEFAULT 'RESERVED',
  "documentId" TEXT,
  "cleanupDeletionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentUploadIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentUploadIntent_state_shape" CHECK (
    ("state" = 'RESERVED' AND "documentId" IS NULL AND "cleanupDeletionId" IS NULL)
    OR ("state" = 'ATTACHED' AND "documentId" IS NOT NULL AND "cleanupDeletionId" IS NULL)
    OR ("state" = 'CLEANUP_PENDING' AND "documentId" IS NULL AND "cleanupDeletionId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "DocumentUploadIntent_organisationId_storagePath_key"
  ON "DocumentUploadIntent"("organisationId", "storagePath");
CREATE INDEX "DocumentUploadIntent_state_createdAt_id_idx"
  ON "DocumentUploadIntent"("state", "createdAt", "id");
CREATE INDEX "DocumentUploadIntent_organisationId_state_createdAt_idx"
  ON "DocumentUploadIntent"("organisationId", "state", "createdAt");

CREATE FUNCTION "DocumentUploadIntent_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document upload intent history cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'RESERVED' THEN
      RAISE EXCEPTION 'Document upload intent must start reserved';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW."id", NEW."organisationId", NEW."storagePath", NEW."provider", NEW."createdAt")
    IS DISTINCT FROM
     ROW(OLD."id", OLD."organisationId", OLD."storagePath", OLD."provider", OLD."createdAt") THEN
    RAISE EXCEPTION 'Document upload intent identity is immutable';
  END IF;
  IF OLD."state" <> 'RESERVED' OR NEW."state" NOT IN ('ATTACHED', 'CLEANUP_PENDING') THEN
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

CREATE TRIGGER "DocumentUploadIntent_guard_insert"
  BEFORE INSERT ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentUploadIntent_guard_fn"();
CREATE TRIGGER "DocumentUploadIntent_guard_update"
  BEFORE UPDATE ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentUploadIntent_guard_fn"();
CREATE TRIGGER "DocumentUploadIntent_no_delete"
  BEFORE DELETE ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentUploadIntent_guard_fn"();
