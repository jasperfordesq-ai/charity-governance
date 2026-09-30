-- Metadata-only action trail for the mutable governance registers.
-- No foreign key to a live row: record deletion must not erase the event.
CREATE TABLE "GovernanceRegisterChangeAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "recordKind" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" TEXT,
  "nextStatus" TEXT,
  "changedFields" TEXT[] NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GovernanceRegisterChangeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GovernanceRegisterChangeAudit_kind_valid" CHECK (
    "recordKind" IN ('TRUSTEE', 'CONFLICT', 'COMPLAINT', 'FUNDRAISING', 'ANNUAL_REPORT', 'FINANCIAL_CONTROL')
  ),
  CONSTRAINT "GovernanceRegisterChangeAudit_action_valid" CHECK ("action" IN ('CREATE', 'UPDATE', 'DELETE')),
  CONSTRAINT "GovernanceRegisterChangeAudit_status_shape" CHECK (
    ("action" = 'CREATE' AND "previousStatus" IS NULL)
    OR "action" = 'UPDATE'
    OR ("action" = 'DELETE' AND "nextStatus" IS NULL)
  )
);
CREATE INDEX "GovernanceRegisterChangeAudit_organisationId_occurredAt_idx"
  ON "GovernanceRegisterChangeAudit"("organisationId", "occurredAt");
CREATE INDEX "GovernanceRegisterChangeAudit_org_kind_record_occurredAt_idx"
  ON "GovernanceRegisterChangeAudit"("organisationId", "recordKind", "recordId", "occurredAt");

CREATE FUNCTION "GovernanceRegisterChangeAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Governance register change history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "GovernanceRegisterChangeAudit_append_only" BEFORE UPDATE OR DELETE ON "GovernanceRegisterChangeAudit"
  FOR EACH ROW EXECUTE FUNCTION "GovernanceRegisterChangeAudit_append_only_fn"();
