BEGIN;

-- Supplement the existing day-based guards without changing their behavior.
-- The policy-mode insertion fence remains active until all record classes
-- and review paths have matching calendar enforcement.
CREATE FUNCTION "Document_calendar_removal_guard_fn"() RETURNS trigger AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE;
BEGIN
  IF OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision"
    WHERE id=NEW."recoveryPolicyId" AND "organisationId"=OLD."organisationId";
  IF NOT FOUND THEN RETURN NEW; END IF; -- Existing custody guard rejects it.
  IF policy."retentionMode"='AFTER_CALENDAR_YEARS' THEN
    IF policy."retentionAnchor" IS DISTINCT FROM 'CREATED_AT'
      OR policy."retentionYears" IS NULL
      OR "Retention_calendar_year_cutoff_utc"(OLD."createdAt",policy."retentionYears")>NEW."deletedAt" THEN
      RAISE EXCEPTION 'Document calendar-year retention period has not been satisfied';
    END IF;
  ELSIF policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR','PERMANENT') THEN
    RAISE EXCEPTION 'Unsupported document retention policy mode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Document_calendar_removal_guard"
  BEFORE UPDATE OF "deletedAt" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_calendar_removal_guard_fn"();

CREATE FUNCTION "DocumentPurgeClaim_calendar_guard_fn"() RETURNS trigger AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE;
  anchor_at TIMESTAMP(3);
BEGIN
  SELECT p.* INTO policy
    FROM "DocumentPurgeAuthorization" a
    JOIN "DataRetentionPolicyRevision" p ON p.id=a."policyId" AND p."organisationId"=a."organisationId"
    WHERE a.id=NEW."authorizationId" AND a."organisationId"=NEW."organisationId"
      AND a."documentId"=NEW."documentId";
  IF NOT FOUND THEN RETURN NEW; END IF; -- Existing claim guard rejects it.
  SELECT "createdAt" INTO anchor_at FROM "Document" WHERE id=NEW."documentId"
    AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RETURN NEW; END IF; -- Existing claim guard rejects it.
  IF policy."retentionMode"='AFTER_CALENDAR_YEARS' THEN
    IF policy."retentionAnchor" IS DISTINCT FROM 'CREATED_AT'
      OR policy."retentionYears" IS NULL
      OR "Retention_calendar_year_cutoff_utc"(anchor_at,policy."retentionYears")
        > timezone('UTC',clock_timestamp())::timestamp(3) THEN
      RAISE EXCEPTION 'Document purge claim must wait for calendar-year retention expiry';
    END IF;
  ELSIF policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR','PERMANENT') THEN
    RAISE EXCEPTION 'Unsupported document retention policy mode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_calendar_guard"
  BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_calendar_guard_fn"();

COMMIT;
