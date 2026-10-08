BEGIN;

-- Preserve the meaning of existing day-based revisions. This column is
-- distinct so a Board-approved number of years cannot be reinterpreted as
-- an elapsed number of days. The preceding mode fence still prevents a
-- calendar-year revision from being created while disposal guards are old.
ALTER TABLE "DataRetentionPolicyRevision" ADD COLUMN "retentionYears" INTEGER;
ALTER TABLE "DataRetentionPolicyRevision"
  DROP CONSTRAINT "DataRetentionPolicyRevision_period_valid";
ALTER TABLE "DataRetentionPolicyRevision"
  ADD CONSTRAINT "DataRetentionPolicyRevision_period_valid" CHECK (
    "recoveryDays" BETWEEN 1 AND 3650 AND
    (("retentionMode" IN ('REVIEW_REQUIRED', 'PERMANENT')
        AND "retentionDays" IS NULL AND "retentionYears" IS NULL AND "retentionAnchor" IS NULL)
      OR ("retentionMode" = 'AFTER_ANCHOR'
        AND "retentionDays" IS NOT NULL AND "retentionDays" BETWEEN 1 AND 36525
        AND "retentionYears" IS NULL AND "retentionAnchor" IS NOT NULL
        AND "retentionAnchor" IN (
          'CREATED_AT', 'APPROVED_AT', 'SUPERSEDED_AT', 'CEASED_AT',
          'RESOLVED_AT', 'RESPONDED_AT', 'INCIDENT_CLOSED_AT', 'CONSENT_ENDED_AT'
        ))
      OR ("retentionMode" = 'AFTER_CALENDAR_YEARS'
        AND "retentionYears" IS NOT NULL AND "retentionYears" BETWEEN 1 AND 100
        AND "retentionDays" IS NULL AND "retentionAnchor" IS NOT NULL
        AND "retentionAnchor" IN (
          'CREATED_AT', 'APPROVED_AT', 'SUPERSEDED_AT', 'CEASED_AT',
          'RESOLVED_AT', 'RESPONDED_AT', 'INCIDENT_CLOSED_AT', 'CONSENT_ENDED_AT'
        )))
  );

COMMIT;
