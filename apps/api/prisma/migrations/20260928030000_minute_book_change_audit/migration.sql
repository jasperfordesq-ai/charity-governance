CREATE TABLE "MinuteBookChangeAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "recordKind" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "beforeState" JSONB,
  "afterState" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MinuteBookChangeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MinuteBookChangeAudit_recordKind_check" CHECK ("recordKind" IN ('ACT', 'RESOLUTION')),
  CONSTRAINT "MinuteBookChangeAudit_action_check" CHECK (
    ("action" = 'CREATE' AND "beforeState" IS NULL AND "afterState" IS NOT NULL) OR
    ("action" = 'UPDATE' AND "beforeState" IS NOT NULL AND "afterState" IS NOT NULL)
  )
);

CREATE INDEX "MinuteBookChangeAudit_organisationId_occurredAt_idx"
  ON "MinuteBookChangeAudit"("organisationId", "occurredAt");
CREATE INDEX "MinuteBookChangeAudit_organisationId_recordKind_recordId_occurredAt_idx"
  ON "MinuteBookChangeAudit"("organisationId", "recordKind", "recordId", "occurredAt");

CREATE FUNCTION "MinuteBookChangeAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Minute Book change history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MinuteBookChangeAudit_append_only" BEFORE UPDATE OR DELETE ON "MinuteBookChangeAudit"
  FOR EACH ROW EXECUTE FUNCTION "MinuteBookChangeAudit_append_only_fn"();
