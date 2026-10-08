BEGIN;

-- Authorizations review a plan and matching evidence; claims recheck the
-- current policy, original recovery deadline and elapsed retention before
-- the atomic delete. The calendar policy creation fence remains active.
CREATE OR REPLACE FUNCTION "ComplaintPurgeAuthorization_insert_fn"() RETURNS trigger AS $$
DECLARE complaint "ComplaintRecord"%ROWTYPE; removal "ComplaintRemoval"%ROWTYPE;
  policy "DataRetentionPolicyRevision"%ROWTYPE; hold "ComplaintHoldEvent"%ROWTYPE;
  evidence "ComplaintResolutionEvidence"%ROWTYPE; area TEXT; entry JSONB;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint."removedAt" IS NULL OR complaint.status<>'CLOSED'
    OR complaint."reviewedByBoard" OR nullif(btrim(complaint."boardMinuteReference"),'') IS NOT NULL THEN
    RAISE EXCEPTION 'Complaint purge review requires a removed closed record without board evidence';
  END IF;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge review requires active charity Owner'; END IF;
  SELECT * INTO removal FROM "ComplaintRemoval" WHERE id=complaint."removalId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND OR NEW."recordRevision"<>complaint.revision OR NEW."removalId"<>removal.id
    OR NEW."recoveryUntil" IS DISTINCT FROM removal."recoveryUntil" THEN
    RAISE EXCEPTION 'Complaint purge review must bind exact record and recovery decision';
  END IF;
  SELECT * INTO hold FROM "ComplaintHoldEvent" WHERE "organisationId"=NEW."organisationId"
    AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
  IF COALESCE(hold.held,false) OR NEW."holdRevision"<>COALESCE(hold.revision,0) THEN
    RAISE EXCEPTION 'Complaint purge review requires current unheld revision';
  END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=NEW."policyId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR policy.state<>'APPROVED' OR policy."recordClass"<>'COMPLAINT'
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR','AFTER_CALENDAR_YEARS')
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
      AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Complaint purge review requires one current approved complaint policy';
  END IF;
  IF policy."retentionMode" IN ('AFTER_ANCHOR','AFTER_CALENDAR_YEARS') THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId"
      AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.state<>'RECORDED' OR evidence."resolvedAt" IS NULL
      OR evidence."recordRevision"<>removal."recordRevision" OR policy."retentionAnchor" IS DISTINCT FROM 'RESOLVED_AT' THEN
      RAISE EXCEPTION 'Complaint purge review requires matching original resolution evidence';
    END IF;
  END IF;
  IF jsonb_typeof(NEW."dispositionPlan") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Complaint purge plan must cover six areas';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW."dispositionPlan"))<>6 THEN
    RAISE EXCEPTION 'Complaint purge plan must cover six areas';
  END IF;
  FOREACH area IN ARRAY ARRAY['PRIMARY','SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES'] LOOP
    entry:=NEW."dispositionPlan"->area;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Complaint purge plan area missing'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry))<>2
      OR jsonb_typeof(entry->'disposition') IS DISTINCT FROM 'string'
      OR entry->>'disposition' NOT IN ('DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE')
      OR jsonb_typeof(entry->'evidenceRef') IS DISTINCT FROM 'string'
      OR entry->>'evidenceRef' !~ '^[A-Z0-9][A-Z0-9-]{2,119}$' THEN
      RAISE EXCEPTION 'Complaint purge plan requires reviewed dispositions and references';
    END IF;
  END LOOP;
  IF NEW."dispositionPlan"->'PRIMARY'->>'disposition'<>'DISPOSE' THEN
    RAISE EXCEPTION 'Complaint primary disposition must be disposal';
  END IF;
  NEW."authorizedAt":=timezone('UTC',clock_timestamp())::timestamp(3);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "ComplaintPurgeClaim_insert_fn"() RETURNS trigger AS $$
DECLARE auth "ComplaintPurgeAuthorization"%ROWTYPE; complaint "ComplaintRecord"%ROWTYPE;
  removal "ComplaintRemoval"%ROWTYPE; policy "DataRetentionPolicyRevision"%ROWTYPE;
  hold "ComplaintHoldEvent"%ROWTYPE; evidence "ComplaintResolutionEvidence"%ROWTYPE; observed TIMESTAMP(3);
  retention_until TIMESTAMP(3);
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT * INTO auth FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR auth."actorUserId"<>NEW."actorUserId" OR auth."complaintId"<>NEW."complaintId"
    OR EXISTS (SELECT 1 FROM "ComplaintPurgeAuthorizationWithdrawal" WHERE "authorizationId"=auth.id) THEN
    RAISE EXCEPTION 'Complaint purge claim requires matching unwithdrawn Owner authority';
  END IF;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint."removedAt" IS NULL OR complaint.status<>'CLOSED'
    OR complaint.revision<>auth."recordRevision" OR complaint."removalId" IS DISTINCT FROM auth."removalId"
    OR complaint."reviewedByBoard" OR nullif(btrim(complaint."boardMinuteReference"),'') IS NOT NULL THEN
    RAISE EXCEPTION 'Complaint purge claim requires exact removed record without board evidence';
  END IF;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge claim requires active charity Owner'; END IF;
  SELECT * INTO removal FROM "ComplaintRemoval" WHERE id=auth."removalId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND OR removal."complaintId"<>complaint.id OR removal."recoveryUntil" IS DISTINCT FROM auth."recoveryUntil" THEN
    RAISE EXCEPTION 'Complaint purge claim requires original recovery deadline';
  END IF;
  SELECT * INTO hold FROM "ComplaintHoldEvent" WHERE "organisationId"=NEW."organisationId" AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
  IF COALESCE(hold.held,false) OR COALESCE(hold.revision,0)<>auth."holdRevision" THEN
    RAISE EXCEPTION 'Complaint purge claim requires unchanged unheld revision';
  END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=auth."policyId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR policy.state<>'APPROVED' OR policy."recordClass"<>'COMPLAINT'
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR','AFTER_CALENDAR_YEARS')
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
      AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Complaint purge claim requires current approved complaint policy';
  END IF;
  observed:=timezone('UTC',clock_timestamp())::timestamp(3);
  IF observed<removal."recoveryUntil" THEN RAISE EXCEPTION 'Complaint purge claim must wait for recovery expiry'; END IF;
  IF policy."retentionMode" IN ('AFTER_ANCHOR','AFTER_CALENDAR_YEARS') THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId" AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.state<>'RECORDED' OR evidence."resolvedAt" IS NULL
      OR evidence."recordRevision"<>removal."recordRevision" OR policy."retentionAnchor" IS DISTINCT FROM 'RESOLVED_AT' THEN
      RAISE EXCEPTION 'Complaint purge claim requires elapsed matching resolution retention';
    END IF;
    IF policy."retentionMode"='AFTER_ANCHOR' THEN
      retention_until:=evidence."resolvedAt"+policy."retentionDays"*INTERVAL '1 day';
    ELSE
      retention_until:="Retention_calendar_year_cutoff_utc"(evidence."resolvedAt",policy."retentionYears");
    END IF;
    IF retention_until>observed THEN
      RAISE EXCEPTION 'Complaint purge claim requires elapsed matching resolution retention';
    END IF;
  END IF;
  NEW."transactionId":=txid_current(); NEW."claimedAt":=observed;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
