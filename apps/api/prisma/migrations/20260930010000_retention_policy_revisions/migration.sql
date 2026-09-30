BEGIN;

CREATE TABLE "DataRetentionPolicyRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recordClass" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'DRAFT',
  "retentionMode" TEXT NOT NULL,
  "retentionAnchor" TEXT,
  "retentionDays" INTEGER,
  "recoveryDays" INTEGER NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvalEvidenceRef" TEXT,
  CONSTRAINT "DataRetentionPolicyRevision_id_organisationId_key" UNIQUE ("id", "organisationId"),
  CONSTRAINT "RetentionPolicy_org_class_revision_key" UNIQUE ("organisationId", "recordClass", "revision"),
  CONSTRAINT "DataRetentionPolicyRevision_class_valid" CHECK (
    "recordClass" ~ '^[A-Z][A-Z0-9_]{2,63}$' AND "revision" > 0
  ),
  CONSTRAINT "DataRetentionPolicyRevision_period_valid" CHECK (
    "recoveryDays" BETWEEN 1 AND 3650 AND
    (("retentionMode" IN ('REVIEW_REQUIRED', 'PERMANENT') AND "retentionDays" IS NULL AND "retentionAnchor" IS NULL)
      OR ("retentionMode" = 'AFTER_ANCHOR' AND "retentionDays" IS NOT NULL AND "retentionDays" BETWEEN 1 AND 36525
        AND "retentionAnchor" IS NOT NULL AND "retentionAnchor" IN (
          'CREATED_AT', 'APPROVED_AT', 'SUPERSEDED_AT', 'CEASED_AT',
          'RESOLVED_AT', 'RESPONDED_AT', 'INCIDENT_CLOSED_AT', 'CONSENT_ENDED_AT'
        )))
  ),
  CONSTRAINT "DataRetentionPolicyRevision_approval_valid" CHECK (
    char_length(btrim("createdById")) BETWEEN 1 AND 128 AND
    (("state" = 'DRAFT' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "approvalEvidenceRef" IS NULL)
      OR ("state" = 'APPROVED' AND "approvedById" IS NOT NULL AND char_length(btrim("approvedById")) BETWEEN 1 AND 128
        AND "approvedAt" IS NOT NULL AND "approvalEvidenceRef" IS NOT NULL
        AND "approvalEvidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'))
  )
);

CREATE TABLE "DataRetentionPolicyWithdrawal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataRetentionPolicyWithdrawal_policyId_organisationId_key" UNIQUE ("policyId", "organisationId"),
  CONSTRAINT "DataRetentionPolicyWithdrawal_policyId_organisationId_fkey"
    FOREIGN KEY ("policyId", "organisationId") REFERENCES "DataRetentionPolicyRevision"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataRetentionPolicyWithdrawal_input_valid" CHECK (
    char_length(btrim("actorUserId")) BETWEEN 1 AND 128 AND
    char_length(btrim("reason")) BETWEEN 10 AND 500 AND "reason" !~ '[[:cntrl:]]' AND
    "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
  )
);
CREATE INDEX "DataRetentionPolicyWithdrawal_organisationId_occurredAt_id_idx"
  ON "DataRetentionPolicyWithdrawal"("organisationId", "occurredAt", "id");

CREATE FUNCTION "DataRetentionPolicy_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Retention policy facts are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyRevision_append_only"
  BEFORE UPDATE OR DELETE ON "DataRetentionPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();
CREATE TRIGGER "DataRetentionPolicyWithdrawal_append_only"
  BEFORE UPDATE OR DELETE ON "DataRetentionPolicyWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

CREATE FUNCTION "DataRetentionPolicyRevision_actor_fn"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."createdById"
    AND "organisationId" = NEW."organisationId" AND "lifecycleStatus" = 'ACTIVE'
    AND "role" IN ('OWNER', 'ADMIN')) THEN
    RAISE EXCEPTION 'Policy creator must be an active administrator of this charity';
  END IF;
  IF NEW."state" = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."approvedById"
    AND "organisationId" = NEW."organisationId" AND "lifecycleStatus" = 'ACTIVE' AND "role" = 'OWNER') THEN
    RAISE EXCEPTION 'Policy approval requires the active charity owner';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyRevision_actor"
  BEFORE INSERT ON "DataRetentionPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicyRevision_actor_fn"();

CREATE FUNCTION "DataRetentionPolicyWithdrawal_approved_fn"() RETURNS trigger AS $$
DECLARE policy_state TEXT; approved_at TIMESTAMP(3);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."actorUserId"
    AND "organisationId" = NEW."organisationId" AND "lifecycleStatus" = 'ACTIVE' AND "role" = 'OWNER') THEN
    RAISE EXCEPTION 'Policy withdrawal requires the active charity owner';
  END IF;
  -- Purge consumers must take this same lock before checking withdrawal.
  SELECT "state", "approvedAt" INTO policy_state, approved_at
    FROM "DataRetentionPolicyRevision"
    WHERE "id" = NEW."policyId" AND "organisationId" = NEW."organisationId"
    FOR UPDATE;
  IF policy_state IS DISTINCT FROM 'APPROVED' OR NEW."occurredAt" < approved_at THEN
    RAISE EXCEPTION 'Only an approved policy can be withdrawn at or after approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataRetentionPolicyWithdrawal_approved"
  BEFORE INSERT ON "DataRetentionPolicyWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicyWithdrawal_approved_fn"();

COMMIT;
