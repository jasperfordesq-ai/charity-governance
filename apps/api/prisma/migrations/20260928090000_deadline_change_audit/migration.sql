-- Metadata-only deadline action trail, independent of the mutable calendar row.
CREATE TABLE "DeadlineChangeAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "deadlineId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousState" TEXT,
  "nextState" TEXT,
  "changedFields" TEXT[] NOT NULL,
  "previousUpdatedAt" TIMESTAMP(3),
  "nextUpdatedAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeadlineChangeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeadlineChangeAudit_action_valid" CHECK ("action" IN ('CREATE', 'UPDATE', 'COMPLETE', 'ARCHIVE', 'GENERATE', 'SUPERSEDE')),
  CONSTRAINT "DeadlineChangeAudit_actor_required" CHECK (length("actorUserId") > 0),
  CONSTRAINT "DeadlineChangeAudit_state_valid" CHECK (
    ("action" IN ('CREATE', 'GENERATE') AND "previousState" IS NULL AND "nextState" = 'OPEN')
    OR ("action" IN ('UPDATE', 'COMPLETE') AND "previousState" IN ('OPEN', 'COMPLETE') AND "nextState" IN ('OPEN', 'COMPLETE'))
    OR ("action" = 'ARCHIVE' AND "previousState" IN ('OPEN', 'COMPLETE') AND "nextState" = 'ARCHIVED')
    OR ("action" = 'SUPERSEDE' AND "previousState" IN ('OPEN', 'COMPLETE') AND "nextState" = 'SUPERSEDED')
  )
);
CREATE INDEX "DeadlineChangeAudit_organisationId_occurredAt_idx"
  ON "DeadlineChangeAudit"("organisationId", "occurredAt");
CREATE INDEX "DeadlineChangeAudit_organisationId_deadlineId_occurredAt_idx"
  ON "DeadlineChangeAudit"("organisationId", "deadlineId", "occurredAt");

CREATE FUNCTION "DeadlineChangeAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deadline change history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DeadlineChangeAudit_append_only" BEFORE UPDATE OR DELETE ON "DeadlineChangeAudit"
  FOR EACH ROW EXECUTE FUNCTION "DeadlineChangeAudit_append_only_fn"();
