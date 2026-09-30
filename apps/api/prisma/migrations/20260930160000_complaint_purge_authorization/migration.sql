BEGIN;
-- Review only. The permanent-delete guard remains in force until a separate
-- verified claim can atomically bind execution to this retained decision.
CREATE TABLE "ComplaintPurgeAuthorization" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "complaintId" TEXT NOT NULL,
  "recordRevision" INTEGER NOT NULL CHECK ("recordRevision">0),
  "holdRevision" INTEGER NOT NULL CHECK ("holdRevision">=0),
  "removalId" TEXT NOT NULL, "policyId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  "recoveryUntil" TIMESTAMP(3) NOT NULL, "dispositionPlan" JSONB NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id,"organisationId"),
  FOREIGN KEY ("removalId","organisationId") REFERENCES "ComplaintRemoval"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("policyId","organisationId") REFERENCES "DataRetentionPolicyRevision"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ComplaintPurgeAuthorization_history_idx" ON "ComplaintPurgeAuthorization"("organisationId","complaintId","authorizedAt",id);
CREATE TABLE "ComplaintPurgeAuthorizationWithdrawal" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL, "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("authorizationId","organisationId"),
  FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE FUNCTION "ComplaintPurgeAuthorization_insert_fn"() RETURNS trigger AS $$
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
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR')
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id)
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyRevision" p WHERE p."organisationId"=NEW."organisationId"
      AND p."recordClass"='COMPLAINT' AND p.state='APPROVED' AND p.id<>policy.id
      AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)) THEN
    RAISE EXCEPTION 'Complaint purge review requires one current approved complaint policy';
  END IF;
  IF policy."retentionMode"='AFTER_ANCHOR' THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId"
      AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.state<>'RECORDED' OR evidence."resolvedAt" IS NULL
      OR evidence."recordRevision"<>removal."recordRevision" OR policy."retentionAnchor"<>'RESOLVED_AT' THEN
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
CREATE TRIGGER "ComplaintPurgeAuthorization_insert" BEFORE INSERT ON "ComplaintPurgeAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeAuthorization_insert_fn"();
CREATE TRIGGER "ComplaintPurgeAuthorization_append_only" BEFORE UPDATE OR DELETE ON "ComplaintPurgeAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

CREATE FUNCTION "ComplaintPurgeAuthorizationWithdrawal_insert_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge withdrawal requires same-charity authorization'; END IF;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge withdrawal requires active charity Owner'; END IF;
  NEW."occurredAt":=timezone('UTC',clock_timestamp())::timestamp(3);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeAuthorizationWithdrawal_insert" BEFORE INSERT ON "ComplaintPurgeAuthorizationWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeAuthorizationWithdrawal_insert_fn"();
CREATE TRIGGER "ComplaintPurgeAuthorizationWithdrawal_append_only" BEFORE UPDATE OR DELETE ON "ComplaintPurgeAuthorizationWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();
COMMIT;
