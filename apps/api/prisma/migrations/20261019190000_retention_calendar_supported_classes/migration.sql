BEGIN;

-- Calendar consumers and normal claim/dispatch paths have separate coverage.
-- Admit terms only for the four implemented operational classes and anchors;
-- this does not adopt a policy, authorise removal or bypass recovery binding.
CREATE OR REPLACE FUNCTION "DataRetentionPolicyRevision_mode_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."retentionMode" IN ('REVIEW_REQUIRED', 'PERMANENT', 'AFTER_ANCHOR') THEN
    RETURN NEW;
  END IF;
  IF NEW."retentionMode"='AFTER_CALENDAR_YEARS'
    AND NEW."recordClass" IN ('VAULT_DRAFT','COMPLAINT','DOCUMENT_COPY','COMPLAINT_COPY')
    AND NEW."retentionDays" IS NULL
    AND NEW."retentionYears" BETWEEN 1 AND 100
    AND NEW."retentionAnchor" = (CASE WHEN NEW."recordClass"='COMPLAINT' THEN 'RESOLVED_AT' ELSE 'CREATED_AT' END) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Unsupported retention policy mode, record class or calendar terms';
END;
$$ LANGUAGE plpgsql;

COMMIT;
