-- A processed row predating the readback change must remain distinguishable
-- from a new primary-storage row whose active object was observed absent.
ALTER TABLE "DocumentStorageDeletion"
  ADD COLUMN "activeObjectAbsentAt" TIMESTAMP(3);

ALTER TABLE "DocumentStorageDeletion"
  ADD CONSTRAINT "DocumentStorageDeletion_active_absence_shape" CHECK (
    "activeObjectAbsentAt" IS NULL OR (
      "state" = 'PROCESSED'
      AND "processedAt" IS NOT NULL
      AND "provider" IN ('local', 'supabase')
    )
  );

CREATE FUNCTION "guard_document_storage_active_absence"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activeObjectAbsentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'New document deletion rows cannot claim active-object absence';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."activeObjectAbsentAt" IS DISTINCT FROM OLD."activeObjectAbsentAt" THEN
    IF OLD."activeObjectAbsentAt" IS NOT NULL
       OR OLD."state" <> 'PENDING'
       OR NEW."state" <> 'PROCESSED'
       OR NEW."processedAt" IS NULL
       OR NEW."provider" NOT IN ('local', 'supabase')
       OR NEW."activeObjectAbsentAt" IS NULL THEN
      RAISE EXCEPTION 'Active-object absence may only be recorded during primary-storage completion';
    END IF;
  END IF;
  -- Existing PROCESSED rows predate this receipt and stay nullable. A new
  -- primary-storage completion must carry its observation in the same update.
  IF OLD."state" = 'PENDING'
     AND NEW."state" = 'PROCESSED'
     AND NEW."provider" IN ('local', 'supabase')
     AND NEW."activeObjectAbsentAt" IS NULL THEN
    RAISE EXCEPTION 'Primary-storage completion requires an active-object absence observation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStorageDeletion_active_absence_insert"
  BEFORE INSERT ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "guard_document_storage_active_absence"();
CREATE TRIGGER "DocumentStorageDeletion_active_absence_update"
  BEFORE UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "guard_document_storage_active_absence"();
