ALTER TABLE "DocumentPublication" ADD COLUMN "remoteWriteStartedAt" TIMESTAMP(3);

-- The marker is committed before a possible remote write. A successful,
-- identified publication may start a new attempt, but an unfinished or
-- ambiguous attempt may never clear the marker and become retryable.
CREATE FUNCTION "DocumentPublication_remote_write_reservation_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."remoteWriteStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Remote write reservation evidence cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."remoteWriteStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Remote write reservation requires a claimed publication';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."remoteWriteStartedAt" IS NULL AND NEW."remoteWriteStartedAt" IS NOT NULL THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'PENDING'
      OR OLD."claimedAt" IS NULL
      OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
      OR OLD."processedAt" IS NOT NULL OR NEW."processedAt" IS NOT NULL
      OR OLD."terminalReason" IS NOT NULL OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'Remote write reservation requires the current claimed attempt';
    END IF;
  ELSIF OLD.state = 'PENDING' AND NEW.state = 'PROCESSED'
    AND OLD."remoteWriteStartedAt" IS NULL THEN
    RAISE EXCEPTION 'Publication cannot complete without a committed remote write reservation';
  ELSIF OLD."remoteWriteStartedAt" IS NOT NULL
    AND NEW."remoteWriteStartedAt" IS DISTINCT FROM OLD."remoteWriteStartedAt" THEN
    IF NOT (NEW."remoteWriteStartedAt" IS NULL
      AND OLD.state = 'PROCESSED' AND NEW.state = 'PENDING'
      AND OLD."pageId" IS NOT NULL AND OLD."attachmentId" IS NOT NULL
      AND OLD."terminalReason" IS NULL
      AND NEW."pageId" IS NOT DISTINCT FROM OLD."pageId"
      AND NEW."attachmentId" IS NOT DISTINCT FROM OLD."attachmentId") THEN
      RAISE EXCEPTION 'Unresolved remote write reservation cannot be cleared or changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublication_remote_write_reservation"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_remote_write_reservation_fn"();
