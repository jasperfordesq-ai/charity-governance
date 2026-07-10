CREATE TYPE "ComplianceAuditEventType" AS ENUM (
    'RECORD_BASELINE_IMPORTED',
    'RECORD_CREATED',
    'RECORD_UPDATED',
    'SIGNOFF_BASELINE_IMPORTED',
    'SIGNOFF_UPDATED',
    'APPROVAL_GRANTED',
    'APPROVAL_INVALIDATED',
    'LEGACY_APPROVAL_INVALIDATED'
);

CREATE TYPE "ComplianceApprovalInvalidationReason" AS ENUM (
    'RECORD_CHANGED',
    'MANUAL_STATUS_CHANGE',
    'LEGACY_APPROVAL_UNBOUND'
);

ALTER TABLE "ComplianceRecord"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT "ComplianceRecord_revision_check" CHECK ("revision" >= 1);

ALTER TABLE "ComplianceSignoff"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "approvalSequence" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "currentApprovalSnapshotId" TEXT,
    ADD COLUMN "invalidatedAt" TIMESTAMP(3),
    ADD COLUMN "invalidationReason" "ComplianceApprovalInvalidationReason",
    ADD COLUMN "invalidatedById" TEXT,
    ADD CONSTRAINT "ComplianceSignoff_revision_check" CHECK ("revision" >= 1),
    ADD CONSTRAINT "ComplianceSignoff_approvalSequence_check" CHECK ("approvalSequence" >= 0);

CREATE TABLE "ComplianceApprovalSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "approvalSequence" INTEGER NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "evidenceHash" CHAR(64) NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceApprovalSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComplianceApprovalSnapshot_sequence_check" CHECK ("approvalSequence" >= 1),
    CONSTRAINT "ComplianceApprovalSnapshot_formatVersion_check" CHECK ("formatVersion" >= 1),
    CONSTRAINT "ComplianceApprovalSnapshot_evidenceHash_check" CHECK ("evidenceHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ComplianceApprovalSnapshot_snapshotHash_check" CHECK ("snapshotHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "ComplianceAuditEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "type" "ComplianceAuditEventType" NOT NULL,
    "standardId" TEXT,
    "complianceRecordId" TEXT,
    "signoffId" TEXT,
    "approvalSnapshotId" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "fromRevision" INTEGER,
    "toRevision" INTEGER,
    "reason" "ComplianceApprovalInvalidationReason",
    "beforeState" JSONB,
    "afterState" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ComplianceAuditEvent_fromRevision_check" CHECK ("fromRevision" IS NULL OR "fromRevision" >= 1),
    CONSTRAINT "ComplianceAuditEvent_toRevision_check" CHECK ("toRevision" IS NULL OR "toRevision" >= 1)
);

CREATE UNIQUE INDEX "ComplianceApprovalSnapshot_organisationId_reportingYear_approvalSequence_key"
    ON "ComplianceApprovalSnapshot"("organisationId", "reportingYear", "approvalSequence");
CREATE UNIQUE INDEX "ComplianceApprovalSnapshot_id_organisationId_reportingYear_approvalSequence_key"
    ON "ComplianceApprovalSnapshot"("id", "organisationId", "reportingYear", "approvalSequence");
CREATE INDEX "ComplianceApprovalSnapshot_organisationId_reportingYear_approvedAt_idx"
    ON "ComplianceApprovalSnapshot"("organisationId", "reportingYear", "approvedAt");
CREATE UNIQUE INDEX "ComplianceSignoff_currentApprovalSnapshotId_key"
    ON "ComplianceSignoff"("currentApprovalSnapshotId");
CREATE UNIQUE INDEX "ComplianceAuditEvent_complianceRecordId_toRevision_key"
    ON "ComplianceAuditEvent"("complianceRecordId", "toRevision");
CREATE UNIQUE INDEX "ComplianceAuditEvent_signoffId_toRevision_key"
    ON "ComplianceAuditEvent"("signoffId", "toRevision");
CREATE INDEX "ComplianceAuditEvent_organisationId_reportingYear_occurredAt_idx"
    ON "ComplianceAuditEvent"("organisationId", "reportingYear", "occurredAt");
CREATE INDEX "ComplianceAuditEvent_complianceRecordId_occurredAt_idx"
    ON "ComplianceAuditEvent"("complianceRecordId", "occurredAt");

ALTER TABLE "ComplianceApprovalSnapshot"
    ADD CONSTRAINT "ComplianceApprovalSnapshot_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ComplianceSignoff"
    ADD CONSTRAINT "ComplianceSignoff_currentApprovalSnapshotId_fkey"
    FOREIGN KEY ("currentApprovalSnapshotId") REFERENCES "ComplianceApprovalSnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "ComplianceAuditEvent" (
    "id", "organisationId", "reportingYear", "type", "standardId",
    "complianceRecordId", "actorUserId", "actorName", "toRevision",
    "afterState", "occurredAt"
)
SELECT
    'p0-04-record-baseline-' || record."id",
    record."organisationId",
    record."reportingYear",
    'RECORD_BASELINE_IMPORTED'::"ComplianceAuditEventType",
    record."standardId",
    record."id",
    record."updatedById",
    actor."name",
    1,
    jsonb_build_object(
        'revision', 1,
        'status', record."status",
        'actionTaken', record."actionTaken",
        'evidence', record."evidence",
        'notes', record."notes",
        'explanationIfNA', record."explanationIfNA",
        'updatedById', record."updatedById",
        'updatedAt', record."updatedAt"
    ),
    record."updatedAt"
FROM "ComplianceRecord" record
LEFT JOIN "User" actor ON actor."id" = record."updatedById";

INSERT INTO "ComplianceAuditEvent" (
    "id", "organisationId", "reportingYear", "type", "signoffId",
    "actorUserId", "actorName", "toRevision", "afterState", "occurredAt"
)
SELECT
    'p0-04-signoff-baseline-' || signoff."id",
    signoff."organisationId",
    signoff."reportingYear",
    'SIGNOFF_BASELINE_IMPORTED'::"ComplianceAuditEventType",
    signoff."id",
    signoff."updatedById",
    actor."name",
    1,
    jsonb_build_object(
        'id', signoff."id",
        'organisationId', signoff."organisationId",
        'reportingYear', signoff."reportingYear",
        'status', signoff."status",
        'boardMeetingDate', signoff."boardMeetingDate",
        'minuteReference', signoff."minuteReference",
        'approvedByName', signoff."approvedByName",
        'approvedByRole', signoff."approvedByRole",
        'approvalNotes', signoff."approvalNotes",
        'approvedAt', signoff."approvedAt",
        'revision', 1,
        'approvalSequence', 0,
        'currentApprovalSnapshotId', NULL,
        'invalidatedAt', NULL,
        'invalidationReason', NULL,
        'invalidatedById', NULL,
        'updatedById', signoff."updatedById",
        'createdAt', signoff."createdAt",
        'updatedAt', signoff."updatedAt"
    ),
    signoff."updatedAt"
FROM "ComplianceSignoff" signoff
LEFT JOIN "User" actor ON actor."id" = signoff."updatedById"
WHERE signoff."status" <> 'APPROVED';

INSERT INTO "ComplianceAuditEvent" (
    "id", "organisationId", "reportingYear", "type", "signoffId",
    "actorUserId", "actorName", "fromRevision", "toRevision", "reason",
    "beforeState", "afterState", "occurredAt"
)
SELECT
    'p0-04-legacy-approval-' || signoff."id",
    signoff."organisationId",
    signoff."reportingYear",
    'LEGACY_APPROVAL_INVALIDATED'::"ComplianceAuditEventType",
    signoff."id",
    signoff."updatedById",
    actor."name",
    1,
    2,
    'LEGACY_APPROVAL_UNBOUND'::"ComplianceApprovalInvalidationReason",
    jsonb_build_object(
        'id', signoff."id",
        'organisationId', signoff."organisationId",
        'reportingYear', signoff."reportingYear",
        'status', signoff."status",
        'boardMeetingDate', signoff."boardMeetingDate",
        'minuteReference', signoff."minuteReference",
        'approvedByName', signoff."approvedByName",
        'approvedByRole', signoff."approvedByRole",
        'approvalNotes', signoff."approvalNotes",
        'approvedAt', signoff."approvedAt",
        'revision', 1,
        'approvalSequence', 0,
        'currentApprovalSnapshotId', NULL,
        'invalidatedAt', NULL,
        'invalidationReason', NULL,
        'invalidatedById', NULL,
        'updatedById', signoff."updatedById",
        'createdAt', signoff."createdAt",
        'updatedAt', signoff."updatedAt"
    ),
    jsonb_build_object(
        'id', signoff."id",
        'organisationId', signoff."organisationId",
        'reportingYear', signoff."reportingYear",
        'status', 'DRAFT',
        'boardMeetingDate', signoff."boardMeetingDate",
        'minuteReference', signoff."minuteReference",
        'approvedByName', signoff."approvedByName",
        'approvedByRole', signoff."approvedByRole",
        'approvalNotes', signoff."approvalNotes",
        'approvedAt', NULL,
        'revision', 2,
        'approvalSequence', 0,
        'currentApprovalSnapshotId', NULL,
        'invalidatedAt', CURRENT_TIMESTAMP,
        'invalidationReason', 'LEGACY_APPROVAL_UNBOUND',
        'invalidatedById', NULL,
        'updatedById', signoff."updatedById",
        'createdAt', signoff."createdAt",
        'updatedAt', CURRENT_TIMESTAMP
    ),
    CURRENT_TIMESTAMP
FROM "ComplianceSignoff" signoff
LEFT JOIN "User" actor ON actor."id" = signoff."updatedById"
WHERE signoff."status" = 'APPROVED';

UPDATE "ComplianceSignoff"
SET
    "status" = 'DRAFT',
    "approvedAt" = NULL,
    "revision" = 2,
    "invalidatedAt" = CURRENT_TIMESTAMP,
    "invalidationReason" = 'LEGACY_APPROVAL_UNBOUND',
    "invalidatedById" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'APPROVED';

ALTER TABLE "ComplianceSignoff"
    ADD CONSTRAINT "ComplianceSignoff_approval_state_check" CHECK (
        (
            "status" = 'APPROVED'
            AND "currentApprovalSnapshotId" IS NOT NULL
            AND "approvedAt" IS NOT NULL
            AND "invalidatedAt" IS NULL
            AND "invalidationReason" IS NULL
        )
        OR
        (
            "status" <> 'APPROVED'
            AND "currentApprovalSnapshotId" IS NULL
            AND "approvedAt" IS NULL
        )
    );

CREATE FUNCTION "validate_current_compliance_approval_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."currentApprovalSnapshotId" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "ComplianceApprovalSnapshot" snapshot
        WHERE snapshot."id" = NEW."currentApprovalSnapshotId"
          AND snapshot."organisationId" = NEW."organisationId"
          AND snapshot."reportingYear" = NEW."reportingYear"
          AND snapshot."approvalSequence" = NEW."approvalSequence"
    ) THEN
        RAISE EXCEPTION 'Current compliance approval snapshot does not match the signoff scope'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ComplianceSignoff_current_snapshot_scope_insert"
    BEFORE INSERT ON "ComplianceSignoff"
    FOR EACH ROW EXECUTE FUNCTION "validate_current_compliance_approval_snapshot"();

CREATE TRIGGER "ComplianceSignoff_current_snapshot_scope_update"
    BEFORE UPDATE OF "currentApprovalSnapshotId", "organisationId", "reportingYear", "approvalSequence"
    ON "ComplianceSignoff"
    FOR EACH ROW EXECUTE FUNCTION "validate_current_compliance_approval_snapshot"();

CREATE FUNCTION "reject_compliance_immutable_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Compliance approval snapshots and audit events are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ComplianceApprovalSnapshot_append_only"
    BEFORE UPDATE OR DELETE ON "ComplianceApprovalSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "reject_compliance_immutable_mutation"();

CREATE TRIGGER "ComplianceAuditEvent_append_only"
    BEFORE UPDATE OR DELETE ON "ComplianceAuditEvent"
    FOR EACH ROW EXECUTE FUNCTION "reject_compliance_immutable_mutation"();
