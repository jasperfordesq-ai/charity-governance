BEGIN;
CREATE TABLE "ComplaintPurgeClaim" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL UNIQUE,
  "complaintId" TEXT NOT NULL UNIQUE, "actorUserId" TEXT NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("authorizationId","organisationId"),
  FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ComplaintPurgeClaim_history_idx" ON "ComplaintPurgeClaim"("organisationId","claimedAt",id);
CREATE FUNCTION "ComplaintPurgeClaim_insert_fn"() RETURNS trigger AS $$
DECLARE auth "ComplaintPurgeAuthorization"%ROWTYPE; complaint "ComplaintRecord"%ROWTYPE;
  removal "ComplaintRemoval"%ROWTYPE; policy "DataRetentionPolicyRevision"%ROWTYPE;
  hold "ComplaintHoldEvent"%ROWTYPE; evidence "ComplaintResolutionEvidence"%ROWTYPE; observed TIMESTAMP(3);
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
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR')
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
      AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Complaint purge claim requires current approved complaint policy';
  END IF;
  observed:=timezone('UTC',clock_timestamp())::timestamp(3);
  IF observed<removal."recoveryUntil" THEN RAISE EXCEPTION 'Complaint purge claim must wait for recovery expiry'; END IF;
  IF policy."retentionMode"='AFTER_ANCHOR' THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId" AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.state<>'RECORDED' OR evidence."resolvedAt" IS NULL
      OR evidence."recordRevision"<>removal."recordRevision" OR policy."retentionAnchor" IS DISTINCT FROM 'RESOLVED_AT'
      OR policy."retentionDays" IS NULL OR evidence."resolvedAt"+policy."retentionDays"*INTERVAL '1 day'>observed THEN
      RAISE EXCEPTION 'Complaint purge claim requires elapsed matching resolution retention';
    END IF;
  END IF;
  NEW."transactionId":=txid_current(); NEW."claimedAt":=observed;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeClaim_insert" BEFORE INSERT ON "ComplaintPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeClaim_insert_fn"();
CREATE TRIGGER "ComplaintPurgeClaim_append_only" BEFORE UPDATE OR DELETE ON "ComplaintPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

CREATE FUNCTION "ComplaintPurgeClaim_execute_fn"() RETURNS trigger AS $$
DECLARE affected INTEGER;
BEGIN
  DELETE FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId";
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'Complaint purge claim must remove exactly one primary record'; END IF;
  INSERT INTO "GovernanceRegisterChangeAudit" (id,"organisationId","recordKind","recordId","actorUserId",action,"previousStatus","nextStatus","changedFields","occurredAt")
    VALUES ('complaint-purge-'||NEW.id,NEW."organisationId",'COMPLAINT',NEW."complaintId",NEW."actorUserId",'DELETE','RECOVERABLE',NULL,ARRAY[]::TEXT[],NEW."claimedAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeClaim_execute" AFTER INSERT ON "ComplaintPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeClaim_execute_fn"();

CREATE FUNCTION "ComplaintPurgeWithdrawal_claim_fn"() RETURNS trigger AS $$
BEGIN
  -- Existing insert guard has already acquired charity and authorization locks.
  IF EXISTS (SELECT 1 FROM "ComplaintPurgeClaim" WHERE "authorizationId"=NEW."authorizationId") THEN
    RAISE EXCEPTION 'Claimed complaint disposal cannot be withdrawn';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeAuthorizationWithdrawal_z_claim" BEFORE INSERT ON "ComplaintPurgeAuthorizationWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeWithdrawal_claim_fn"();
CREATE FUNCTION "ComplaintRecord_purged_identity_fn"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ComplaintPurgeClaim" WHERE "complaintId"=NEW.id) THEN
    RAISE EXCEPTION 'Purged complaint identity cannot be reused';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecord_purged_identity" BEFORE INSERT ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_purged_identity_fn"();

CREATE OR REPLACE FUNCTION "ComplaintRecord_recovery_fn"() RETURNS trigger AS $$
DECLARE removal "ComplaintRemoval"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "ComplaintPurgeClaim" c JOIN "ComplaintPurgeAuthorization" a ON a.id=c."authorizationId" AND a."organisationId"=c."organisationId"
      WHERE c."complaintId"=OLD.id AND c."organisationId"=OLD."organisationId" AND c."transactionId"=txid_current()
      AND a."recordRevision"=OLD.revision AND a."removalId"=OLD."removalId") THEN
      RAISE EXCEPTION 'Complaint permanent purge requires a separate verified workflow';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."removedAt" IS NOT NULL OR NEW."removalId" IS NOT NULL THEN RAISE EXCEPTION 'New complaints cannot start removed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."removedAt" IS NULL AND NEW."removedAt" IS NOT NULL THEN
    SELECT * INTO removal FROM "ComplaintRemoval" WHERE id=NEW."removalId" AND "organisationId"=OLD."organisationId";
    IF NOT FOUND OR removal."complaintId" <> OLD.id OR removal."recordRevision" <> OLD.revision
      OR NEW."removedAt" IS DISTINCT FROM removal."occurredAt"
      OR timezone('UTC', clock_timestamp()) >= removal."recoveryUntil"
      OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=removal."policyId") THEN
      RAISE EXCEPTION 'Complaint removal requires matching current authority';
    END IF;
    PERFORM 1 FROM "DataRetentionPolicyRevision" WHERE id=removal."policyId" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=removal."policyId")
      OR (removal."resolutionEvidenceId" IS NOT NULL AND removal."resolutionEvidenceId" IS DISTINCT FROM
        (SELECT id FROM "ComplaintResolutionEvidence" WHERE "organisationId"=OLD."organisationId" AND "complaintId"=OLD.id
          ORDER BY revision DESC LIMIT 1)) THEN
      RAISE EXCEPTION 'Complaint removal authority changed after review';
    END IF;
  ELSIF OLD."removedAt" IS NOT NULL AND NEW."removedAt" IS NULL THEN
    SELECT * INTO removal FROM "ComplaintRemoval" WHERE id=OLD."removalId";
    IF timezone('UTC', clock_timestamp()) >= removal."recoveryUntil" THEN RAISE EXCEPTION 'Complaint recovery window expired'; END IF;
  ELSIF OLD."removedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Removed complaints cannot be edited';
  ELSE RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - ARRAY['removedAt','removalId','updatedAt','revision']) IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['removedAt','removalId','updatedAt','revision']) THEN
    RAISE EXCEPTION 'Complaint removal and restore must preserve its contents';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
