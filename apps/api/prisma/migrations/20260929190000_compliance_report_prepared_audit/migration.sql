-- A separate table lets the previous application version keep reading its
-- existing ComplianceAuditEvent enum during blue-green overlap and rollback.
CREATE TABLE "ComplianceReportPreparationAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "reportingYear" INTEGER NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reportVersion" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "approvalSnapshotId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceReportPreparationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ComplianceReportPreparationAudit_shape_check" CHECK (
    ("reportVersion" = 'current' AND "audience" = 'internal' AND "approvalSnapshotId" IS NULL)
    OR
    ("reportVersion" = 'approved' AND "audience" IN ('internal', 'minimised') AND "approvalSnapshotId" IS NOT NULL)
  )
);

CREATE INDEX "ComplianceReportPreparationAudit_organisationId_occurredAt_id_idx"
  ON "ComplianceReportPreparationAudit"("organisationId", "occurredAt", "id");

CREATE TRIGGER "ComplianceReportPreparationAudit_append_only"
  BEFORE UPDATE OR DELETE ON "ComplianceReportPreparationAudit"
  FOR EACH ROW EXECUTE FUNCTION "reject_compliance_immutable_mutation"();
