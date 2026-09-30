BEGIN;
CREATE TABLE "ComplaintRemoval" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "complaintId" TEXT NOT NULL,
  "recordRevision" INTEGER NOT NULL, "actorUserId" TEXT NOT NULL, "policyId" TEXT NOT NULL,
  "resolutionEvidenceId" TEXT, "evidenceRef" TEXT NOT NULL, reason TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recoveryUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, "organisationId"), UNIQUE ("organisationId", "complaintId", "recordRevision"),
  FOREIGN KEY ("policyId", "organisationId") REFERENCES "DataRetentionPolicyRevision"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("recordRevision" > 0 AND "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
    AND char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]')
);
CREATE INDEX "ComplaintRemoval_organisationId_occurredAt_id_idx" ON "ComplaintRemoval"("organisationId","occurredAt",id);
ALTER TABLE "ComplaintRecord" ADD COLUMN "removedAt" TIMESTAMP(3), ADD COLUMN "removalId" TEXT;
ALTER TABLE "ComplaintRecord" ADD CONSTRAINT "ComplaintRecord_removalId_organisationId_fkey"
  FOREIGN KEY ("removalId","organisationId") REFERENCES "ComplaintRemoval"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplaintRecord" ADD CONSTRAINT "ComplaintRecord_removal_shape"
  CHECK (("removedAt" IS NULL) = ("removalId" IS NULL));

CREATE FUNCTION "ComplaintRemoval_insert_fn"() RETURNS trigger AS $$
DECLARE complaint "ComplaintRecord"%ROWTYPE; policy "DataRetentionPolicyRevision"%ROWTYPE;
  evidence "ComplaintResolutionEvidence"%ROWTYPE;
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
    OR policy."retentionMode" NOT IN ('REVIEW_REQUIRED','AFTER_ANCHOR')
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
  IF policy."retentionMode" = 'AFTER_ANCHOR' THEN
    SELECT * INTO evidence FROM "ComplaintResolutionEvidence" WHERE "organisationId"=NEW."organisationId"
      AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR evidence.id IS DISTINCT FROM NEW."resolutionEvidenceId" OR evidence.state <> 'RECORDED'
      OR evidence."recordRevision" <> complaint.revision OR evidence."resolvedAt" IS NULL
      OR evidence."resolvedAt" < complaint."receivedDate" OR policy."retentionAnchor" <> 'RESOLVED_AT'
      OR evidence."resolvedAt" + policy."retentionDays" * INTERVAL '1 day' > NEW."occurredAt" THEN
      RAISE EXCEPTION 'Removal requires elapsed retention and current resolution evidence';
    END IF;
  ELSIF NEW."resolutionEvidenceId" IS NOT NULL THEN
    RAISE EXCEPTION 'Individual review must not assert an unused resolution anchor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRemoval_insert" BEFORE INSERT ON "ComplaintRemoval"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRemoval_insert_fn"();
CREATE TRIGGER "ComplaintRemoval_append_only" BEFORE UPDATE OR DELETE ON "ComplaintRemoval"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

CREATE FUNCTION "ComplaintRecord_recovery_fn"() RETURNS trigger AS $$
DECLARE removal "ComplaintRemoval"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Complaint permanent purge requires a separate verified workflow'; END IF;
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
CREATE TRIGGER "ComplaintRecord_recovery" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_recovery_fn"();

CREATE FUNCTION "ComplaintResolutionEvidence_recovery_fn"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" AND "removedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Removed complaints cannot receive new resolution evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Runs after the existing insert guard, which locks charity then complaint.
CREATE TRIGGER "ComplaintResolutionEvidence_z_recovery" BEFORE INSERT ON "ComplaintResolutionEvidence"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintResolutionEvidence_recovery_fn"();
COMMIT;
