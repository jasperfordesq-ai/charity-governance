BEGIN;

-- Keep the calendar mode fenced at policy creation until complaint purge,
-- copies, API decisions and review paths have the same cutoff rule.
CREATE OR REPLACE FUNCTION "ComplaintRemoval_insert_fn"() RETURNS trigger AS $$
DECLARE complaint "ComplaintRecord"%ROWTYPE; policy "DataRetentionPolicyRevision"%ROWTYPE;
  evidence "ComplaintResolutionEvidence"%ROWTYPE; retention_until TIMESTAMP(3);
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint.revision <> NEW."recordRevision" OR complaint."removedAt" IS NOT NULL
    OR complaint.status <> 'CLOSED' OR complaint."reviewedByBoard" OR nullif(btrim(complaint."boardMinuteReference"),'') IS NOT NULL THEN
    RAISE EXCEPTION 'Removal requires a current closed complaint without retained board evidence';
  END IF;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND "lifecycleStatus"='ACTIVE' AND role IN ('OWNER','ADMIN') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Removal requires an active charity administrator'; END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=NEW."policyId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR policy.state <> 'APPROVED' OR policy."recordClass" <> 'COMPLAINT'
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR','AFTER_CALENDAR_YEARS')
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id) THEN
    RAISE EXCEPTION 'Removal requires current approved complaint policy';
  END IF;
  IF EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
    AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>policy.id
    AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Ambiguous complaint policy requires review';
  END IF;
  NEW."occurredAt" := timezone('UTC', clock_timestamp())::timestamp(3);
  NEW."recoveryUntil" := NEW."occurredAt" + policy."recoveryDays" * INTERVAL '1 day';
  IF policy."retentionMode" IN ('AFTER_ANCHOR','AFTER_CALENDAR_YEARS') THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId"
      AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.id IS DISTINCT FROM NEW."resolutionEvidenceId" OR evidence.state <> 'RECORDED'
      OR evidence."recordRevision" <> complaint.revision OR evidence."resolvedAt" IS NULL
      OR evidence."resolvedAt" < complaint."receivedDate" OR policy."retentionAnchor" IS DISTINCT FROM 'RESOLVED_AT' THEN
      RAISE EXCEPTION 'Removal requires elapsed retention and current resolution evidence';
    END IF;
    IF policy."retentionMode"='AFTER_ANCHOR' THEN
      retention_until := evidence."resolvedAt" + policy."retentionDays" * INTERVAL '1 day';
    ELSE
      retention_until := "Retention_calendar_year_cutoff_utc"(evidence."resolvedAt",policy."retentionYears");
    END IF;
    IF retention_until>NEW."occurredAt" THEN
      RAISE EXCEPTION 'Removal requires elapsed retention and current resolution evidence';
    END IF;
  ELSIF NEW."resolutionEvidenceId" IS NOT NULL THEN
    RAISE EXCEPTION 'Individual review must not assert an unused resolution anchor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
