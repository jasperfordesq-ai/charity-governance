BEGIN;

-- Both document and complaint copy authorities, and their observations,
-- call this shared function. Calendar policies remain fenced at creation
-- while primary complaint purge and API review contracts are completed.
CREATE OR REPLACE FUNCTION "CopyPolicy_validate_fn"(org TEXT, policy_id TEXT, record_class TEXT,
  disposition TEXT, anchor_at TIMESTAMP(3), recorded_at TIMESTAMP(3)) RETURNS void AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE; retention_until TIMESTAMP(3);
BEGIN
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=policy_id AND "organisationId"=org FOR UPDATE;
  IF NOT FOUND OR policy.state<>'APPROVED' OR policy."recordClass"<>record_class
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=org
      AND p."recordClass"=record_class AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Copy review requires one current approved copy policy';
  END IF;
  IF policy."retentionMode" NOT IN ('REVIEW_REQUIRED','PERMANENT','AFTER_ANCHOR','AFTER_CALENDAR_YEARS') THEN
    RAISE EXCEPTION 'Unsupported copy retention policy mode';
  END IF;
  IF policy."retentionMode"='PERMANENT' AND disposition<>'RETAIN_APPROVED' THEN
    RAISE EXCEPTION 'Permanent copy retention requires approved retention';
  END IF;
  IF policy."retentionMode" IN ('AFTER_ANCHOR','AFTER_CALENDAR_YEARS') THEN
    IF policy."retentionAnchor" IS DISTINCT FROM 'CREATED_AT' OR anchor_at IS NULL OR anchor_at>recorded_at THEN
      RAISE EXCEPTION 'Copy review requires a reviewed copy anchor';
    END IF;
    IF policy."retentionMode"='AFTER_ANCHOR' THEN
      retention_until:=anchor_at+make_interval(days=>policy."retentionDays");
    ELSE
      retention_until:="Retention_calendar_year_cutoff_utc"(anchor_at,policy."retentionYears");
    END IF;
    IF disposition IN ('DISPOSE','NOT_APPLICABLE') AND retention_until>recorded_at THEN
      RAISE EXCEPTION 'Copy retention has not expired';
    END IF;
  ELSIF anchor_at IS NOT NULL THEN
    RAISE EXCEPTION 'Untimed copy policy must not invent a retention anchor';
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMIT;
