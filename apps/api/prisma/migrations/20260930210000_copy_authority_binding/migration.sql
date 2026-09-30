BEGIN;
-- Serialize policy creation/withdrawal with all copy review consumers, including
-- direct database writers. API consumers already take the same organisation lock.
CREATE FUNCTION "CopyPolicy_serialization_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyRevision_00_copy_lock" BEFORE INSERT ON "DataRetentionPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION "CopyPolicy_serialization_fn"();
CREATE TRIGGER "DataRetentionPolicyWithdrawal_00_copy_lock" BEFORE INSERT ON "DataRetentionPolicyWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "CopyPolicy_serialization_fn"();

CREATE FUNCTION "CopyPolicy_validate_fn"(org TEXT, policy_id TEXT, record_class TEXT,
  disposition TEXT, anchor_at TIMESTAMP(3), recorded_at TIMESTAMP(3)) RETURNS void AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=policy_id AND "organisationId"=org FOR UPDATE;
  IF NOT FOUND OR policy.state<>'APPROVED' OR policy."recordClass"<>record_class
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=org
      AND p."recordClass"=record_class AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Copy review requires one current approved copy policy';
  END IF;
  IF policy."retentionMode"='PERMANENT' AND disposition<>'RETAIN_APPROVED' THEN
    RAISE EXCEPTION 'Permanent copy retention requires approved retention';
  END IF;
  IF policy."retentionMode"='AFTER_ANCHOR' THEN
    IF policy."retentionAnchor"<>'CREATED_AT' OR anchor_at IS NULL OR anchor_at>recorded_at THEN
      RAISE EXCEPTION 'Copy review requires a reviewed copy anchor';
    END IF;
    IF disposition IN ('DISPOSE','NOT_APPLICABLE') AND anchor_at + make_interval(days=>policy."retentionDays")>recorded_at THEN
      RAISE EXCEPTION 'Copy retention has not expired';
    END IF;
  ELSIF anchor_at IS NOT NULL THEN
    RAISE EXCEPTION 'Untimed copy policy must not invent a retention anchor';
  END IF;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "DocumentCopyDispositionAuthority" ADD COLUMN "policyId" TEXT, ADD COLUMN "retentionAnchorAt" TIMESTAMP(3),
  ADD CONSTRAINT "DocumentCopyAuthority_policy_fkey" FOREIGN KEY ("policyId","organisationId") REFERENCES "DataRetentionPolicyRevision"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentPurgeDispositionEvent" ADD COLUMN "copyAuthorityId" TEXT,
  ADD CONSTRAINT "DocumentCopyObservation_authority_fkey" FOREIGN KEY ("copyAuthorityId") REFERENCES "DocumentCopyDispositionAuthority"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "DocumentCopyDispositionAuthority_policy_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW.state='WITHDRAWN' THEN
    IF NEW."policyId" IS NOT NULL OR NEW."retentionAnchorAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Copy withdrawal cannot grant a policy';
    END IF;
    RETURN NEW;
  END IF;
  -- Existing review/hold triggers hold Organisation, Owner and authorization.
  PERFORM "CopyPolicy_validate_fn"(NEW."organisationId",NEW."policyId",'DOCUMENT_COPY',
    NEW.disposition,NEW."retentionAnchorAt",NEW."occurredAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentCopyDispositionAuthority_policy" BEFORE INSERT ON "DocumentCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyDispositionAuthority_policy_fn"();

CREATE OR REPLACE FUNCTION "DocumentPurgeDispositionEvent_guard_fn"() RETURNS trigger AS $$
DECLARE auth "DocumentPurgeAuthorization"%ROWTYPE; claim_time TIMESTAMP(3);
  original_policy "DataRetentionPolicyRevision"%ROWTYPE;
  previous_revision INTEGER; planned TEXT; recorded_now TIMESTAMP(3);
  scoped "DocumentCopyDispositionAuthority"%ROWTYPE; current_hold "DocumentCopyHoldEvent"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purge disposition evidence is append-only'; END IF;
  -- Same lock ordering as Owner authorization/claim. Serialize corrections
  -- against concurrent submissions and an Owner's demotion/transfer.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge disposition requires the active charity owner'; END IF;
  SELECT * INTO auth FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge disposition authorization not found'; END IF;
  SELECT "claimedAt" INTO claim_time FROM "DocumentPurgeClaim" WHERE "authorizationId"=auth.id AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge disposition requires a committed purge claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO previous_revision FROM "DocumentPurgeDispositionEvent"
    WHERE "authorizationId"=auth.id AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF NEW.revision <> previous_revision + 1 THEN RAISE EXCEPTION 'Purge disposition revision changed; refresh history'; END IF;
  recorded_now := timezone('UTC', clock_timestamp());
  SELECT * INTO scoped FROM "DocumentCopyDispositionAuthority" WHERE "authorizationId"=auth.id AND area=NEW.area
    AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  SELECT * INTO current_hold FROM "DocumentCopyHoldEvent" WHERE "authorizationId"=auth.id AND area=NEW.area
    AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW."copyAuthorityId" IS NOT NULL THEN
    IF scoped.id IS DISTINCT FROM NEW."copyAuthorityId" OR scoped.state IS DISTINCT FROM 'AUTHORIZED'
      OR scoped."actorUserId"<>NEW."actorUserId" THEN
      RAISE EXCEPTION 'Copy observation requires explicit current scoped authority';
    END IF;
    IF scoped."validUntil"<=recorded_now THEN RAISE EXCEPTION 'Copy observation has expired scoped authority'; END IF;
    IF NEW."observedAt"<scoped."occurredAt" THEN RAISE EXCEPTION 'Copy observation predates scoped authority'; END IF;
    IF COALESCE(current_hold.held,false) OR scoped."holdRevision"<>COALESCE(current_hold.revision,0) THEN
      RAISE EXCEPTION 'Copy observation requires current unheld scope revision';
    END IF;
    PERFORM "CopyPolicy_validate_fn"(NEW."organisationId",scoped."policyId",'DOCUMENT_COPY',
      scoped.disposition,scoped."retentionAnchorAt",recorded_now);
    planned := scoped.disposition;
  ELSE
    -- Unresolved factual evidence remains recordable after withdrawal or expiry.
    -- Final statuses cannot silently revert to the old area-wide authorization.
    IF scoped.id IS NOT NULL AND NEW.status NOT IN ('NEEDS_REVIEW','FAILED') THEN
      RAISE EXCEPTION 'Copy observation requires explicit current scoped authority';
    END IF;
    IF NEW.status IN ('PENDING_DISPOSAL','VERIFIED_ABSENT') AND COALESCE(current_hold.held,false) THEN
      RAISE EXCEPTION 'Copy observation requires current unheld scope revision';
    END IF;
    IF NEW.status NOT IN ('NEEDS_REVIEW','FAILED') THEN
      SELECT * INTO original_policy FROM "DataRetentionPolicyRevision" WHERE id=auth."policyId"
        AND "organisationId"=NEW."organisationId" FOR UPDATE;
      IF NOT FOUND OR original_policy.state<>'APPROVED' OR original_policy."recordClass"<>'VAULT_DRAFT'
        OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=original_policy.id)
        OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
          AND p."recordClass"='VAULT_DRAFT' AND p.state='APPROVED' AND p.id<>original_policy.id
          AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
        RAISE EXCEPTION 'Copy review requires one current original-plan policy';
      END IF;
    END IF;
    planned := auth."dispositionPlan"->NEW.area->>'disposition';
  END IF;
  IF (NEW.status IN ('PENDING_DISPOSAL','VERIFIED_ABSENT') AND planned IS DISTINCT FROM 'DISPOSE')
    OR (NEW.status='RETAINED_APPROVED' AND planned IS DISTINCT FROM 'RETAIN_APPROVED')
    OR (NEW.status='NOT_APPLICABLE' AND planned IS DISTINCT FROM 'NOT_APPLICABLE') THEN
    RAISE EXCEPTION 'Purge disposition cannot contradict the authorized plan';
  END IF;
  IF NEW."observedAt" < claim_time OR NEW."observedAt" > recorded_now THEN
    RAISE EXCEPTION 'Purge disposition observation must be between claim and recording';
  END IF;
  IF (NEW.status IN ('NEEDS_REVIEW','PENDING_DISPOSAL','FAILED','RETAINED_APPROVED') AND NEW."nextReviewAt" IS NULL)
    OR (NEW."nextReviewAt" IS NOT NULL AND NEW."nextReviewAt" <= recorded_now) THEN
    RAISE EXCEPTION 'Purge disposition requires a future follow-up review date';
  END IF;
  NEW."occurredAt" := recorded_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "ComplaintCopyDispositionAuthority" ADD COLUMN "policyId" TEXT, ADD COLUMN "retentionAnchorAt" TIMESTAMP(3),
  ADD CONSTRAINT "ComplaintCopyAuthority_policy_fkey" FOREIGN KEY ("policyId","organisationId") REFERENCES "DataRetentionPolicyRevision"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplaintPurgeDispositionEvent" ADD COLUMN "copyAuthorityId" TEXT,
  ADD CONSTRAINT "ComplaintCopyObservation_authority_fkey" FOREIGN KEY ("copyAuthorityId") REFERENCES "ComplaintCopyDispositionAuthority"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "ComplaintCopyDispositionAuthority_policy_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW.state='WITHDRAWN' THEN
    IF NEW."policyId" IS NOT NULL OR NEW."retentionAnchorAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Copy withdrawal cannot grant a policy';
    END IF;
    RETURN NEW;
  END IF;
  -- Existing review/hold triggers hold Organisation, Owner and authorization.
  PERFORM "CopyPolicy_validate_fn"(NEW."organisationId",NEW."policyId",'COMPLAINT_COPY',
    NEW.disposition,NEW."retentionAnchorAt",NEW."occurredAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintCopyDispositionAuthority_policy" BEFORE INSERT ON "ComplaintCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopyDispositionAuthority_policy_fn"();

CREATE OR REPLACE FUNCTION "ComplaintPurgeDispositionEvent_guard_fn"() RETURNS trigger AS $$
DECLARE auth "ComplaintPurgeAuthorization"%ROWTYPE; claim_time TIMESTAMP(3);
  original_policy "DataRetentionPolicyRevision"%ROWTYPE;
  previous_revision INTEGER; planned TEXT; recorded_now TIMESTAMP(3);
  scoped "ComplaintCopyDispositionAuthority"%ROWTYPE; current_hold "ComplaintCopyHoldEvent"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Complaint purge disposition evidence is append-only'; END IF;
  -- Same lock ordering as Owner authorization/claim. Serialize corrections
  -- against concurrent submissions and an Owner's demotion/transfer.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition requires the active charity owner'; END IF;
  SELECT * INTO auth FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition authorization not found'; END IF;
  SELECT "claimedAt" INTO claim_time FROM "ComplaintPurgeClaim" WHERE "authorizationId"=auth.id AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition requires a committed purge claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO previous_revision FROM "ComplaintPurgeDispositionEvent"
    WHERE "authorizationId"=auth.id AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF NEW.revision <> previous_revision + 1 THEN RAISE EXCEPTION 'Complaint purge disposition revision changed; refresh history'; END IF;
  recorded_now := timezone('UTC', clock_timestamp());
  SELECT * INTO scoped FROM "ComplaintCopyDispositionAuthority" WHERE "authorizationId"=auth.id AND area=NEW.area
    AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  SELECT * INTO current_hold FROM "ComplaintCopyHoldEvent" WHERE "authorizationId"=auth.id AND area=NEW.area
    AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW."copyAuthorityId" IS NOT NULL THEN
    IF scoped.id IS DISTINCT FROM NEW."copyAuthorityId" OR scoped.state IS DISTINCT FROM 'AUTHORIZED'
      OR scoped."actorUserId"<>NEW."actorUserId" THEN
      RAISE EXCEPTION 'Copy observation requires explicit current scoped authority';
    END IF;
    IF scoped."validUntil"<=recorded_now THEN RAISE EXCEPTION 'Copy observation has expired scoped authority'; END IF;
    IF NEW."observedAt"<scoped."occurredAt" THEN RAISE EXCEPTION 'Copy observation predates scoped authority'; END IF;
    IF COALESCE(current_hold.held,false) OR scoped."holdRevision"<>COALESCE(current_hold.revision,0) THEN
      RAISE EXCEPTION 'Copy observation requires current unheld scope revision';
    END IF;
    PERFORM "CopyPolicy_validate_fn"(NEW."organisationId",scoped."policyId",'COMPLAINT_COPY',
      scoped.disposition,scoped."retentionAnchorAt",recorded_now);
    planned := scoped.disposition;
  ELSE
    -- Unresolved factual evidence remains recordable after withdrawal or expiry.
    -- Final statuses cannot silently revert to the old area-wide authorization.
    IF scoped.id IS NOT NULL AND NEW.status NOT IN ('NEEDS_REVIEW','FAILED') THEN
      RAISE EXCEPTION 'Copy observation requires explicit current scoped authority';
    END IF;
    IF NEW.status IN ('PENDING_DISPOSAL','VERIFIED_ABSENT') AND COALESCE(current_hold.held,false) THEN
      RAISE EXCEPTION 'Copy observation requires current unheld scope revision';
    END IF;
    IF NEW.status NOT IN ('NEEDS_REVIEW','FAILED') THEN
      SELECT * INTO original_policy FROM "DataRetentionPolicyRevision" WHERE id=auth."policyId"
        AND "organisationId"=NEW."organisationId" FOR UPDATE;
      IF NOT FOUND OR original_policy.state<>'APPROVED' OR original_policy."recordClass"<>'COMPLAINT'
        OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=original_policy.id)
        OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
          AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>original_policy.id
          AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
        RAISE EXCEPTION 'Copy review requires one current original-plan policy';
      END IF;
    END IF;
    planned := auth."dispositionPlan"->NEW.area->>'disposition';
  END IF;
  IF (NEW.status IN ('PENDING_DISPOSAL','VERIFIED_ABSENT') AND planned IS DISTINCT FROM 'DISPOSE')
    OR (NEW.status='RETAINED_APPROVED' AND planned IS DISTINCT FROM 'RETAIN_APPROVED')
    OR (NEW.status='NOT_APPLICABLE' AND planned IS DISTINCT FROM 'NOT_APPLICABLE') THEN
    RAISE EXCEPTION 'Complaint purge disposition cannot contradict the authorized plan';
  END IF;
  IF NEW."observedAt" < claim_time OR NEW."observedAt" > recorded_now THEN
    RAISE EXCEPTION 'Complaint purge disposition observation must be between claim and recording';
  END IF;
  IF (NEW.status IN ('NEEDS_REVIEW','PENDING_DISPOSAL','FAILED','RETAINED_APPROVED') AND NEW."nextReviewAt" IS NULL)
    OR (NEW."nextReviewAt" IS NOT NULL AND NEW."nextReviewAt" <= recorded_now) THEN
    RAISE EXCEPTION 'Complaint purge disposition requires a future follow-up review date';
  END IF;
  NEW."occurredAt" := recorded_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
