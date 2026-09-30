-- Future reminder transitions only. Existing mutable log rows cannot supply
-- a trustworthy prior-state history, so this migration does not backfill one.
CREATE TABLE "DeadlineReminderAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "reminderId" TEXT NOT NULL,
  "deadlineId" TEXT NOT NULL,
  "previousStatus" "DeadlineReminderStatus",
  "nextStatus" "DeadlineReminderStatus" NOT NULL,
  "reconciliationOutcome" "DeadlineReminderReconciliationOutcome",
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeadlineReminderAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeadlineReminderAudit_organisationId_occurredAt_id_idx"
  ON "DeadlineReminderAudit"("organisationId", "occurredAt", "id");
CREATE INDEX "DeadlineReminderAudit_organisationId_reminderId_occurredAt_id_idx"
  ON "DeadlineReminderAudit"("organisationId", "reminderId", "occurredAt", "id");

CREATE FUNCTION "DeadlineReminderAudit_record_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."reconciliationOutcome" IS DISTINCT FROM NEW."reconciliationOutcome" THEN
    INSERT INTO "DeadlineReminderAudit" (
      "id", "organisationId", "reminderId", "deadlineId", "previousStatus",
      "nextStatus", "reconciliationOutcome"
    ) VALUES (
      gen_random_uuid()::text, NEW."organisationId", NEW."id", NEW."deadlineId",
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END,
      NEW."status", NEW."reconciliationOutcome"
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DeadlineReminderAudit_record_insert"
  AFTER INSERT ON "DeadlineReminderLog"
  FOR EACH ROW EXECUTE FUNCTION "DeadlineReminderAudit_record_fn"();
CREATE TRIGGER "DeadlineReminderAudit_record_update"
  AFTER UPDATE OF "status", "reconciliationOutcome" ON "DeadlineReminderLog"
  FOR EACH ROW EXECUTE FUNCTION "DeadlineReminderAudit_record_fn"();

CREATE FUNCTION "DeadlineReminderAudit_append_only_fn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deadline reminder audit is append-only';
END;
$$;
CREATE TRIGGER "DeadlineReminderAudit_append_only"
  BEFORE UPDATE OR DELETE ON "DeadlineReminderAudit"
  FOR EACH ROW EXECUTE FUNCTION "DeadlineReminderAudit_append_only_fn"();
