import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260710190000_add_deadline_calendar_lifecycle/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("deadline calendar migration converts civil dates and removes the unverified CLG default", () => {
  assert.match(migration, /RENAME COLUMN "lastAgmDate" TO "lastActualAgmDate"/);
  assert.match(migration, /ALTER COLUMN "legalForm" DROP DEFAULT/);
  assert.match(migration, /ALTER COLUMN "legalForm" DROP NOT NULL/);
  for (const column of [
    "financialYearEnd",
    "dateRegistered",
    "lastActualAgmDate",
    "dueDate",
  ]) {
    assert.match(migration, new RegExp(`ALTER COLUMN "${column}" TYPE DATE`));
  }
  assert.match(migration, /Organisation_memberCount_check/);
  assert.match(
    migration,
    /Organisation civil-date timestamps contain non-midnight values/,
  );
  assert.match(migration, /Deadline dueDate contains non-midnight values/);
  assert.match(migration, /calendar values exceed the supported 9997-12-31 derivation range/);
  assert.match(migration, /Deadline dueDate is outside the supported 0001-01-01 to 9999-12-31/);
  assert.match(migration, /Organisation_legalForm_confirmation_check/);
  assert.match(
    migration,
    /Organisation_croAnnualReturnDate_confirmation_check/,
  );
});

test("legacy generated deadlines are retained as superseded, explicitly unverified history", () => {
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+"Deadline"/i);
  assert.doesNotMatch(
    migration,
    /"completedDate" = COALESCE\("completedDate", "updatedAt"/,
  );
  assert.match(
    migration,
    /SET "completionDateKnown" = false[\s\S]*WHERE "isComplete" = true[\s\S]*"completedDate" IS NULL/,
  );
  assert.match(migration, /'LEGACY_UNVERIFIED'::"GeneratedDeadlineKind"/);
  assert.match(migration, /'LEGACY_MIGRATION'::"DeadlineSupersessionReason"/);
  assert.match(migration, /"supersededAt" = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(
    migration,
    /"supersededAt" = COALESCE\("updatedAt", CURRENT_TIMESTAMP\)/,
  );
  assert.match(migration, /Legacy generated deadline retained for history/);
});

test("generated lifecycle identity and profile scheduling have database race backstops", () => {
  assert.match(
    migration,
    /Deadline_organisationId_generatedKey_generationVersion_key/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Deadline_current_generated_key"/,
  );
  assert.match(
    migration,
    /WHERE "generatedKey" IS NOT NULL[\s\S]*"supersededAt" IS NULL[\s\S]*"archivedAt" IS NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "Deadline_current_profile_rule_key"/,
  );
  assert.match(
    migration,
    /Deadline_current_profile_rule_key"[\s\S]*WHERE "profileRuleKey" IS NOT NULL[\s\S]*"isComplete" = false/,
  );
  assert.match(migration, /Deadline_generated_profile_rule_exclusion_check/);
  assert.match(migration, /Deadline_generation_metadata_check/);
  assert.match(migration, /Deadline_completion_state_check/);
  assert.match(
    migration,
    /ADD COLUMN "completionDateKnown" BOOLEAN NOT NULL DEFAULT true/,
  );
  assert.match(
    migration,
    /"isComplete" = true[\s\S]*"completionDateKnown" = false[\s\S]*"completedDate" IS NULL/,
  );
  assert.match(
    migration,
    /ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 1/,
  );
  assert.match(migration, /Deadline_scheduleVersion_check/);
  assert.match(migration, /Deadline_supersededById_organisationId_fkey/);
  assert.match(
    migration,
    /DROP CONSTRAINT "DeadlineReminderLog_deadlineId_fkey"/,
  );
  assert.match(migration, /DeadlineReminderLog_deadlineId_organisationId_fkey/);
  assert.match(
    migration,
    /FOREIGN KEY \("deadlineId", "organisationId"\)[\s\S]*REFERENCES "Deadline"\("id", "organisationId"\)/,
  );
  assert.match(migration, /DeadlineReminderLog_userId_organisationId_fkey/);
  assert.match(
    migration,
    /FOREIGN KEY \("userId", "organisationId"\)[\s\S]*REFERENCES "User"\("id", "organisationId"\)/,
  );
  assert.match(migration, /deadline tenant mismatch/);
  assert.match(migration, /recipient tenant mismatch/);
});

test("annual-report backfill uses clamped month arithmetic and source/input snapshots", () => {
  assert.match(migration, /INTERVAL '10 months'/);
  assert.match(
    migration,
    /"financialYearEnd" <= DATE '9997-12-31'/,
  );
  assert.match(
    migration,
    /LEAST\([\s\S]*EXTRACT\(DAY FROM candidate\."financialYearEnd"\)[\s\S]*INTERVAL '1 month'/,
  );
  assert.match(migration, /'irish\.charity\.annual-report'/);
  assert.match(migration, /'CHARITY_ANNUAL_REPORT'::"GeneratedDeadlineKind"/);
  assert.match(
    migration,
    /'financialYearEnd', to_char\(row\."financialYearEnd", 'YYYY-MM-DD'\)/,
  );
  assert.match(
    migration,
    /https:\/\/revisedacts\.lawreform\.ie\/eli\/2009\/act\/6\/section\/52\/revised\/en\/html/,
  );
  assert.match(
    migration,
    /encode\(sha256\(convert_to\(row\."fingerprintMaterial", 'UTF8'\)\), 'hex'\)/,
  );
  assert.match(migration, /\{"dueDate":"/);
  assert.match(migration, /matching_legacy\."id" AS "matchingLegacyDeadlineId"/);
  assert.match(
    migration,
    /legacy\."dueDate" IN \(derived\."dueDate", derived\."legacyOverflowDueDate"\)/,
  );
  assert.match(migration, /derived\."legacyOverflowDueDate"/);
  assert.match(migration, /duplicate legacy annual-report occurrences require explicit reconciliation/);
  assert.match(migration, /renamed or nonstandard legacy annual-report occurrence requires explicit reconciliation/);
  assert.match(migration, /unknown or renamed legacy auto-generated deadline requires explicit reconciliation/);
  assert.match(migration, /legacy AGM occurrence has reminder evidence and requires explicit reconciliation/);
  assert.match(migration, /generated annual-report deadline id collides with an existing row/);
  assert.match(migration, /COALESCE\([\s\S]*row\."matchingLegacyDeadlineId"/);
  assert.match(migration, /ON CONFLICT \("id"\) DO UPDATE SET/);
  assert.match(migration, /"supersededAt" = NULL/);
  assert.match(migration, /COALESCE\(row\."legacyCompletionDateKnown", true\)/);
});

test("reminder history migration distinguishes reservation, attempt, and successful send", () => {
  assert.doesNotMatch(
    migration,
    /ALTER TYPE "DeadlineReminderStatus" ADD VALUE 'RESERVED'/,
  );
  assert.match(
    migration,
    /ALTER TYPE "DeadlineReminderStatus" RENAME TO "DeadlineReminderStatus_legacy"/,
  );
  assert.match(
    migration,
    /CREATE TYPE "DeadlineReminderStatus" AS ENUM \([\s\S]*'RESERVED',[\s\S]*'SENDING',[\s\S]*'SENT',[\s\S]*'SKIPPED',[\s\S]*'FAILED',[\s\S]*'UNCERTAIN'[\s\S]*\)/,
  );
  assert.match(
    migration,
    /WHEN "status"::text IN \('SENT', 'FAILED', 'SKIPPED'\) THEN 'UNCERTAIN'/,
  );
  assert.match(migration, /_p006_legacy_reminder_snapshot/);
  assert.match(migration, /DROP TYPE "DeadlineReminderStatus_legacy"/);
  assert.match(migration, /ADD COLUMN "reservedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "attemptedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "reservationToken" TEXT/);
  assert.match(migration, /ADD COLUMN "providerIdempotencyKey" TEXT/);
  assert.match(migration, /ADD COLUMN "providerRequestStartedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "providerMessageId" TEXT/);
  assert.match(migration, /ADD COLUMN "deadlineScheduleVersion" INTEGER/);
  assert.match(migration, /ADD COLUMN "deadlineTitle" TEXT/);
  assert.match(migration, /ADD COLUMN "deadlineDueDate" DATE/);
  assert.match(migration, /ADD COLUMN "deadlineSnapshotKnown" BOOLEAN NOT NULL DEFAULT true/);
  assert.match(migration, /ADD COLUMN "deliveryTimingKnown" BOOLEAN NOT NULL DEFAULT true/);
  assert.match(migration, /ADD COLUMN "legacyDeliveryStatus" TEXT/);
  assert.match(migration, /ADD COLUMN "legacyRecordedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "reconciliationOutcome" "DeadlineReminderReconciliationOutcome"/);
  assert.match(migration, /ADD COLUMN "reconciledAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "reconciledBy" TEXT/);
  assert.match(migration, /ADD COLUMN "reconciliationReference" TEXT/);
  assert.match(migration, /"deadlineSnapshotKnown" = false/);
  assert.match(migration, /"deliveryTimingKnown" = false/);
  assert.match(
    migration,
    /"deadlineScheduleVersion" = deadline\."scheduleVersion"/,
  );
  assert.match(migration, /"deadlineTitle" = snapshot\."title"/);
  assert.match(migration, /"deadlineDueDate" = snapshot\."dueDate"::date/);
  assert.match(
    migration,
    /ALTER COLUMN "deadlineScheduleVersion" SET NOT NULL/,
  );
  assert.match(migration, /DeadlineReminderLog_deadlineScheduleVersion_check/);
  assert.match(migration, /DeadlineReminderLog_legacyDeliveryStatus_check/);
  assert.match(migration, /DeadlineReminderLog_legacyProvenance_check/);
  assert.match(migration, /DeadlineReminderLog_delivery_evidence_check/);
  assert.match(migration, /DeadlineReminderLog_reconciliation_check/);
  assert.match(migration, /DeadlineReminderLog_reconciliation_immutable/);
  assert.match(migration, /Deadline reminder reconciliation evidence is immutable once recorded/);
  assert.match(migration, /Deadline_active_id_dueDate_idx/);
  assert.match(migration, /ALTER COLUMN "sentAt" DROP NOT NULL/);
  assert.match(migration, /"legacyRecordedAt" = "sentAt"/);
  assert.match(migration, /"attemptedAt" = NULL/);
  assert.match(migration, /"providerRequestStartedAt" = NULL/);
  assert.match(migration, /automatic retry is blocked unless restricted reconciliation confirms provider non-acceptance/);
  assert.match(migration, /SET "sentAt" = NULL;/);
  assert.match(migration, /DeadlineReminderLog_delivery_state_check/);
  assert.match(
    migration,
    /DROP INDEX "DeadlineReminderLog_deadlineId_email_reminderDays_key"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "DeadlineReminderLog_active_delivery_key"/,
  );
  assert.match(
    migration,
    /"reminderDays",[\s\S]*"deadlineScheduleVersion"[\s\S]*WHERE "status" IN/,
  );
  assert.match(
    migration,
    /WHERE "status" IN \([\s\S]*'RESERVED'::"DeadlineReminderStatus",[\s\S]*'SENDING'::"DeadlineReminderStatus",[\s\S]*'SENT'::"DeadlineReminderStatus"[\s\S]*OR \([\s\S]*'UNCERTAIN'::"DeadlineReminderStatus"[\s\S]*'NOT_ACCEPTED_CONFIRMED'::"DeadlineReminderReconciliationOutcome"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "DeadlineReminderLog_reservationToken_key"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "DeadlineReminderLog_providerIdempotencyKey_key"/,
  );
  assert.match(
    migration,
    /DeadlineReminderLog_organisationId_reservedAt_id_idx/,
  );
  assert.match(
    migration,
    /DeadlineReminderLog_status_providerRequestStartedAt_idx/,
  );
});
