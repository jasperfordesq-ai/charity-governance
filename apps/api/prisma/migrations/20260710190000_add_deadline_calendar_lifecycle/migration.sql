CREATE TYPE "GeneratedDeadlineKind" AS ENUM (
    'CHARITY_ANNUAL_REPORT',
    'COMPANY_FINANCIAL_STATEMENTS',
    'COMPANY_ANNUAL_MEMBER_ACTION',
    'CRO_ANNUAL_RETURN',
    'LEGACY_UNVERIFIED'
);

CREATE TYPE "DeadlineSupersessionReason" AS ENUM (
    'INPUT_CHANGED',
    'INPUT_REMOVED',
    'RULE_CHANGED',
    'RECURRENCE_ADVANCED',
    'LEGACY_MIGRATION'
);

CREATE TEMP TABLE "_p006_legacy_reminder_snapshot" ON COMMIT DROP AS
SELECT "id", "status"::text AS "legacyDeliveryStatus"
FROM "DeadlineReminderLog";

-- Rebuild the enum instead of ALTER TYPE ... ADD VALUE followed by using the
-- new value. PostgreSQL rejects use of a newly-added enum value before commit
-- when this multi-statement migration executes as one PostgreSQL simple query.
ALTER TYPE "DeadlineReminderStatus" RENAME TO "DeadlineReminderStatus_legacy";
CREATE TYPE "DeadlineReminderStatus" AS ENUM (
    'RESERVED',
    'SENDING',
    'SENT',
    'SKIPPED',
    'FAILED',
    'UNCERTAIN'
);
CREATE TYPE "DeadlineReminderReconciliationOutcome" AS ENUM (
    'ACCEPTED_CONFIRMED',
    'NOT_ACCEPTED_CONFIRMED',
    'UNKNOWN_ACKNOWLEDGED'
);
ALTER TABLE "DeadlineReminderLog"
    ALTER COLUMN "status" TYPE "DeadlineReminderStatus"
    USING (
        CASE
            WHEN "status"::text IN ('SENT', 'FAILED', 'SKIPPED') THEN 'UNCERTAIN'
            ELSE "status"::text
        END
    )::"DeadlineReminderStatus";
DROP TYPE "DeadlineReminderStatus_legacy";

-- Civil dates are legal/calendar facts, not instants. Legacy non-midnight
-- timestamps cannot be truncated safely because their original timezone intent
-- is unknowable. Abort for explicit reconciliation instead of changing truth.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Organisation"
        WHERE (
                "financialYearEnd" IS NOT NULL
                AND "financialYearEnd" <> date_trunc('day', "financialYearEnd")
            )
            OR (
                "dateRegistered" IS NOT NULL
                AND "dateRegistered" <> date_trunc('day', "dateRegistered")
            )
            OR (
                "lastAgmDate" IS NOT NULL
                AND "lastAgmDate" <> date_trunc('day', "lastAgmDate")
            )
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: Organisation civil-date timestamps contain non-midnight values; reconcile them explicitly before retrying';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Deadline"
        WHERE "dueDate" IS NOT NULL
          AND "dueDate" <> date_trunc('day', "dueDate")
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: Deadline dueDate contains non-midnight values; reconcile them explicitly before retrying';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Organisation"
        WHERE "financialYearEnd" < TIMESTAMP '0001-01-01 00:00:00'
           OR "financialYearEnd" > TIMESTAMP '9997-12-31 00:00:00'
           OR "dateRegistered" < TIMESTAMP '0001-01-01 00:00:00'
           OR "dateRegistered" > TIMESTAMP '9997-12-31 00:00:00'
           OR "lastAgmDate" < TIMESTAMP '0001-01-01 00:00:00'
           OR "lastAgmDate" > TIMESTAMP '9997-12-31 00:00:00'
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: Organisation calendar values exceed the supported 9997-12-31 derivation range';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Deadline"
        WHERE "dueDate" < TIMESTAMP '0001-01-01 00:00:00'
           OR "dueDate" > TIMESTAMP '9999-12-31 00:00:00'
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: Deadline dueDate is outside the supported 0001-01-01 to 9999-12-31 civil-date range';
    END IF;
END $$;

-- Freeze the only legacy occurrence facts that reminder logs can truthfully
-- inherit before any generated row is promoted, renamed or date-normalized.
CREATE TEMP TABLE "_p006_legacy_deadline_snapshot" ON COMMIT DROP AS
SELECT "id", "title", "dueDate"
FROM "Deadline";

ALTER TABLE "Organisation"
    RENAME COLUMN "lastAgmDate" TO "lastActualAgmDate";

ALTER TABLE "Organisation"
    ALTER COLUMN "legalForm" DROP DEFAULT,
    ALTER COLUMN "legalForm" DROP NOT NULL,
    ALTER COLUMN "financialYearEnd" TYPE DATE USING ("financialYearEnd"::date),
    ALTER COLUMN "dateRegistered" TYPE DATE USING ("dateRegistered"::date),
    ALTER COLUMN "lastActualAgmDate" TYPE DATE USING ("lastActualAgmDate"::date),
    ADD COLUMN "legalFormConfirmedAt" TIMESTAMP(3),
    ADD COLUMN "incorporationDate" DATE,
    ADD COLUMN "croAnnualReturnDate" DATE,
    ADD COLUMN "croAnnualReturnDateConfirmedAt" TIMESTAMP(3),
    ADD COLUMN "lastUnanimousAnnualMemberResolutionDate" DATE,
    ADD COLUMN "memberCount" INTEGER,
    ADD CONSTRAINT "Organisation_memberCount_check" CHECK (
        "memberCount" IS NULL OR "memberCount" >= 1
    ),
    ADD CONSTRAINT "Organisation_legalForm_confirmation_check" CHECK (
        "legalFormConfirmedAt" IS NULL OR "legalForm" IS NOT NULL
    ),
    ADD CONSTRAINT "Organisation_croAnnualReturnDate_confirmation_check" CHECK (
        "croAnnualReturnDateConfirmedAt" IS NULL OR "croAnnualReturnDate" IS NOT NULL
    );

ALTER TABLE "Deadline"
    ALTER COLUMN "dueDate" TYPE DATE USING ("dueDate"::date),
    ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "generatedKind" "GeneratedDeadlineKind",
    ADD COLUMN "generatedKey" TEXT,
    ADD COLUMN "generationVersion" INTEGER,
    ADD COLUMN "generationRuleVersion" INTEGER,
    ADD COLUMN "generationFingerprint" CHAR(64),
    ADD COLUMN "generationSource" JSONB,
    ADD COLUMN "generationInputs" JSONB,
    ADD COLUMN "profileRuleKey" TEXT,
    ADD COLUMN "completionDateKnown" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "supersededAt" TIMESTAMP(3),
    ADD COLUMN "supersededById" TEXT,
    ADD COLUMN "supersessionReason" "DeadlineSupersessionReason",
    ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Preserve legacy truth without fabricating a completion timestamp from an
-- unrelated row-update timestamp.
UPDATE "Deadline"
SET "completionDateKnown" = false
WHERE "isComplete" = true
  AND "completedDate" IS NULL;

UPDATE "Deadline"
SET
    "completedDate" = NULL,
    "completionDateKnown" = true
WHERE "isComplete" = false;

-- Existing generated rows do not have trustworthy rule inputs or provenance.
-- Retain them as immutable, superseded history instead of deleting or silently
-- treating their title-derived dates as current legal guidance.
UPDATE "Deadline"
SET
    "generatedKind" = 'LEGACY_UNVERIFIED'::"GeneratedDeadlineKind",
    "generatedKey" = 'legacy:' || "id",
    "generationVersion" = 1,
    "generationRuleVersion" = 1,
    "generationFingerprint" =
        md5(concat_ws('|', "organisationId", "id", "title", "dueDate"::text)) ||
        md5('p0-06:' || concat_ws('|', "organisationId", "id", "title", "dueDate"::text)),
    "generationSource" = jsonb_build_object(
        'type', 'LEGACY_UNVERIFIED',
        'migration', '20260710190000_add_deadline_calendar_lifecycle',
        'warning', 'Legacy generated deadline retained for history; source and calculation inputs were not recorded.'
    ),
    "generationInputs" = jsonb_build_object(
        'legacyTitle', "title",
        'legacyDueDate', to_char("dueDate", 'YYYY-MM-DD')
    ),
    "supersededAt" = CURRENT_TIMESTAMP,
    "supersessionReason" = 'LEGACY_MIGRATION'::"DeadlineSupersessionReason"
WHERE "isAutoGenerated" = true;

DROP INDEX "Deadline_organisationId_idx";

CREATE UNIQUE INDEX "Deadline_id_organisationId_key"
    ON "Deadline"("id", "organisationId");
CREATE UNIQUE INDEX "Deadline_supersededById_organisationId_key"
    ON "Deadline"("supersededById", "organisationId");
CREATE UNIQUE INDEX "Deadline_organisationId_generatedKey_generationVersion_key"
    ON "Deadline"("organisationId", "generatedKey", "generationVersion");
CREATE UNIQUE INDEX "Deadline_current_generated_key"
    ON "Deadline"("organisationId", "generatedKey")
    WHERE "generatedKey" IS NOT NULL
      AND "supersededAt" IS NULL
      AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "Deadline_current_profile_rule_key"
    ON "Deadline"("organisationId", "profileRuleKey")
    WHERE "profileRuleKey" IS NOT NULL
      AND "supersededAt" IS NULL
      AND "archivedAt" IS NULL
      AND "isComplete" = false;
CREATE INDEX "Deadline_organisationId_supersededAt_archivedAt_dueDate_idx"
    ON "Deadline"("organisationId", "supersededAt", "archivedAt", "dueDate");
CREATE INDEX "Deadline_organisationId_isComplete_dueDate_idx"
    ON "Deadline"("organisationId", "isComplete", "dueDate");
CREATE INDEX "Deadline_dueDate_id_idx"
    ON "Deadline"("dueDate", "id");
CREATE INDEX "Deadline_active_dueDate_id_idx"
    ON "Deadline"("dueDate", "id")
    WHERE "isComplete" = false
      AND "supersededAt" IS NULL
      AND "archivedAt" IS NULL;
CREATE INDEX "Deadline_active_id_dueDate_idx"
    ON "Deadline"("id", "dueDate")
    WHERE "isComplete" = false
      AND "supersededAt" IS NULL
      AND "archivedAt" IS NULL;

ALTER TABLE "Deadline"
    ADD CONSTRAINT "Deadline_generation_metadata_check" CHECK (
        (
            "isAutoGenerated" = false
            AND "generatedKind" IS NULL
            AND "generatedKey" IS NULL
            AND "generationVersion" IS NULL
            AND "generationRuleVersion" IS NULL
            AND "generationFingerprint" IS NULL
            AND "generationSource" IS NULL
            AND "generationInputs" IS NULL
        )
        OR
        (
            "isAutoGenerated" = true
            AND "generatedKind" IS NOT NULL
            AND "generatedKey" IS NOT NULL
            AND "generationVersion" IS NOT NULL
            AND "generationRuleVersion" IS NOT NULL
            AND "generationFingerprint" IS NOT NULL
            AND "generationSource" IS NOT NULL
            AND "generationInputs" IS NOT NULL
        )
    ),
    ADD CONSTRAINT "Deadline_generation_version_check" CHECK (
        ("generationVersion" IS NULL OR "generationVersion" >= 1)
        AND ("generationRuleVersion" IS NULL OR "generationRuleVersion" >= 1)
    ),
    ADD CONSTRAINT "Deadline_scheduleVersion_check" CHECK (
        "scheduleVersion" >= 1
    ),
    ADD CONSTRAINT "Deadline_generation_fingerprint_check" CHECK (
        "generationFingerprint" IS NULL
        OR "generationFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT "Deadline_generation_json_check" CHECK (
        ("generationSource" IS NULL OR jsonb_typeof("generationSource") = 'object')
        AND ("generationInputs" IS NULL OR jsonb_typeof("generationInputs") = 'object')
    ),
    ADD CONSTRAINT "Deadline_completion_state_check" CHECK (
        (
            "isComplete" = true
            AND "completionDateKnown" = true
            AND "completedDate" IS NOT NULL
        )
        OR
        (
            "isComplete" = true
            AND "completionDateKnown" = false
            AND "completedDate" IS NULL
        )
        OR
        (
            "isComplete" = false
            AND "completionDateKnown" = true
            AND "completedDate" IS NULL
        )
    ),
    ADD CONSTRAINT "Deadline_supersession_state_check" CHECK (
        (
            "supersededAt" IS NULL
            AND "supersessionReason" IS NULL
            AND "supersededById" IS NULL
        )
        OR
        (
            "supersededAt" IS NOT NULL
            AND "supersessionReason" IS NOT NULL
        )
    ),
    ADD CONSTRAINT "Deadline_profile_rule_key_check" CHECK (
        "profileRuleKey" IS NULL OR "profileRuleKey" IN (
            'hasPaidStaff',
            'hasVolunteers',
            'raisesFundsFromPublic',
            'worksWithChildrenOrVulnerableAdults',
            'processesPersonalData',
            'operatesPremisesOrEvents',
            'isPublicSectorBody',
            'usesDataProcessors'
        )
    ),
    ADD CONSTRAINT "Deadline_generated_profile_rule_exclusion_check" CHECK (
        "isAutoGenerated" = false OR "profileRuleKey" IS NULL
    );

ALTER TABLE "Deadline"
    ADD CONSTRAINT "Deadline_supersededById_organisationId_fkey"
    FOREIGN KEY ("supersededById", "organisationId")
    REFERENCES "Deadline"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A tenant mismatch may expose a recipient address to the wrong organisation.
-- Do not silently rewrite it: abort so operators can investigate and reconcile
-- the identity, deadline and recipient as an explicit incident response.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "DeadlineReminderLog" reminder
        JOIN "Deadline" deadline ON deadline."id" = reminder."deadlineId"
        WHERE reminder."organisationId" <> deadline."organisationId"
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: DeadlineReminderLog contains a deadline tenant mismatch';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "DeadlineReminderLog" reminder
        JOIN "User" recipient ON recipient."id" = reminder."userId"
        WHERE reminder."userId" IS NOT NULL
          AND reminder."organisationId" <> recipient."organisationId"
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: DeadlineReminderLog contains a recipient tenant mismatch';
    END IF;
END $$;

CREATE UNIQUE INDEX "User_id_organisationId_key"
    ON "User"("id", "organisationId");

ALTER TABLE "DeadlineReminderLog"
    DROP CONSTRAINT "DeadlineReminderLog_deadlineId_fkey",
    DROP CONSTRAINT "DeadlineReminderLog_userId_fkey",
    ADD CONSTRAINT "DeadlineReminderLog_deadlineId_organisationId_fkey"
    FOREIGN KEY ("deadlineId", "organisationId")
    REFERENCES "Deadline"("id", "organisationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "DeadlineReminderLog_userId_organisationId_fkey"
    FOREIGN KEY ("userId", "organisationId")
    REFERENCES "User"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The legacy generator had no database uniqueness backstop. If more than one
-- row can represent the same annual-report occurrence, choosing one would leave
-- another independent reminder identity capable of defeating deduplication.
-- Abort for explicit reconciliation instead of silently discarding evidence.
DO $$
BEGIN
    -- Before P0-06, generated rows could still be edited through the ordinary
    -- deadline update path. Only the two historical generator title shapes are
    -- therefore safe to classify automatically. An arbitrary renamed row may
    -- carry delivery history for the current occurrence; archiving it and
    -- creating a replacement could cause a duplicate reminder.
    IF EXISTS (
        SELECT 1
        FROM "Deadline" legacy
        WHERE legacy."isAutoGenerated" = true
          AND legacy."title" <> 'AGM due date'
          AND legacy."title" !~ '^Annual Report filing deadline \([0-9]{4}\)$'
          AND NOT (
              legacy."title" = 'Annual Report filing'
              AND legacy."description" = 'File the charity Annual Report with the Charities Regulator within 10 months of financial year end.'
              AND legacy."isComplete" = false
              AND NOT EXISTS (
                  SELECT 1
                  FROM "DeadlineReminderLog" reminder
                  WHERE reminder."deadlineId" = legacy."id"
              )
          )
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: an unknown or renamed legacy auto-generated deadline requires explicit reconciliation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Deadline" legacy
        JOIN "DeadlineReminderLog" reminder ON reminder."deadlineId" = legacy."id"
        WHERE legacy."isAutoGenerated" = true
          AND legacy."title" = 'AGM due date'
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: a legacy AGM occurrence has reminder evidence and requires explicit reconciliation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Deadline" legacy
        WHERE legacy."isAutoGenerated" = true
          AND legacy."title" ~ '^Annual Report filing deadline \([0-9]{4}\)$'
          AND substring(legacy."title" FROM '\(([0-9]{4})\)$')::integer NOT BETWEEN 1 AND 9997
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: a legacy annual-report title year is outside the supported derivation range';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "Deadline" legacy
        JOIN "DeadlineReminderLog" reminder ON reminder."deadlineId" = legacy."id"
        JOIN "Organisation" organisation ON organisation."id" = legacy."organisationId"
        WHERE legacy."isAutoGenerated" = true
          AND legacy."title" ~ '^Annual Report filing deadline \([0-9]{4}\)$'
          AND organisation."financialYearEnd" IS NULL
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: a legacy annual-report occurrence with reminder evidence has no financial year end for classification';
    END IF;

    IF EXISTS (
        WITH canonical AS (
            SELECT
                legacy."id",
                legacy."dueDate" AS "legacyDueDate",
                organisation."financialYearEnd",
                substring(legacy."title" FROM '\(([0-9]{4})\)$')::integer AS "titleYear",
                make_date(
                    substring(legacy."title" FROM '\(([0-9]{4})\)$')::integer,
                    EXTRACT(MONTH FROM organisation."financialYearEnd")::integer,
                    1
                ) AS "financialYearMonthStart"
            FROM "Deadline" legacy
            JOIN "Organisation" organisation ON organisation."id" = legacy."organisationId"
            WHERE legacy."isAutoGenerated" = true
              AND legacy."title" ~ '^Annual Report filing deadline \([0-9]{4}\)$'
              AND organisation."financialYearEnd" IS NOT NULL
              AND substring(legacy."title" FROM '\(([0-9]{4})\)$')::integer BETWEEN 1 AND 9997
        ),
        fiscal_year_ends AS (
            SELECT
                canonical.*,
                (
                    canonical."financialYearMonthStart"
                    + (
                        LEAST(
                            EXTRACT(DAY FROM canonical."financialYearEnd")::integer,
                            EXTRACT(
                                DAY FROM (
                                    canonical."financialYearMonthStart" + INTERVAL '1 month' - INTERVAL '1 day'
                                )
                            )::integer
                        ) - 1
                    ) * INTERVAL '1 day'
                )::date AS "titleFinancialYearEnd"
            FROM canonical
        ),
        candidates AS (
            SELECT
                fiscal_year_ends.*,
                (
                    date_trunc('month', fiscal_year_ends."titleFinancialYearEnd") + INTERVAL '10 months'
                )::date AS "targetMonthStart"
            FROM fiscal_year_ends
        ),
        dates AS (
            SELECT
                candidate.*,
                (
                    candidate."targetMonthStart"
                    + (
                        LEAST(
                            EXTRACT(DAY FROM candidate."titleFinancialYearEnd")::integer,
                            EXTRACT(
                                DAY FROM (
                                    candidate."targetMonthStart" + INTERVAL '1 month' - INTERVAL '1 day'
                                )
                            )::integer
                        ) - 1
                    ) * INTERVAL '1 day'
                )::date AS "expectedDueDate",
                (
                    candidate."targetMonthStart"
                    + (EXTRACT(DAY FROM candidate."titleFinancialYearEnd")::integer - 1) * INTERVAL '1 day'
                )::date AS "legacyOverflowDueDate"
            FROM candidates candidate
        )
        SELECT 1
        FROM dates derived
        WHERE derived."legacyDueDate" NOT IN (
            derived."expectedDueDate",
            derived."legacyOverflowDueDate"
        )
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: a renamed or nonstandard legacy annual-report occurrence requires explicit reconciliation';
    END IF;

    IF EXISTS (
        WITH candidates AS (
            SELECT
                organisation."id" AS "organisationId",
                organisation."financialYearEnd" AS "financialYearEnd",
                (date_trunc('month', organisation."financialYearEnd") + INTERVAL '10 months')::date
                    AS "targetMonthStart"
            FROM "Organisation" organisation
            WHERE organisation."financialYearEnd" IS NOT NULL
        ),
        dates AS (
            SELECT
                candidate.*,
                (
                    candidate."targetMonthStart"
                    + (
                        LEAST(
                            EXTRACT(DAY FROM candidate."financialYearEnd")::integer,
                            EXTRACT(
                                DAY FROM (
                                    candidate."targetMonthStart" + INTERVAL '1 month' - INTERVAL '1 day'
                                )
                            )::integer
                        ) - 1
                    ) * INTERVAL '1 day'
                )::date AS "dueDate",
                (
                    candidate."targetMonthStart"
                    + (EXTRACT(DAY FROM candidate."financialYearEnd")::integer - 1) * INTERVAL '1 day'
                )::date AS "legacyOverflowDueDate"
            FROM candidates candidate
        )
        SELECT 1
        FROM dates derived
        JOIN "Deadline" legacy ON legacy."organisationId" = derived."organisationId"
        WHERE legacy."isAutoGenerated" = true
          AND (
              (
                  legacy."title" = (
                      'Annual Report filing deadline (' ||
                      EXTRACT(YEAR FROM derived."financialYearEnd")::integer::text ||
                      ')'
                  )
                  AND legacy."dueDate" NOT IN (derived."dueDate", derived."legacyOverflowDueDate")
              )
              OR
              (
                  legacy."title" ~ '^Annual Report filing deadline \([0-9]{4}\)$'
                  AND legacy."title" <> (
                      'Annual Report filing deadline (' ||
                      EXTRACT(YEAR FROM derived."financialYearEnd")::integer::text ||
                      ')'
                  )
                  AND legacy."dueDate" IN (derived."dueDate", derived."legacyOverflowDueDate")
              )
          )
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: a renamed or nonstandard legacy annual-report occurrence requires explicit reconciliation';
    END IF;

    IF EXISTS (
        WITH candidates AS (
            SELECT
                organisation."id" AS "organisationId",
                organisation."financialYearEnd" AS "financialYearEnd",
                (date_trunc('month', organisation."financialYearEnd") + INTERVAL '10 months')::date
                    AS "targetMonthStart"
            FROM "Organisation" organisation
            WHERE organisation."financialYearEnd" IS NOT NULL
        ),
        dates AS (
            SELECT
                candidate.*,
                (
                    candidate."targetMonthStart"
                    + (
                        LEAST(
                            EXTRACT(DAY FROM candidate."financialYearEnd")::integer,
                            EXTRACT(
                                DAY FROM (
                                    candidate."targetMonthStart" + INTERVAL '1 month' - INTERVAL '1 day'
                                )
                            )::integer
                        ) - 1
                    ) * INTERVAL '1 day'
                )::date AS "dueDate",
                (
                    candidate."targetMonthStart"
                    + (EXTRACT(DAY FROM candidate."financialYearEnd")::integer - 1) * INTERVAL '1 day'
                )::date AS "legacyOverflowDueDate"
            FROM candidates candidate
        )
        SELECT 1
        FROM dates derived
        JOIN "Deadline" legacy
          ON legacy."organisationId" = derived."organisationId"
         AND legacy."isAutoGenerated" = true
         AND legacy."title" = (
             'Annual Report filing deadline (' ||
             EXTRACT(YEAR FROM derived."financialYearEnd")::integer::text ||
             ')'
         )
         AND legacy."dueDate" IN (derived."dueDate", derived."legacyOverflowDueDate")
        GROUP BY derived."organisationId"
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: duplicate legacy annual-report occurrences require explicit reconciliation';
    END IF;

    IF EXISTS (
        WITH candidates AS (
            SELECT
                organisation."id" AS "organisationId",
                organisation."financialYearEnd" AS "financialYearEnd",
                (date_trunc('month', organisation."financialYearEnd") + INTERVAL '10 months')::date
                    AS "targetMonthStart"
            FROM "Organisation" organisation
            WHERE organisation."financialYearEnd" IS NOT NULL
        ),
        dates AS (
            SELECT
                candidate.*,
                (
                    candidate."targetMonthStart"
                    + (
                        LEAST(
                            EXTRACT(DAY FROM candidate."financialYearEnd")::integer,
                            EXTRACT(
                                DAY FROM (
                                    candidate."targetMonthStart" + INTERVAL '1 month' - INTERVAL '1 day'
                                )
                            )::integer
                        ) - 1
                    ) * INTERVAL '1 day'
                )::date AS "dueDate",
                (
                    candidate."targetMonthStart"
                    + (EXTRACT(DAY FROM candidate."financialYearEnd")::integer - 1) * INTERVAL '1 day'
                )::date AS "legacyOverflowDueDate"
            FROM candidates candidate
        )
        SELECT 1
        FROM dates derived
        JOIN "Deadline" collision
          ON collision."id" = (
              'p006-annual-report-' ||
              md5(derived."organisationId" || '|' || derived."financialYearEnd"::text)
          )
        WHERE NOT EXISTS (
            SELECT 1
            FROM "Deadline" matching_legacy
            WHERE matching_legacy."organisationId" = derived."organisationId"
              AND matching_legacy."isAutoGenerated" = true
              AND matching_legacy."title" = (
                  'Annual Report filing deadline (' ||
                  EXTRACT(YEAR FROM derived."financialYearEnd")::integer::text ||
                  ')'
              )
              AND matching_legacy."dueDate" IN (
                  derived."dueDate",
                  derived."legacyOverflowDueDate"
              )
        )
    ) THEN
        RAISE EXCEPTION
            'P0-06 migration blocked: generated annual-report deadline id collides with an existing row';
    END IF;
END $$;

-- Replace the archived legacy Annual Report rows with one correctly clamped,
-- current rule instance for every organisation that has a financial year end.
WITH annual_report_candidates AS (
    SELECT
        organisation."id" AS "organisationId",
        organisation."financialYearEnd" AS "financialYearEnd",
        (date_trunc('month', organisation."financialYearEnd") + INTERVAL '10 months')::date
            AS "targetMonthStart"
    FROM "Organisation" organisation
    WHERE organisation."financialYearEnd" IS NOT NULL
      AND organisation."financialYearEnd" <= DATE '9997-12-31'
),
annual_report_dates AS (
    SELECT
        candidate."organisationId",
        candidate."financialYearEnd",
        (
            candidate."targetMonthStart"
            + (
                LEAST(
                    EXTRACT(DAY FROM candidate."financialYearEnd")::integer,
                    EXTRACT(
                        DAY FROM (candidate."targetMonthStart" + INTERVAL '1 month' - INTERVAL '1 day')
                    )::integer
                ) - 1
            ) * INTERVAL '1 day'
        )::date AS "dueDate",
        (
            candidate."targetMonthStart"
            + (EXTRACT(DAY FROM candidate."financialYearEnd")::integer - 1) * INTERVAL '1 day'
        )::date AS "legacyOverflowDueDate"
    FROM annual_report_candidates candidate
),
annual_report_rows AS (
    SELECT
        derived.*,
        matching_legacy."id" AS "matchingLegacyDeadlineId",
        matching_legacy."isComplete" AS "legacyIsComplete",
        matching_legacy."completedDate" AS "legacyCompletedDate",
        matching_legacy."completionDateKnown" AS "legacyCompletionDateKnown",
        matching_legacy."reminderDays" AS "legacyReminderDays",
        matching_legacy."createdAt" AS "legacyCreatedAt",
        '{"dueDate":"' || derived."dueDate"::text ||
        '","inputs":{"financialYearEnd":"' || derived."financialYearEnd"::text ||
        '","monthArithmetic":"calendar-months-with-missing-day-clamped-to-month-end"}' ||
        ',"key":"irish.charity.annual-report"' ||
        ',"professionalReviewRequired":true' ||
        ',"ruleVersion":1' ||
        ',"sources":[{"authority":"Law Reform Commission"' ||
        ',"checkedAt":"2026-07-10"' ||
        ',"classification":"statutory"' ||
        ',"title":"Charities Act 2009, section 52 (revised)"' ||
        ',"url":"https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html"}]' ||
        ',"warnings":["Month-end clamping is a documented planning convention, not professional advice."' ||
        ',"A regulator-approved longer period must be recorded separately and must not be inferred."]}'
            AS "fingerprintMaterial"
    FROM annual_report_dates derived
    LEFT JOIN LATERAL (
        SELECT
            legacy."id",
            legacy."isComplete",
            legacy."completedDate",
            legacy."completionDateKnown",
            legacy."reminderDays",
            legacy."createdAt"
        FROM "Deadline" legacy
        WHERE legacy."organisationId" = derived."organisationId"
          AND legacy."isAutoGenerated" = true
          AND legacy."title" = (
              'Annual Report filing deadline (' ||
              EXTRACT(YEAR FROM derived."financialYearEnd")::integer::text ||
              ')'
          )
          AND legacy."dueDate" IN (derived."dueDate", derived."legacyOverflowDueDate")
        ORDER BY
            legacy."isComplete" DESC,
            EXISTS (
                SELECT 1
                FROM "DeadlineReminderLog" reminder
                WHERE reminder."deadlineId" = legacy."id"
                  AND reminder."status" IN (
                      'SENT'::"DeadlineReminderStatus",
                      'UNCERTAIN'::"DeadlineReminderStatus"
                  )
            ) DESC,
            legacy."completedDate" DESC NULLS LAST,
            legacy."id" DESC
        LIMIT 1
    ) matching_legacy ON true
)
INSERT INTO "Deadline" (
    "id",
    "organisationId",
    "title",
    "description",
    "dueDate",
    "isAutoGenerated",
    "generatedKind",
    "generatedKey",
    "generationVersion",
    "generationRuleVersion",
    "generationFingerprint",
    "generationSource",
    "generationInputs",
    "isComplete",
    "completedDate",
    "completionDateKnown",
    "reminderDays",
    "createdAt",
    "updatedAt"
)
SELECT
    COALESCE(
        row."matchingLegacyDeadlineId",
        'p006-annual-report-' || md5(row."organisationId" || '|' || row."financialYearEnd"::text)
    ),
    row."organisationId",
    'Charities Regulator annual report',
    'Calculated planning date: ten calendar months after the recorded financial year end. Confirm the live date in MyAccount and obtain professional advice for extensions or edge cases.',
    row."dueDate",
    true,
    'CHARITY_ANNUAL_REPORT'::"GeneratedDeadlineKind",
    'irish.charity.annual-report',
    1,
    1,
    encode(sha256(convert_to(row."fingerprintMaterial", 'UTF8')), 'hex'),
    jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
            'authority', 'Law Reform Commission',
            'title', 'Charities Act 2009, section 52 (revised)',
            'url', 'https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html',
            'checkedAt', '2026-07-10',
            'classification', 'statutory'
        )),
        'professionalReviewRequired', true,
        'warnings', jsonb_build_array(
            'Month-end clamping is a documented planning convention, not professional advice.',
            'A regulator-approved longer period must be recorded separately and must not be inferred.'
        )
    ),
    jsonb_build_object(
        'financialYearEnd', to_char(row."financialYearEnd", 'YYYY-MM-DD'),
        'monthArithmetic', 'calendar-months-with-missing-day-clamped-to-month-end'
    ),
    COALESCE(row."legacyIsComplete", false),
    row."legacyCompletedDate",
    COALESCE(row."legacyCompletionDateKnown", true),
    COALESCE(row."legacyReminderDays", ARRAY[30, 14, 7]::INTEGER[]),
    COALESCE(row."legacyCreatedAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM annual_report_rows row
ON CONFLICT ("id") DO UPDATE SET
    "title" = EXCLUDED."title",
    "description" = EXCLUDED."description",
    "dueDate" = EXCLUDED."dueDate",
    "isAutoGenerated" = true,
    "generatedKind" = EXCLUDED."generatedKind",
    "generatedKey" = EXCLUDED."generatedKey",
    "generationVersion" = EXCLUDED."generationVersion",
    "generationRuleVersion" = EXCLUDED."generationRuleVersion",
    "generationFingerprint" = EXCLUDED."generationFingerprint",
    "generationSource" = EXCLUDED."generationSource",
    "generationInputs" = EXCLUDED."generationInputs",
    "profileRuleKey" = NULL,
    "isComplete" = EXCLUDED."isComplete",
    "completedDate" = EXCLUDED."completedDate",
    "completionDateKnown" = EXCLUDED."completionDateKnown",
    "reminderDays" = EXCLUDED."reminderDays",
    "supersededAt" = NULL,
    "supersededById" = NULL,
    "supersessionReason" = NULL,
    "archivedAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "DeadlineReminderLog"
    ADD COLUMN "deadlineScheduleVersion" INTEGER,
    ADD COLUMN "deadlineTitle" TEXT,
    ADD COLUMN "deadlineDueDate" DATE,
    ADD COLUMN "deadlineSnapshotKnown" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "deliveryTimingKnown" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "legacyDeliveryStatus" TEXT,
    ADD COLUMN "legacyRecordedAt" TIMESTAMP(3),
    ADD COLUMN "reservedAt" TIMESTAMP(3),
    ADD COLUMN "attemptedAt" TIMESTAMP(3),
    ADD COLUMN "reservationToken" TEXT,
    ADD COLUMN "providerIdempotencyKey" TEXT,
    ADD COLUMN "providerRequestStartedAt" TIMESTAMP(3),
    ADD COLUMN "providerMessageId" TEXT,
    ADD COLUMN "reconciliationOutcome" "DeadlineReminderReconciliationOutcome",
    ADD COLUMN "reconciledAt" TIMESTAMP(3),
    ADD COLUMN "reconciledBy" TEXT,
    ADD COLUMN "reconciliationReference" TEXT,
    ALTER COLUMN "sentAt" DROP DEFAULT,
    ALTER COLUMN "sentAt" DROP NOT NULL;

UPDATE "DeadlineReminderLog"
SET
    "deadlineSnapshotKnown" = false,
    "deliveryTimingKnown" = false,
    "legacyRecordedAt" = "sentAt",
    "reservedAt" = "sentAt",
    "attemptedAt" = NULL,
    "providerRequestStartedAt" = NULL,
    "reservationToken" = 'legacy:' || "id";

UPDATE "DeadlineReminderLog" reminder
SET
    "deadlineScheduleVersion" = deadline."scheduleVersion",
    "deadlineTitle" = snapshot."title",
    "deadlineDueDate" = snapshot."dueDate"::date
FROM "Deadline" deadline, "_p006_legacy_deadline_snapshot" snapshot
WHERE reminder."deadlineId" = deadline."id"
  AND snapshot."id" = deadline."id";

UPDATE "DeadlineReminderLog" reminder
SET "legacyDeliveryStatus" = snapshot."legacyDeliveryStatus"
FROM "_p006_legacy_reminder_snapshot" snapshot
WHERE snapshot."id" = reminder."id";

UPDATE "DeadlineReminderLog"
SET "sentAt" = NULL;

UPDATE "DeadlineReminderLog"
SET "error" = concat_ws(
    '; ',
    NULLIF("error", ''),
    'Legacy provider outcome unknown; automatic retry is blocked unless restricted reconciliation confirms provider non-acceptance'
)
WHERE "status" = 'UNCERTAIN'::"DeadlineReminderStatus";

UPDATE "DeadlineReminderLog"
SET "error" = concat_ws(
    '; ',
    NULLIF("error", ''),
    'Legacy pre-P0-06 occurrence snapshot was not recorded; migration-time title and due date are shown'
);

ALTER TABLE "DeadlineReminderLog"
    ALTER COLUMN "deadlineScheduleVersion" SET NOT NULL,
    ALTER COLUMN "deadlineTitle" SET NOT NULL,
    ALTER COLUMN "deadlineDueDate" SET NOT NULL,
    ALTER COLUMN "reservedAt" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "reservedAt" SET NOT NULL,
    ALTER COLUMN "reservationToken" SET NOT NULL;

ALTER TABLE "DeadlineReminderLog"
    ADD CONSTRAINT "DeadlineReminderLog_deadlineScheduleVersion_check" CHECK (
        "deadlineScheduleVersion" >= 1
    ),
    ADD CONSTRAINT "DeadlineReminderLog_reservationToken_check" CHECK (
        length("reservationToken") BETWEEN 1 AND 200
        AND "reservationToken" ~ '[^[:space:]]'
        AND "reservationToken" !~ '[[:cntrl:]]'
    ),
    ADD CONSTRAINT "DeadlineReminderLog_legacyDeliveryStatus_check" CHECK (
        "legacyDeliveryStatus" IS NULL
        OR "legacyDeliveryStatus" IN ('SENT', 'FAILED', 'SKIPPED')
    ),
    ADD CONSTRAINT "DeadlineReminderLog_legacyProvenance_check" CHECK (
        (
            "legacyDeliveryStatus" IS NULL
            AND "deadlineSnapshotKnown" = true
            AND "deliveryTimingKnown" = true
            AND "legacyRecordedAt" IS NULL
        )
        OR
        (
            "legacyDeliveryStatus" IS NOT NULL
            AND "deadlineSnapshotKnown" = false
            AND "deliveryTimingKnown" = false
            AND "legacyRecordedAt" IS NOT NULL
        )
    ),
    ADD CONSTRAINT "DeadlineReminderLog_delivery_evidence_check" CHECK (
        (
            "legacyDeliveryStatus" IS NOT NULL
            AND "status" = 'UNCERTAIN'::"DeadlineReminderStatus"
            AND "providerIdempotencyKey" IS NULL
            AND "providerMessageId" IS NULL
        )
        OR
        (
            "legacyDeliveryStatus" IS NULL
            AND "providerIdempotencyKey" IS NOT NULL
            AND length("providerIdempotencyKey") BETWEEN 1 AND 256
            AND "providerIdempotencyKey" ~ '[^[:space:]]'
            AND "providerIdempotencyKey" !~ '[[:cntrl:]]'
            AND (
                (
                    "status" IN (
                        'RESERVED'::"DeadlineReminderStatus",
                        'SKIPPED'::"DeadlineReminderStatus"
                    )
                    AND "providerRequestStartedAt" IS NULL
                    AND "providerMessageId" IS NULL
                )
                OR
                (
                    "status" IN (
                        'SENDING'::"DeadlineReminderStatus",
                        'FAILED'::"DeadlineReminderStatus",
                        'UNCERTAIN'::"DeadlineReminderStatus"
                    )
                    AND "providerRequestStartedAt" IS NOT NULL
                    AND "providerMessageId" IS NULL
                )
                OR
                (
                    "status" = 'SENT'::"DeadlineReminderStatus"
                    AND "providerRequestStartedAt" IS NOT NULL
                    AND "providerMessageId" IS NOT NULL
                    AND length("providerMessageId") BETWEEN 1 AND 200
                    AND "providerMessageId" ~ '[^[:space:]]'
                    AND "providerMessageId" !~ '[[:cntrl:]]'
                )
            )
        )
    ),
    ADD CONSTRAINT "DeadlineReminderLog_reconciliation_check" CHECK (
        (
            "reconciliationOutcome" IS NULL
            AND "reconciledAt" IS NULL
            AND "reconciledBy" IS NULL
            AND "reconciliationReference" IS NULL
        )
        OR
        (
            "status" = 'UNCERTAIN'::"DeadlineReminderStatus"
            AND "reconciliationOutcome" IS NOT NULL
            AND "reconciledAt" IS NOT NULL
            AND "reconciledBy" IS NOT NULL
            AND length("reconciledBy") BETWEEN 1 AND 100
            AND "reconciledBy" ~ '[^[:space:]]'
            AND "reconciledBy" !~ '[[:cntrl:]]'
            AND "reconciliationReference" IS NOT NULL
            AND length("reconciliationReference") BETWEEN 1 AND 200
            AND "reconciliationReference" ~ '[^[:space:]]'
            AND "reconciliationReference" !~ '[[:cntrl:]]'
        )
    ),
    ADD CONSTRAINT "DeadlineReminderLog_delivery_state_check" CHECK (
        (
            "legacyDeliveryStatus" IS NOT NULL
            AND "status" = 'UNCERTAIN'::"DeadlineReminderStatus"
            AND "attemptedAt" IS NULL
            AND "providerRequestStartedAt" IS NULL
            AND "sentAt" IS NULL
        )
        OR
        (
            "legacyDeliveryStatus" IS NULL
            AND "status" = 'SENT'::"DeadlineReminderStatus"
            AND "attemptedAt" IS NOT NULL
            AND "providerRequestStartedAt" IS NOT NULL
            AND "sentAt" IS NOT NULL
        )
        OR
        (
            "legacyDeliveryStatus" IS NULL
            AND
            "status" IN (
                'SENDING'::"DeadlineReminderStatus",
                'FAILED'::"DeadlineReminderStatus",
                'UNCERTAIN'::"DeadlineReminderStatus"
            )
            AND "attemptedAt" IS NOT NULL
            AND "providerRequestStartedAt" IS NOT NULL
            AND "sentAt" IS NULL
        )
        OR
        (
            "legacyDeliveryStatus" IS NULL
            AND
            "status" IN ('RESERVED'::"DeadlineReminderStatus", 'SKIPPED'::"DeadlineReminderStatus")
            AND "attemptedAt" IS NULL
            AND "providerRequestStartedAt" IS NULL
            AND "sentAt" IS NULL
        )
    );

CREATE FUNCTION "preventDeadlineReminderReconciliationMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."reconciliationOutcome" IS NOT NULL
       AND ROW(
           NEW."reconciliationOutcome",
           NEW."reconciledAt",
           NEW."reconciledBy",
           NEW."reconciliationReference"
       ) IS DISTINCT FROM ROW(
           OLD."reconciliationOutcome",
           OLD."reconciledAt",
           OLD."reconciledBy",
           OLD."reconciliationReference"
       )
    THEN
        RAISE EXCEPTION
            'Deadline reminder reconciliation evidence is immutable once recorded'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DeadlineReminderLog_reconciliation_immutable"
BEFORE UPDATE OF
    "reconciliationOutcome",
    "reconciledAt",
    "reconciledBy",
    "reconciliationReference"
ON "DeadlineReminderLog"
FOR EACH ROW
EXECUTE FUNCTION "preventDeadlineReminderReconciliationMutation"();

DROP INDEX "DeadlineReminderLog_deadlineId_email_reminderDays_key";

CREATE UNIQUE INDEX "DeadlineReminderLog_reservationToken_key"
    ON "DeadlineReminderLog"("reservationToken");
CREATE UNIQUE INDEX "DeadlineReminderLog_providerIdempotencyKey_key"
    ON "DeadlineReminderLog"("providerIdempotencyKey");
CREATE UNIQUE INDEX "DeadlineReminderLog_providerMessageId_key"
    ON "DeadlineReminderLog"("providerMessageId");
CREATE UNIQUE INDEX "DeadlineReminderLog_active_delivery_key"
    ON "DeadlineReminderLog"(
        "deadlineId",
        "email",
        "reminderDays",
        "deadlineScheduleVersion"
    )
    WHERE "status" IN (
        'RESERVED'::"DeadlineReminderStatus",
        'SENDING'::"DeadlineReminderStatus",
        'SENT'::"DeadlineReminderStatus"
    ) OR (
        "status" = 'UNCERTAIN'::"DeadlineReminderStatus"
        AND (
            "reconciliationOutcome" IS NULL
            OR "reconciliationOutcome" <> 'NOT_ACCEPTED_CONFIRMED'::"DeadlineReminderReconciliationOutcome"
        )
    );
CREATE INDEX "DeadlineReminderLog_deadlineId_status_idx"
    ON "DeadlineReminderLog"("deadlineId", "status");
CREATE INDEX "DeadlineReminderLog_organisationId_reservedAt_id_idx"
    ON "DeadlineReminderLog"("organisationId", "reservedAt", "id");
CREATE INDEX "DeadlineReminderLog_status_providerRequestStartedAt_idx"
    ON "DeadlineReminderLog"("status", "providerRequestStartedAt");
