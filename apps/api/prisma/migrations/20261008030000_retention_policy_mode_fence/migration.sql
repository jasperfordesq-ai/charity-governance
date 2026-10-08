BEGIN;

-- Keep disposal policy creation closed while calendar-year consumers are
-- upgraded. A later migration must deliberately replace this guard only
-- after every removal, purge and copy path enforces the new cutoff.
CREATE FUNCTION "DataRetentionPolicyRevision_mode_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."retentionMode" NOT IN ('REVIEW_REQUIRED', 'PERMANENT', 'AFTER_ANCHOR') THEN
    RAISE EXCEPTION 'Unsupported retention policy mode; calendar-year disposal is not active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DataRetentionPolicyRevision_01_mode_fence"
  BEFORE INSERT ON "DataRetentionPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicyRevision_mode_fence_fn"();

COMMIT;
