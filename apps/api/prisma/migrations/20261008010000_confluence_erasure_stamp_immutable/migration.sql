BEGIN;

-- The erasure job reference is the bridge from a retired Confluence copy to
-- its storage-deletion audit and worker. Once stamped, clearing or replacing
-- either half could make a second request look fresh or redirect the receipt.
CREATE FUNCTION "DocumentPublication_erasure_stamp_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."erasureRequestedAt" IS NOT NULL OR NEW."erasureDeletionId" IS NOT NULL THEN
      RAISE EXCEPTION 'Confluence erasure stamp requires an existing retired publication';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."erasureRequestedAt" IS NOT NULL OR OLD."erasureDeletionId" IS NOT NULL THEN
    IF NEW."erasureRequestedAt" IS DISTINCT FROM OLD."erasureRequestedAt"
      OR NEW."erasureDeletionId" IS DISTINCT FROM OLD."erasureDeletionId" THEN
      RAISE EXCEPTION 'Confluence erasure stamp is immutable';
    END IF;
  ELSIF NEW."erasureRequestedAt" IS NOT NULL OR NEW."erasureDeletionId" IS NOT NULL THEN
    IF OLD.state <> 'RETIRED' OR NEW.state <> 'RETIRED'
      OR NEW."erasureRequestedAt" IS NULL OR NEW."erasureDeletionId" IS NULL THEN
      RAISE EXCEPTION 'Confluence erasure stamp requires a retired publication and complete request';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublication_erasure_stamp_guard"
  BEFORE INSERT OR UPDATE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_erasure_stamp_guard_fn"();

COMMIT;
