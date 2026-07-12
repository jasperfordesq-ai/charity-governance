#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  P109_RECOVERY_MIGRATIONS,
  buildP109RecoveryPreflightSql,
  parseP109MigrationChecksumOutput,
} from './production-recover-p109-migration.mjs';
import {
  P109_RESTORED_MIGRATION_HEAD,
  P109_RESTORED_MIGRATIONS,
  buildP109RestoredHistoryProbeSql,
} from './production-p109-restored-database-probe.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_MIGRATIONS_ROOT = join(REPOSITORY_ROOT, 'apps', 'api', 'prisma', 'migrations');
const DEFAULT_SCHEMA_PATH = join(REPOSITORY_ROOT, 'apps', 'api', 'prisma', 'schema.prisma');
const PRISMA_CLI_PATH = join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_PACKAGE_PATH = join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'package.json');
const REQUIRED_PRISMA_VERSION = '6.19.3';
const TARGET_MIGRATION = '20260711230000_add_domain_invariants_referential_safety';
const PREVIOUS_MIGRATION = '20260711213000_add_document_storage_deletion_retry_lifecycle';
const USAGE = 'Usage: node scripts/verify-domain-invariants-upgrade.mjs [--keep-databases] [--dry-run] [--migration-image=<local-image-ref>]';

const ORGANISATIONS_AND_OWNERS_SQL = String.raw`
BEGIN;
INSERT INTO "Organisation" ("id", "name", "updatedAt") VALUES
  ('p109-org-a', 'P1-09 Organisation A', CURRENT_TIMESTAMP),
  ('p109-org-b', 'P1-09 Organisation B', CURRENT_TIMESTAMP);
INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "updatedAt"
) VALUES
  ('p109-owner-a', 'p109-owner-a@example.test', 'P1-09 Owner A', 'fixture', 'OWNER', 'p109-org-a', true, CURRENT_TIMESTAMP),
  ('p109-owner-b', 'p109-owner-b@example.test', 'P1-09 Owner B', 'fixture', 'OWNER', 'p109-org-b', true, CURRENT_TIMESTAMP);
COMMIT;
`;

const VALID_UPGRADE_SEED_SQL = String.raw`
${ORGANISATIONS_AND_OWNERS_SQL}
INSERT INTO "BoardMember" (
  "id", "organisationId", "name", "role", "appointedDate", "termEndDate",
  "conductSigned", "conductSignedDate", "inductionCompleted", "inductionDate", "updatedAt"
) VALUES
  (
    'p109-board-linked', 'p109-org-a', 'Linked trustee', 'Trustee',
    TIMESTAMP '2024-01-01 00:00:00', NULL,
    false, NULL, false, NULL, CURRENT_TIMESTAMP
  ),
  (
    'p109-board-complete', 'p109-org-a', 'Completed trustee', 'Trustee',
    TIMESTAMP '2024-02-01 09:30:00', TIMESTAMP '2024-02-01 09:30:00',
    true, TIMESTAMP '2024-02-02 10:00:00',
    true, TIMESTAMP '2024-02-03 11:00:00', CURRENT_TIMESTAMP
  );

INSERT INTO "ConflictRecord" (
  "id", "organisationId", "boardMemberId", "trusteeName", "matter", "nature",
  "dateDeclared", "actionTaken", "updatedAt"
) VALUES (
  'p109-conflict-linked', 'p109-org-a', 'p109-board-linked', 'Linked trustee',
  'Representative declared interest', 'Non-financial', TIMESTAMP '2025-01-01 00:00:00',
  'Trustee recused from the decision', CURRENT_TIMESTAMP
);

INSERT INTO "FundraisingRecord" (
  "id", "organisationId", "name", "activityType", "startDate", "endDate", "updatedAt"
) VALUES
  ('p109-fundraising-open', 'p109-org-a', 'Open appeal', 'Appeal', NULL, NULL, CURRENT_TIMESTAMP),
  (
    'p109-fundraising-end-only', 'p109-org-a', 'Legacy end-only note', 'Collection',
    NULL, TIMESTAMP '2025-02-01 12:00:00', CURRENT_TIMESTAMP
  ),
  (
    'p109-fundraising-same-time', 'p109-org-a', 'One-time collection', 'Collection',
    TIMESTAMP '2025-03-01 12:00:00', TIMESTAMP '2025-03-01 12:00:00', CURRENT_TIMESTAMP
  );

INSERT INTO "AnnualReportReadiness" (
  "id", "organisationId", "reportingYear", "filingStatus", "filedDate", "updatedAt"
) VALUES
  ('p109-report-draft', 'p109-org-a', 2024, 'IN_PROGRESS', NULL, CURRENT_TIMESTAMP),
  ('p109-report-filed', 'p109-org-a', 2025, 'FILED', TIMESTAMP '2026-06-01 10:00:00', CURRENT_TIMESTAMP),
  ('p109-report-date-before-filed-state', 'p109-org-a', 2026, 'BOARD_APPROVED', TIMESTAMP '2027-05-01 09:00:00', CURRENT_TIMESTAMP);
`;

const INVALID_UPGRADE_SEED_SQL = String.raw`
${ORGANISATIONS_AND_OWNERS_SQL}
INSERT INTO "BoardMember" (
  "id", "organisationId", "name", "role", "appointedDate", "termEndDate",
  "conductSigned", "conductSignedDate", "inductionCompleted", "inductionDate", "updatedAt"
) VALUES
  (
    'p109-invalid-chronology', 'p109-org-a', 'Invalid chronology', 'Trustee',
    TIMESTAMP '2025-01-02 00:00:00', TIMESTAMP '2025-01-01 00:00:00',
    false, NULL, false, NULL, CURRENT_TIMESTAMP
  ),
  (
    'p109-invalid-conduct', 'p109-org-a', 'Invalid conduct', 'Trustee',
    TIMESTAMP '2025-01-01 00:00:00', NULL,
    true, NULL, false, NULL, CURRENT_TIMESTAMP
  ),
  (
    'p109-invalid-induction', 'p109-org-a', 'Invalid induction', 'Trustee',
    TIMESTAMP '2025-01-01 00:00:00', NULL,
    false, NULL, false, TIMESTAMP '2025-01-03 00:00:00', CURRENT_TIMESTAMP
  ),
  (
    'p109-cross-tenant-member', 'p109-org-a', 'Cross-tenant target', 'Trustee',
    TIMESTAMP '2025-01-01 00:00:00', NULL,
    false, NULL, false, NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "ConflictRecord" (
  "id", "organisationId", "boardMemberId", "trusteeName", "matter", "nature",
  "dateDeclared", "actionTaken", "updatedAt"
) VALUES (
  'p109-invalid-conflict-scope', 'p109-org-b', 'p109-cross-tenant-member', 'Cross-tenant target',
  'Legacy cross-tenant pointer', 'Invalid scope', TIMESTAMP '2025-02-01 00:00:00',
  'Requires deliberate remediation', CURRENT_TIMESTAMP
);

INSERT INTO "FundraisingRecord" (
  "id", "organisationId", "name", "activityType", "startDate", "endDate", "updatedAt"
) VALUES (
  'p109-invalid-fundraising', 'p109-org-a', 'Backwards campaign', 'Campaign',
  TIMESTAMP '2025-03-02 00:00:00', TIMESTAMP '2025-03-01 00:00:00', CURRENT_TIMESTAMP
);

INSERT INTO "AnnualReportReadiness" (
  "id", "organisationId", "reportingYear", "filingStatus", "filedDate", "updatedAt"
) VALUES ('p109-invalid-filing', 'p109-org-a', 2025, 'FILED', NULL, CURRENT_TIMESTAMP);
`;

const FAILED_MIGRATION_ATOMICITY_SQL = String.raw`
DO $fixture$
DECLARE
  old_delete_action "char";
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname IN (
      'BoardMember_term_chronology_check',
      'BoardMember_conduct_signed_date_equivalence_check',
      'BoardMember_induction_date_equivalence_check',
      'FundraisingRecord_date_chronology_check',
      'AnnualReportReadiness_filed_date_required_check',
      'BoardMember_id_organisationId_key',
      'ConflictRecord_boardMemberId_organisationId_fkey'
    )
  ) THEN
    RAISE EXCEPTION 'Failed P1-09 migration left a target constraint behind';
  END IF;

  IF TO_REGCLASS('public."ConflictRecord_boardMemberId_organisationId_idx"') IS NOT NULL THEN
    RAISE EXCEPTION 'Failed P1-09 migration left the composite index behind';
  END IF;
  IF TO_REGCLASS('public."ConflictRecord_boardMemberId_idx"') IS NULL THEN
    RAISE EXCEPTION 'Failed P1-09 migration did not restore the legacy index';
  END IF;

  SELECT confdeltype INTO old_delete_action
  FROM pg_catalog.pg_constraint
  WHERE conname = 'ConflictRecord_boardMemberId_fkey';
  IF old_delete_action IS DISTINCT FROM 'n'::"char" THEN
    RAISE EXCEPTION 'Failed P1-09 migration did not preserve the legacy SET NULL foreign key';
  END IF;

  IF (SELECT COUNT(*) FROM "BoardMember") <> 4
     OR (SELECT COUNT(*) FROM "ConflictRecord") <> 1
     OR (SELECT COUNT(*) FROM "FundraisingRecord") <> 1
     OR (SELECT COUNT(*) FROM "AnnualReportReadiness") <> 1 THEN
    RAISE EXCEPTION 'Failed P1-09 migration rewrote or lost legacy rows';
  END IF;
END;
$fixture$;
`;

const FAILED_PRISMA_HISTORY_ASSERTIONS_SQL = String.raw`
DO $fixture$
DECLARE
  target_count INTEGER;
  failed_count INTEGER;
  empty_log_failed_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
         )::INTEGER,
         COUNT(*) FILTER (
           WHERE finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
             AND COALESCE(LENGTH(logs), 0) = 0
         )::INTEGER
  INTO target_count, failed_count, empty_log_failed_count
  FROM "_prisma_migrations"
  WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety';

  IF target_count <> 1 OR failed_count <> 1 OR empty_log_failed_count <> 1 THEN
    RAISE EXCEPTION 'Prisma did not record exactly one unresolved failed P1-09 migration with its real NULL or empty log shape';
  END IF;
END;
$fixture$;
`;

const INVALID_FIXTURE_COUNT_ASSERTIONS_SQL = String.raw`
DO $fixture$
DECLARE
  invalid_board_chronology BIGINT;
  invalid_conduct_evidence BIGINT;
  invalid_induction_evidence BIGINT;
  invalid_fundraising_chronology BIGINT;
  invalid_filing_evidence BIGINT;
  invalid_conflict_scope BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_board_chronology
  FROM "BoardMember"
  WHERE "termEndDate" IS NOT NULL AND "termEndDate" < "appointedDate";
  SELECT COUNT(*) INTO invalid_conduct_evidence
  FROM "BoardMember"
  WHERE "conductSigned" <> ("conductSignedDate" IS NOT NULL);
  SELECT COUNT(*) INTO invalid_induction_evidence
  FROM "BoardMember"
  WHERE "inductionCompleted" <> ("inductionDate" IS NOT NULL);
  SELECT COUNT(*) INTO invalid_fundraising_chronology
  FROM "FundraisingRecord"
  WHERE "startDate" IS NOT NULL AND "endDate" IS NOT NULL AND "endDate" < "startDate";
  SELECT COUNT(*) INTO invalid_filing_evidence
  FROM "AnnualReportReadiness"
  WHERE "filingStatus" = 'FILED'::"AnnualReportFilingStatus" AND "filedDate" IS NULL;
  SELECT COUNT(*) INTO invalid_conflict_scope
  FROM "ConflictRecord" AS conflict
  JOIN "BoardMember" AS member ON member."id" = conflict."boardMemberId"
  WHERE member."organisationId" IS DISTINCT FROM conflict."organisationId";

  IF invalid_board_chronology <> 1
     OR invalid_conduct_evidence <> 1
     OR invalid_induction_evidence <> 1
     OR invalid_fundraising_chronology <> 1
     OR invalid_filing_evidence <> 1
     OR invalid_conflict_scope <> 1 THEN
    RAISE EXCEPTION 'Disposable P1-09 invalid fixture does not contain exactly one row in every preflight category';
  END IF;
END;
$fixture$;
`;

const REMEDIATED_BLOCKER_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BoardMember"
    WHERE ("termEndDate" IS NOT NULL AND "termEndDate" < "appointedDate")
       OR "conductSigned" <> ("conductSignedDate" IS NOT NULL)
       OR "inductionCompleted" <> ("inductionDate" IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM "FundraisingRecord"
    WHERE "startDate" IS NOT NULL AND "endDate" IS NOT NULL AND "endDate" < "startDate"
  ) OR EXISTS (
    SELECT 1 FROM "AnnualReportReadiness"
    WHERE "filingStatus" = 'FILED'::"AnnualReportFilingStatus" AND "filedDate" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "ConflictRecord" AS conflict
    JOIN "BoardMember" AS member ON member."id" = conflict."boardMemberId"
    WHERE member."organisationId" IS DISTINCT FROM conflict."organisationId"
  ) THEN
    RAISE EXCEPTION 'Disposable P1-09 remediation left a preflight blocker unresolved';
  END IF;
END;
$fixture$;
`;

const ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
      AND finished_at IS NULL
      AND rolled_back_at IS NOT NULL
      AND applied_steps_count = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'Prisma migrate resolve did not mark the exact failed P1-09 attempt rolled back';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Prisma history still contains an unresolved P1-09 failure after resolve';
  END IF;
END;
$fixture$;
`;

const REMEDIATE_DISPOSABLE_INVALID_FIXTURE_SQL = String.raw`
BEGIN;
UPDATE "BoardMember"
SET "termEndDate" = "appointedDate", "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-chronology';

UPDATE "BoardMember"
SET "conductSigned" = false, "conductSignedDate" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-conduct';

UPDATE "BoardMember"
SET "inductionCompleted" = false, "inductionDate" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-induction';

UPDATE "FundraisingRecord"
SET "endDate" = "startDate", "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-fundraising';

UPDATE "AnnualReportReadiness"
SET "filedDate" = TIMESTAMP '2026-06-01 10:00:00', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-filing';

UPDATE "ConflictRecord"
SET "boardMemberId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'p109-invalid-conflict-scope';
COMMIT;
`;

const RECOVERED_PRISMA_HISTORY_AND_DATA_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
  ) <> 2 OR (
    SELECT COUNT(*)
    FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
      AND finished_at IS NULL
      AND rolled_back_at IS NOT NULL
      AND applied_steps_count = 0
  ) <> 1 OR (
    SELECT COUNT(*)
    FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) <> 1 THEN
    RAISE EXCEPTION 'Prisma P1-09 history does not contain one rolled-back attempt and one applied attempt';
  END IF;

  IF (SELECT COUNT(*) FROM "BoardMember") <> 4
     OR (SELECT COUNT(*) FROM "ConflictRecord") <> 1
     OR (SELECT COUNT(*) FROM "FundraisingRecord") <> 1
     OR (SELECT COUNT(*) FROM "AnnualReportReadiness") <> 1 THEN
    RAISE EXCEPTION 'Disposable P1-09 remediation deleted or invented governance rows';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "BoardMember"
    WHERE "id" = 'p109-invalid-chronology' AND "termEndDate" = "appointedDate"
  ) OR NOT EXISTS (
    SELECT 1 FROM "BoardMember"
    WHERE "id" = 'p109-invalid-conduct'
      AND NOT "conductSigned" AND "conductSignedDate" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "BoardMember"
    WHERE "id" = 'p109-invalid-induction'
      AND NOT "inductionCompleted" AND "inductionDate" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "FundraisingRecord"
    WHERE "id" = 'p109-invalid-fundraising' AND "endDate" = "startDate"
  ) OR NOT EXISTS (
    SELECT 1 FROM "AnnualReportReadiness"
    WHERE "id" = 'p109-invalid-filing'
      AND "filingStatus" = 'FILED'::"AnnualReportFilingStatus"
      AND "filedDate" IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "ConflictRecord"
    WHERE "id" = 'p109-invalid-conflict-scope' AND "boardMemberId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Disposable P1-09 remediation did not correct only the six counted fixture contradictions';
  END IF;
END;
$fixture$;
`;

const INSTALLED_CONSTRAINT_ASSERTIONS_SQL = String.raw`
DO $fixture$
DECLARE
  required_checks TEXT[] := ARRAY[
    'BoardMember_term_chronology_check',
    'BoardMember_conduct_signed_date_equivalence_check',
    'BoardMember_induction_date_equivalence_check',
    'FundraisingRecord_date_chronology_check',
    'AnnualReportReadiness_filed_date_required_check'
  ];
  check_name TEXT;
  tenant_fk RECORD;
BEGIN
  IF (
    SELECT COUNT(*) FROM "_prisma_migrations"
    WHERE migration_name = '20260711230000_add_domain_invariants_referential_safety'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) <> 1 OR EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name > '20260711230000_add_domain_invariants_referential_safety'
  ) THEN
    RAISE EXCEPTION 'P1-09 proof workspace did not stop at its exact target migration';
  END IF;

  FOREACH check_name IN ARRAY required_checks LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname = check_name AND contype = 'c' AND convalidated
    ) THEN
      RAISE EXCEPTION 'Required validated CHECK constraint % is missing', check_name;
    END IF;
  END LOOP;

  IF (
    SELECT COUNT(*) FROM pg_catalog.pg_constraint
    WHERE conname = ANY(required_checks) AND contype = 'c' AND convalidated
  ) <> 5 THEN
    RAISE EXCEPTION 'P1-09 did not install exactly five named validated CHECK constraints';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'BoardMember_id_organisationId_key' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'BoardMember composite tenant key is missing';
  END IF;

  SELECT
    constraint_row.confdeltype,
    constraint_row.confupdtype,
    PG_GET_CONSTRAINTDEF(constraint_row.oid) AS definition
  INTO tenant_fk
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'ConflictRecord_boardMemberId_organisationId_fkey'
    AND constraint_row.contype = 'f';

  IF tenant_fk IS NULL
     OR tenant_fk.confdeltype <> 'r'
     OR tenant_fk.confupdtype <> 'r'
     OR tenant_fk.definition NOT ILIKE '%FOREIGN KEY ("boardMemberId", "organisationId")%'
     OR tenant_fk.definition NOT ILIKE '%REFERENCES "BoardMember"(id, "organisationId")%' THEN
    RAISE EXCEPTION 'ConflictRecord composite tenant FK is missing or malformed: %', tenant_fk.definition;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'ConflictRecord_boardMemberId_fkey'
  ) THEN
    RAISE EXCEPTION 'Legacy single-column ConflictRecord FK still exists';
  END IF;

  IF TO_REGCLASS('public."ConflictRecord_boardMemberId_organisationId_idx"') IS NULL
     OR TO_REGCLASS('public."ConflictRecord_boardMemberId_idx"') IS NOT NULL THEN
    RAISE EXCEPTION 'ConflictRecord composite tenant index replacement is incomplete';
  END IF;

END;
$fixture$;
`;

const VALID_DATA_UNCHANGED_ASSERTIONS_SQL = String.raw`
DO $fixture$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BoardMember"
    WHERE "id" = 'p109-board-complete'
      AND "termEndDate" = "appointedDate"
      AND "conductSigned" AND "conductSignedDate" IS NOT NULL
      AND "inductionCompleted" AND "inductionDate" IS NOT NULL
  ) OR (SELECT COUNT(*) FROM "BoardMember") <> 2
     OR (SELECT COUNT(*) FROM "ConflictRecord") <> 1
     OR (SELECT COUNT(*) FROM "FundraisingRecord") <> 3
     OR (SELECT COUNT(*) FROM "AnnualReportReadiness") <> 3 THEN
    RAISE EXCEPTION 'P1-09 successful migration rewrote representative legacy data';
  END IF;
END;
$fixture$;
`;

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
    ...options,
  });
}

function resultText(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function requireSuccess(result, description) {
  if (result.error) {
    throw new Error(`${description} could not execute: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}:\n${resultText(result)}`);
  }
}

function validateDatabasePrefix(prefix) {
  if (!/^[a-z][a-z0-9_]{2,38}$/.test(prefix)) {
    throw new Error('CHARITYPILOT_P109_UPGRADE_DB_PREFIX must be a short lowercase PostgreSQL identifier');
  }
  return prefix;
}

function validateCommandTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
    throw new Error(
      'CHARITYPILOT_P109_UPGRADE_COMMAND_TIMEOUT_MS must be an integer from 10000 to 600000',
    );
  }
  return timeoutMs;
}

function parseVerifierArgs(args) {
  let migrationImage = null;
  for (const arg of args) {
    if (arg === '--keep-databases' || arg === '--dry-run') continue;
    if (arg.startsWith('--migration-image=')) {
      if (migrationImage !== null) throw new Error(`Duplicate --migration-image option\n${USAGE}`);
      migrationImage = arg.slice('--migration-image='.length);
      if (!/^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(migrationImage)) {
        throw new Error(`--migration-image must be a safe lowercase Docker image reference\n${USAGE}`);
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n${USAGE}`);
  }
  return {
    keepDatabases: args.includes('--keep-databases'),
    dryRun: args.includes('--dry-run'),
    migrationImage,
  };
}

function validateCleanupTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error(
      'CHARITYPILOT_P109_UPGRADE_CLEANUP_TIMEOUT_MS must be an integer from 5000 to 60000',
    );
  }
  return timeoutMs;
}

function defaultDatabasePrefix() {
  return `charitypilot_p109_${process.pid}_${randomBytes(4).toString('hex')}`;
}

function validateLoopbackHost(value) {
  const host = value.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      'CHARITYPILOT_CI_POSTGRES_HOST must be loopback-only (127.0.0.1 or localhost) for the disposable P1-09 verifier',
    );
  }
  return host;
}

function validatePostgresPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('CHARITYPILOT_CI_POSTGRES_PORT must be an integer from 1 to 65535');
  }
  return String(port);
}

function createMigrationWorkspace(migrationNames, migrationsRoot, prefix) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
  const temporaryPrismaRoot = join(temporaryRoot, 'prisma');
  const temporaryMigrationsRoot = join(temporaryPrismaRoot, 'migrations');
  mkdirSync(temporaryMigrationsRoot, { recursive: true });

  cpSync(join(dirname(migrationsRoot), 'schema.prisma'), join(temporaryPrismaRoot, 'schema.prisma'));
  cpSync(join(migrationsRoot, 'migration_lock.toml'), join(temporaryMigrationsRoot, 'migration_lock.toml'));
  for (const migrationName of migrationNames) {
    cpSync(
      join(migrationsRoot, migrationName),
      join(temporaryMigrationsRoot, migrationName),
      { recursive: true },
    );
  }

  return {
    root: temporaryRoot,
    schemaPath: join(temporaryPrismaRoot, 'schema.prisma'),
  };
}

function createPreviousMigrationWorkspace(plan, migrationsRoot) {
  return createMigrationWorkspace(
    plan.previous,
    migrationsRoot,
    'charitypilot-p109-previous-prisma-',
  );
}

function createTargetMigrationWorkspace(plan, migrationsRoot) {
  return createMigrationWorkspace(
    [...plan.previous, plan.target],
    migrationsRoot,
    'charitypilot-p109-target-prisma-',
  );
}

function repositoryMigrationChecksums(migrationsRoot) {
  return Object.fromEntries(P109_RECOVERY_MIGRATIONS.map((migrationName) => {
    const bytes = readFileSync(join(migrationsRoot, migrationName, 'migration.sql'));
    return [migrationName, createHash('sha256').update(bytes).digest('hex')];
  }));
}

function disposableDatabaseUrl({ database, host, port, user, password }) {
  const url = new URL('postgresql://localhost/postgres');
  url.hostname = host;
  url.port = port;
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

export async function cleanupDomainInvariantDatabases({
  databases,
  dockerBin,
  container,
  user,
  adminDatabase,
  commandRunner = defaultCommandRunner,
  timeoutMs,
  pollAttempts = 20,
  pollDelayMs = 250,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!Array.isArray(databases) || databases.length === 0) {
    throw new Error('P1-09 cleanup requires at least one disposable database name');
  }
  if (databases.some((database) => !/^[a-z][a-z0-9_]{2,62}$/.test(database))) {
    throw new Error('P1-09 cleanup refused an unsafe disposable database name');
  }
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 100) {
    throw new Error('P1-09 cleanup pollAttempts must be an integer from 1 to 100');
  }

  const databaseSet = new Set(databases);
  const quotedNames = databases.map((database) => `'${database}'`).join(', ');
  const diagnostics = [];
  let lastResidue = [...databases];

  const run = (args) => commandRunner(dockerBin, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeoutMs,
  });
  const listResidue = () => {
    const result = run([
      'exec', container,
      'psql', '--no-psqlrc', '--username', user, '--dbname', adminDatabase,
      '--tuples-only', '--no-align', '--command',
      `SELECT datname FROM pg_database WHERE datname IN (${quotedNames}) ORDER BY datname;`,
    ]);
    if (result.error || result.status !== 0) {
      diagnostics.push(`residue query failed: ${resultText(result).slice(0, 500) || result.error?.message || 'unknown error'}`);
      return null;
    }
    const residue = String(result.stdout ?? '')
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => databaseSet.has(entry));
    lastResidue = residue;
    return residue;
  };

  for (let pass = 1; pass <= 2; pass += 1) {
    for (const database of databases) {
      const result = run([
        'exec', container,
        'dropdb', '--if-exists', '--force', '--username', user, database,
      ]);
      if (result.error || result.status !== 0) {
        diagnostics.push(
          `forced drop pass ${pass} for ${database} failed: ` +
          `${resultText(result).slice(0, 500) || result.error?.message || 'unknown error'}`,
        );
      }
    }

    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const residue = listResidue();
      if (residue?.length === 0) return;
      if (attempt < pollAttempts) await sleep(pollDelayMs);
    }
  }

  throw new Error(
    `P1-09 disposable database cleanup left residue: ${lastResidue.join(', ') || 'unknown'}; ` +
    diagnostics.slice(-6).join(' | '),
  );
}

export function discoverDomainInvariantUpgradeMigrations(migrationsRoot = DEFAULT_MIGRATIONS_ROOT) {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const targetIndex = migrations.indexOf(TARGET_MIGRATION);
  if (targetIndex === -1) throw new Error(`Missing target migration: ${TARGET_MIGRATION}`);
  if (migrations[targetIndex - 1] !== PREVIOUS_MIGRATION) {
    throw new Error(`P1-09 historical boundary must immediately follow ${PREVIOUS_MIGRATION}`);
  }
  return { previous: migrations.slice(0, targetIndex), target: TARGET_MIGRATION };
}

export async function verifyDomainInvariantUpgrade({
  args = process.argv.slice(2),
  env = process.env,
  migrationsRoot = DEFAULT_MIGRATIONS_ROOT,
  schemaPath = DEFAULT_SCHEMA_PATH,
  commandRunner = defaultCommandRunner,
  cleanupDatabases = cleanupDomainInvariantDatabases,
  stdout = process.stdout,
} = {}) {
  const { keepDatabases, dryRun, migrationImage } = parseVerifierArgs(args);
  const dockerBin = env.CHARITYPILOT_CI_POSTGRES_DOCKER_BIN ?? 'docker';
  const container = env.CHARITYPILOT_CI_POSTGRES_CONTAINER ?? 'charitypilot-ci-postgres';
  const user = env.CHARITYPILOT_CI_POSTGRES_USER ?? 'charitypilot';
  const password = env.CHARITYPILOT_CI_POSTGRES_PASSWORD ?? 'charitypilot_ci';
  const adminDatabase = env.CHARITYPILOT_CI_POSTGRES_ADMIN_DB ?? 'postgres';
  const host = validateLoopbackHost(env.CHARITYPILOT_CI_POSTGRES_HOST ?? '127.0.0.1');
  const port = validatePostgresPort(env.CHARITYPILOT_CI_POSTGRES_PORT ?? '5432');
  const commandTimeoutMs = validateCommandTimeout(
    env.CHARITYPILOT_P109_UPGRADE_COMMAND_TIMEOUT_MS ?? '120000',
  );
  const cleanupTimeoutMs = validateCleanupTimeout(
    env.CHARITYPILOT_P109_UPGRADE_CLEANUP_TIMEOUT_MS ?? '20000',
  );
  const prefix = validateDatabasePrefix(
    env.CHARITYPILOT_P109_UPGRADE_DB_PREFIX ?? defaultDatabasePrefix(),
  );
  const databases = {
    base: `${prefix}_base`,
    success: `${prefix}_success`,
    invalid: `${prefix}_invalid`,
  };
  const allDatabases = Object.values(databases);
  const plan = discoverDomainInvariantUpgradeMigrations(migrationsRoot);
  const checkoutMigrationChecksums = repositoryMigrationChecksums(migrationsRoot);
  let selectedMigrationChecksums = checkoutMigrationChecksums;
  let recoveryPreflightSql = buildP109RecoveryPreflightSql(selectedMigrationChecksums);
  const prismaVersion = JSON.parse(readFileSync(PRISMA_PACKAGE_PATH, 'utf8')).version;
  if (prismaVersion !== REQUIRED_PRISMA_VERSION) {
    throw new Error(
      `P1-09 recovery verification requires Prisma ${REQUIRED_PRISMA_VERSION}; found ${prismaVersion ?? 'unknown'}`,
    );
  }

  if (dryRun) {
    stdout.write(`Container: ${container}\n`);
    stdout.write(`Prisma CLI: ${prismaVersion}\n`);
    stdout.write(`Target migration executor: ${migrationImage ?? `host Prisma ${prismaVersion}`}\n`);
    stdout.write(`PostgreSQL endpoint: ${host}:${port} (loopback-only)\n`);
    stdout.write(`Cleanup command timeout: ${cleanupTimeoutMs}ms (two forced-drop passes)\n`);
    stdout.write(`Pre-P1-09 migrations: ${plan.previous.length}\n`);
    stdout.write(`Previous migration: ${plan.previous.at(-1)}\n`);
    stdout.write(`Target migration: ${plan.target}\n`);
    stdout.write(`Disposable databases: ${allDatabases.join(', ')}\n`);
    return;
  }

  // Keep the P1-09 verifier target-bound even after later migrations are added.
  // In built-image mode the selected image's exact migration checksums must
  // match this mounted target-only workspace before any artifact command runs.
  const previousMigrationWorkspace = createPreviousMigrationWorkspace(plan, migrationsRoot);
  const targetMigrationWorkspace = createTargetMigrationWorkspace(plan, migrationsRoot);

  const runDocker = (dockerArgs, description, options = {}) => {
    const result = commandRunner(dockerBin, dockerArgs, {
      timeoutMs: commandTimeoutMs,
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const psql = (database, sql, description, options = {}) => runDocker([
    'exec', '-i', container,
    'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--username', user, '--dbname', database,
  ], description, { ...options, input: sql });
  const recoveryStateFingerprint = (database, description) => {
    const result = runDocker([
      'exec', '-i', container,
      'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align',
      '--username', user, '--dbname', database,
    ], description, { input: String.raw`
      SELECT md5(jsonb_build_object(
        'migrationHistory', COALESCE((
          SELECT jsonb_agg(to_jsonb(history_row) ORDER BY history_row.id)
          FROM "_prisma_migrations" AS history_row
        ), '[]'::jsonb),
        'boardMembers', COALESCE((
          SELECT jsonb_agg(to_jsonb(board_row) ORDER BY board_row."id")
          FROM "BoardMember" AS board_row
        ), '[]'::jsonb),
        'conflictRecords', COALESCE((
          SELECT jsonb_agg(to_jsonb(conflict_row) ORDER BY conflict_row."id")
          FROM "ConflictRecord" AS conflict_row
        ), '[]'::jsonb),
        'fundraisingRecords', COALESCE((
          SELECT jsonb_agg(to_jsonb(fundraising_row) ORDER BY fundraising_row."id")
          FROM "FundraisingRecord" AS fundraising_row
        ), '[]'::jsonb),
        'annualReportReadiness', COALESCE((
          SELECT jsonb_agg(to_jsonb(annual_row) ORDER BY annual_row."id")
          FROM "AnnualReportReadiness" AS annual_row
        ), '[]'::jsonb),
        'constraints', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'table', table_row.relname,
              'name', constraint_row.conname,
              'definition', pg_get_constraintdef(constraint_row.oid)
            ) ORDER BY table_row.relname, constraint_row.conname
          )
          FROM pg_catalog.pg_constraint AS constraint_row
          JOIN pg_catalog.pg_class AS table_row ON table_row.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
          WHERE namespace_row.nspname = 'public'
            AND table_row.relname IN (
              'BoardMember', 'ConflictRecord', 'FundraisingRecord', 'AnnualReportReadiness'
            )
        ), '[]'::jsonb),
        'indexes', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'table', table_row.relname,
              'name', index_row.relname,
              'definition', pg_get_indexdef(index_definition.indexrelid)
            ) ORDER BY table_row.relname, index_row.relname
          )
          FROM pg_catalog.pg_index AS index_definition
          JOIN pg_catalog.pg_class AS table_row ON table_row.oid = index_definition.indrelid
          JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
          JOIN pg_catalog.pg_class AS index_row ON index_row.oid = index_definition.indexrelid
          WHERE namespace_row.nspname = 'public'
            AND table_row.relname IN (
              'BoardMember', 'ConflictRecord', 'FundraisingRecord', 'AnnualReportReadiness'
            )
        ), '[]'::jsonb)
      )::text);
    ` });
    const fingerprint = String(result.stdout ?? '').trim();
    if (!/^[a-f0-9]{32}$/.test(fingerprint)) {
      throw new Error(`${description} did not return one PostgreSQL state fingerprint`);
    }
    return fingerprint;
  };
  const createDatabase = (database, template) => runDocker([
    'exec', container, 'createdb', '--username', user,
    ...(template ? ['--template', template] : []),
    database,
  ], `create disposable database ${database}`);
  const runPrisma = (database, prismaArgs, description, options = {}) => {
    const result = commandRunner(process.execPath, [PRISMA_CLI_PATH, ...prismaArgs], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: disposableDatabaseUrl({ database, host, port, user, password }),
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const runMigrationImagePrisma = (database, prismaArgs, description, options = {}) => {
    if (!migrationImage) throw new Error('P1-09 migration-image command requested without --migration-image');
    const result = commandRunner(dockerBin, [
      'run', '--rm',
      ...(options.input === undefined ? [] : ['--interactive']),
      '--mount', `type=bind,source=${targetMigrationWorkspace.root},target=/p109-proof,readonly`,
      '--network', 'host', '--env', 'DATABASE_URL',
      migrationImage,
      ...prismaArgs,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: disposableDatabaseUrl({ database, host, port, user, password }),
      },
      ...options,
    });
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const runTargetPrisma = migrationImage ? runMigrationImagePrisma : runPrisma;
  const targetSchemaPath = migrationImage
    ? '/p109-proof/prisma/schema.prisma'
    : targetMigrationWorkspace.schemaPath;
  const captureMigrationImageChecksums = () => {
    if (!migrationImage) return selectedMigrationChecksums;
    const result = commandRunner(dockerBin, [
      'run', '--rm', '--network', 'none', '--entrypoint', 'node',
      migrationImage,
      '-e', P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: commandTimeoutMs,
      env: { ...process.env, ...env },
    });
    requireSuccess(result, 'capture exact migration checksums from the selected built image');
    return parseP109MigrationChecksumOutput(result.stdout);
  };
  const assertSqlFailure = (database, sql, expectedError, description) => {
    const result = psql(database, sql, description, { allowFailure: true });
    if (result.error) throw result.error;
    if (result.status === 0) throw new Error(`${description} unexpectedly succeeded`);
    const failure = resultText(result);
    if (!expectedError.test(failure)) {
      throw new Error(`${description} failed for an unexpected reason:\n${failure}`);
    }
  };
  const executeProductionRecoveryPreflight = (database) => migrationImage
    ? runTargetPrisma(
      database,
      ['db', 'execute', '--stdin', '--schema', targetSchemaPath],
      'execute exact production P1-09 recovery preflight through the built migration image',
      { input: recoveryPreflightSql },
    )
    : psql(
      database,
      recoveryPreflightSql,
      'execute the exact read-only production P1-09 recovery preflight before resolution',
    );

  let verificationFailure;
  try {
    await cleanupDatabases({
      databases: [...allDatabases].reverse(),
      dockerBin,
      container,
      user,
      adminDatabase,
      commandRunner,
      timeoutMs: cleanupTimeoutMs,
    });
    if (migrationImage) {
      selectedMigrationChecksums = captureMigrationImageChecksums();
      for (const migrationName of P109_RECOVERY_MIGRATIONS) {
        if (selectedMigrationChecksums[migrationName] !== checkoutMigrationChecksums[migrationName]) {
          throw new Error(
            `Selected migration image bytes differ from the target-only P1-09 proof workspace at ${migrationName}`,
          );
        }
      }
      recoveryPreflightSql = buildP109RecoveryPreflightSql(selectedMigrationChecksums);
      stdout.write(
        `Captured and bound ${P109_RECOVERY_MIGRATIONS.length} migration checksums from ${migrationImage}; ` +
        'the mounted proof workspace matches those exact bytes and stops at P1-09.\n',
      );
    }
    createDatabase(databases.base);
    runPrisma(
      databases.base,
      ['migrate', 'deploy', '--schema', previousMigrationWorkspace.schemaPath],
      'establish pre-P1-09 history with Prisma migrate deploy',
    );
    psql(databases.base, String.raw`
      DO $fixture$
      BEGIN
        IF (SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL) <> ${plan.previous.length}
           OR EXISTS (
             SELECT 1 FROM "_prisma_migrations"
             WHERE migration_name = '${plan.target}'
           )
           OR NOT EXISTS (
             SELECT 1 FROM "_prisma_migrations"
             WHERE migration_name = '${plan.previous.at(-1)}'
               AND finished_at IS NOT NULL
               AND rolled_back_at IS NULL
           ) THEN
          RAISE EXCEPTION 'Prisma did not establish exact history through the pre-P1-09 boundary';
        END IF;
      END;
      $fixture$;
    `, 'assert exact pre-P1-09 Prisma migration history');
    stdout.write(
      `Prisma ${prismaVersion} applied ${plan.previous.length} migrations through ${plan.previous.at(-1)}.\n`,
    );

    createDatabase(databases.invalid, databases.base);
    psql(databases.invalid, INVALID_UPGRADE_SEED_SQL, 'seed all invalid P1-09 legacy categories');
    psql(
      databases.invalid,
      INVALID_FIXTURE_COUNT_ASSERTIONS_SQL,
      'assert one disposable row in every P1-09 preflight category',
    );
    const failedMigration = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      `apply ${plan.target} with Prisma migrate deploy`,
      { allowFailure: true },
    );
    if (failedMigration.error) {
      throw new Error(
        `Prisma migrate deploy for ${plan.target} could not execute: ${failedMigration.error.message}`,
        { cause: failedMigration.error },
      );
    }
    if (failedMigration.status === 0) throw new Error('P1-09 invalid-data migration unexpectedly succeeded');
    const failure = resultText(failedMigration);
    if (!failure.includes(plan.target)) {
      throw new Error(`Prisma failure was not bound to the P1-09 target migration:\n${failure}`);
    }
    psql(databases.invalid, FAILED_MIGRATION_ATOMICITY_SQL, 'verify invalid-data atomic rollback');
    psql(
      databases.invalid,
      FAILED_PRISMA_HISTORY_ASSERTIONS_SQL,
      'verify Prisma recorded one unresolved failed P1-09 attempt',
    );

    const blockedRerun = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'prove an unresolved failed migration blocks plain Prisma redeploy',
      { allowFailure: true },
    );
    if (blockedRerun.error) throw blockedRerun.error;
    if (blockedRerun.status === 0) {
      throw new Error('Plain Prisma migrate deploy unexpectedly bypassed unresolved P1-09 failure');
    }
    const blockedRerunFailure = resultText(blockedRerun);
    if (!/P3009/.test(blockedRerunFailure) || !blockedRerunFailure.includes(plan.target)) {
      throw new Error(
        `Plain Prisma rerun did not fail with target-bound P3009:\n${blockedRerunFailure}`,
      );
    }

    psql(
      databases.invalid,
      REMEDIATE_DISPOSABLE_INVALID_FIXTURE_SQL,
      'deliberately remediate only the disposable P1-09 fixture while the failed history remains unresolved',
    );
    psql(
      databases.invalid,
      REMEDIATED_BLOCKER_ASSERTIONS_SQL,
      'prove all six disposable preflight blocker counts are zero before migration resolution',
    );
    psql(
      databases.invalid,
      FAILED_MIGRATION_ATOMICITY_SQL,
      'prove the remediated database still has legacy catalog and no target residue',
    );
    psql(
      databases.invalid,
      FAILED_PRISMA_HISTORY_ASSERTIONS_SQL,
      'prove failed Prisma history remains unresolved until the exact resolve command',
    );
    let tamperedChecksumPreflightStatus = null;
    if (migrationImage) {
      const expectedTargetChecksum = selectedMigrationChecksums[plan.target];
      const tamperedChecksum = '0'.repeat(64);
      if (expectedTargetChecksum === tamperedChecksum) {
        throw new Error('Selected migration image unexpectedly has the reserved checksum-tamper value');
      }
      psql(databases.invalid, String.raw`
        DO $fixture$
        DECLARE
          affected_rows INTEGER;
        BEGIN
          IF (
            SELECT COUNT(*) FROM "_prisma_migrations"
            WHERE migration_name = '${plan.target}'
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
              AND checksum = '${expectedTargetChecksum}'
          ) <> 1 THEN
            RAISE EXCEPTION 'Failed target history is not bound to the selected image checksum before tamper proof';
          END IF;
          UPDATE "_prisma_migrations"
          SET checksum = '${tamperedChecksum}'
          WHERE migration_name = '${plan.target}'
            AND finished_at IS NULL
            AND rolled_back_at IS NULL;
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          IF affected_rows <> 1 THEN
            RAISE EXCEPTION 'Checksum negative proof did not tamper exactly one failed target row';
          END IF;
        END;
        $fixture$;
      `, 'tamper only the disposable failed-target checksum for negative image proof');

      const rejectedChecksumPreflight = runTargetPrisma(
        databases.invalid,
        ['db', 'execute', '--stdin', '--schema', targetSchemaPath],
        'require checksum-bound production preflight to reject tampered history',
        { allowFailure: true, input: recoveryPreflightSql },
      );
      if (rejectedChecksumPreflight.error) {
        throw new Error(
          `Built-image checksum rejection proof could not execute: ${rejectedChecksumPreflight.error.message}`,
          { cause: rejectedChecksumPreflight.error },
        );
      }
      const checksumRejection = resultText(rejectedChecksumPreflight);
      if (
        rejectedChecksumPreflight.status === 0 ||
        !/exact selected-image checksums/i.test(checksumRejection)
      ) {
        throw new Error(
          `Built-image recovery preflight did not reject the tampered target checksum:\n${checksumRejection}`,
        );
      }
      tamperedChecksumPreflightStatus = rejectedChecksumPreflight.status;

      psql(databases.invalid, String.raw`
        DO $fixture$
        DECLARE
          affected_rows INTEGER;
        BEGIN
          UPDATE "_prisma_migrations"
          SET checksum = '${expectedTargetChecksum}'
          WHERE migration_name = '${plan.target}'
            AND finished_at IS NULL
            AND rolled_back_at IS NULL
            AND checksum = '${tamperedChecksum}';
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          IF affected_rows <> 1 THEN
            RAISE EXCEPTION 'Checksum negative proof did not restore exactly one failed target row';
          END IF;
        END;
        $fixture$;
      `, 'restore the exact selected-image checksum after negative proof');
      stdout.write(
        'Built migration image rejected a tampered failed-target checksum and restored the exact selected-image binding.\n',
      );
    }
    const stateBeforeProductionPreflight = recoveryStateFingerprint(
      databases.invalid,
      'capture state before exact production recovery preflight',
    );
    const productionPreflightResult = executeProductionRecoveryPreflight(databases.invalid);
    const stateAfterProductionPreflight = recoveryStateFingerprint(
      databases.invalid,
      'capture state after exact production recovery preflight',
    );
    if (stateAfterProductionPreflight !== stateBeforeProductionPreflight) {
      throw new Error('Exact production P1-09 recovery preflight changed database rows or catalog state');
    }
    stdout.write(
      'Exact production P1-09 recovery wrapper preflight passed live, preserved the complete logical state fingerprint, and accepted real NULL/empty Prisma logs while failed history remained unresolved.\n',
    );

    const resolveResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath],
      'resolve the exact remediated P1-09 migration as rolled back',
    );
    psql(
      databases.invalid,
      ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL,
      'verify exact P1-09 rolled-back history resolution',
    );
    const redeployResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'redeploy P1-09 after exact resolve and disposable remediation',
    );
    psql(
      databases.invalid,
      INSTALLED_CONSTRAINT_ASSERTIONS_SQL,
      'assert recovered P1-09 catalog after Prisma redeploy',
    );
    psql(
      databases.invalid,
      RECOVERED_PRISMA_HISTORY_AND_DATA_ASSERTIONS_SQL,
      'assert recovered Prisma history and deliberately remediated fixture',
    );
    if (migrationImage) {
      psql(databases.invalid, String.raw`
        DO $fixture$
        BEGIN
          IF (
            SELECT COUNT(*) FROM "_prisma_migrations"
            WHERE migration_name = '${plan.target}'
              AND checksum = '${selectedMigrationChecksums[plan.target]}'
          ) <> 2 THEN
            RAISE EXCEPTION 'Recovered target history is not fully bound to the selected migration image bytes';
          END IF;
        END;
        $fixture$;
      `, 'assert both rolled-back and applied target rows match selected image bytes');
    }
    const migrationStatusResult = runTargetPrisma(
      databases.invalid,
      ['migrate', 'status', '--schema', targetSchemaPath],
      'verify recovered P1-09 Prisma migration status',
    );
    if (migrationImage) {
      stdout.write(
        `Built-image command exits: failed deploy=${failedMigration.status}, P3009 rerun=${blockedRerun.status}, ` +
        `tampered db execute=${tamperedChecksumPreflightStatus}, pristine db execute=${productionPreflightResult.status}, ` +
        `resolve=${resolveResult.status}, redeploy=${redeployResult.status}, status=${migrationStatusResult.status}.\n`,
      );
    }
    stdout.write(
      'Verified real Prisma failed history, P3009 blocking, no-residue remediation before exact rolled-back resolution, and successful redeploy.\n',
    );

    createDatabase(databases.success, databases.base);
    psql(databases.success, VALID_UPGRADE_SEED_SQL, 'seed representative valid P1-09 upgrade fixture');
    runTargetPrisma(
      databases.success,
      ['migrate', 'deploy', '--schema', targetSchemaPath],
      'apply valid P1-09 upgrade with Prisma migrate deploy',
    );
    psql(databases.success, INSTALLED_CONSTRAINT_ASSERTIONS_SQL, 'assert exact P1-09 catalog');
    psql(
      databases.success,
      VALID_DATA_UNCHANGED_ASSERTIONS_SQL,
      'assert valid P1-09 legacy data was unchanged',
    );
    if (
      JSON.stringify(P109_RESTORED_MIGRATIONS) !==
      JSON.stringify(P109_RECOVERY_MIGRATIONS)
    ) {
      throw new Error(
        'P1-09 restore-only rollback migration history drifted from the recovery boundary',
      );
    }
    psql(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      'prove the exact P1-09 restore-only rollback boundary before any P1-07A migration',
    );
    stdout.write(
      'Exact P1-09 restored-history checksum and P1-07A-absence probe passed against live PostgreSQL.\n',
    );

    const restoredHistoryFailure = /requires exactly 20 selected-image-checksum-bound applied migrations through P1-09/u;
    const firstRestoredMigration = P109_RESTORED_MIGRATIONS[0];
    const firstRestoredChecksum = selectedMigrationChecksums[firstRestoredMigration];

    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET checksum = '${'0'.repeat(64)}'
      WHERE migration_name = '${firstRestoredMigration}';
    `, 'tamper one P1-09 restored-history checksum');
    assertSqlFailure(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      restoredHistoryFailure,
      'reject a tampered P1-09 restored-history checksum before migration',
    );
    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET checksum = '${firstRestoredChecksum}'
      WHERE migration_name = '${firstRestoredMigration}';
    `, 'restore the selected-image P1-09 checksum after the negative probe');

    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET finished_at = NULL, applied_steps_count = 0
      WHERE migration_name = '${P109_RESTORED_MIGRATION_HEAD}';
    `, 'make the P1-09 head unresolved for the negative probe');
    assertSqlFailure(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      restoredHistoryFailure,
      'reject unresolved P1-09 history before migration',
    );
    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1
      WHERE migration_name = '${P109_RESTORED_MIGRATION_HEAD}';
    `, 'restore the applied P1-09 head after the negative probe');

    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET migration_name = '${P109_RESTORED_MIGRATION_HEAD}_missing'
      WHERE migration_name = '${P109_RESTORED_MIGRATION_HEAD}';
    `, 'make the restored database stop before the exact P1-09 head');
    assertSqlFailure(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      restoredHistoryFailure,
      'reject pre-P1-09 restored history before migration',
    );
    psql(databases.success, String.raw`
      UPDATE "_prisma_migrations"
      SET migration_name = '${P109_RESTORED_MIGRATION_HEAD}'
      WHERE migration_name = '${P109_RESTORED_MIGRATION_HEAD}_missing';
    `, 'restore the exact P1-09 history head after the negative probe');

    psql(databases.success, String.raw`
      INSERT INTO "_prisma_migrations" (
        id, checksum, finished_at, migration_name, logs,
        rolled_back_at, started_at, applied_steps_count
      ) VALUES (
        '00000000-0000-4000-8000-000000000107',
        '${'1'.repeat(64)}',
        CURRENT_TIMESTAMP,
        '20260712013000_add_password_recovery_integrity',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        1
      );
    `, 'add forbidden P1-07A history for the negative probe');
    assertSqlFailure(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      restoredHistoryFailure,
      'reject P1-07A history before cross-boundary rollback migration',
    );
    psql(databases.success, String.raw`
      DELETE FROM "_prisma_migrations"
      WHERE id = '00000000-0000-4000-8000-000000000107';
    `, 'remove the forbidden P1-07A history after the negative probe');

    psql(
      databases.success,
      'CREATE TABLE "AuthRecoveryControl" ("id" integer PRIMARY KEY);',
      'add forbidden P1-07A catalog residue for the negative probe',
    );
    assertSqlFailure(
      databases.success,
      buildP109RestoredHistoryProbeSql(selectedMigrationChecksums),
      /refused P1-07A catalog residue/u,
      'reject P1-07A catalog residue before cross-boundary rollback migration',
    );
    psql(
      databases.success,
      'DROP TABLE "AuthRecoveryControl";',
      'remove forbidden P1-07A catalog residue after the negative probe',
    );
    stdout.write(
      'P1-09 restore-only probe rejected tampered, unresolved, pre-P1-09, P1-07A-history, and P1-07A-catalog fixtures before migration.\n',
    );

    const failureCases = [
      {
        description: 'board term before appointment',
        expected: /BoardMember_term_chronology_check/i,
        sql: String.raw`UPDATE "BoardMember" SET "termEndDate" = TIMESTAMP '2023-12-31' WHERE "id" = 'p109-board-linked';`,
      },
      {
        description: 'conduct true without signed date',
        expected: /BoardMember_conduct_signed_date_equivalence_check/i,
        sql: String.raw`UPDATE "BoardMember" SET "conductSigned" = true WHERE "id" = 'p109-board-linked';`,
      },
      {
        description: 'conduct false with signed date',
        expected: /BoardMember_conduct_signed_date_equivalence_check/i,
        sql: String.raw`UPDATE "BoardMember" SET "conductSigned" = false WHERE "id" = 'p109-board-complete';`,
      },
      {
        description: 'induction true without completed date',
        expected: /BoardMember_induction_date_equivalence_check/i,
        sql: String.raw`UPDATE "BoardMember" SET "inductionCompleted" = true WHERE "id" = 'p109-board-linked';`,
      },
      {
        description: 'induction false with completed date',
        expected: /BoardMember_induction_date_equivalence_check/i,
        sql: String.raw`UPDATE "BoardMember" SET "inductionCompleted" = false WHERE "id" = 'p109-board-complete';`,
      },
      {
        description: 'fundraising end before start',
        expected: /FundraisingRecord_date_chronology_check/i,
        sql: String.raw`
          INSERT INTO "FundraisingRecord" (
            "id", "organisationId", "name", "activityType", "startDate", "endDate", "updatedAt"
          ) VALUES (
            'p109-fundraising-backwards', 'p109-org-a', 'Backwards appeal', 'Appeal',
            TIMESTAMP '2025-04-02', TIMESTAMP '2025-04-01', CURRENT_TIMESTAMP
          );
        `,
      },
      {
        description: 'FILED report without filed date',
        expected: /AnnualReportReadiness_filed_date_required_check/i,
        sql: String.raw`
          INSERT INTO "AnnualReportReadiness" (
            "id", "organisationId", "reportingYear", "filingStatus", "filedDate", "updatedAt"
          ) VALUES ('p109-report-invalid', 'p109-org-a', 2027, 'FILED', NULL, CURRENT_TIMESTAMP);
        `,
      },
      {
        description: 'cross-tenant ConflictRecord board pointer',
        expected: /ConflictRecord_boardMemberId_organisationId_fkey|foreign key/i,
        sql: String.raw`
          INSERT INTO "ConflictRecord" (
            "id", "organisationId", "boardMemberId", "trusteeName", "matter", "nature",
            "dateDeclared", "actionTaken", "updatedAt"
          ) VALUES (
            'p109-conflict-cross-tenant', 'p109-org-b', 'p109-board-linked', 'Linked trustee',
            'Cross-tenant attempt', 'Invalid', CURRENT_TIMESTAMP, 'Rejected', CURRENT_TIMESTAMP
          );
        `,
      },
      {
        description: 'linked board-member organisation move',
        expected: /ConflictRecord_boardMemberId_organisationId_fkey|foreign key/i,
        sql: String.raw`UPDATE "BoardMember" SET "organisationId" = 'p109-org-b' WHERE "id" = 'p109-board-linked';`,
      },
      {
        description: 'linked board-member deletion',
        expected: /ConflictRecord_boardMemberId_organisationId_fkey|foreign key/i,
        sql: String.raw`DELETE FROM "BoardMember" WHERE "id" = 'p109-board-linked';`,
      },
    ];
    for (const failureCase of failureCases) {
      assertSqlFailure(databases.success, failureCase.sql, failureCase.expected, failureCase.description);
    }

    psql(databases.success, String.raw`
      BEGIN;
      UPDATE "ConflictRecord"
      SET "boardMemberId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'p109-conflict-linked';
      DELETE FROM "BoardMember" WHERE "id" = 'p109-board-linked';
      COMMIT;
      DO $fixture$
      BEGIN
        IF EXISTS (SELECT 1 FROM "BoardMember" WHERE "id" = 'p109-board-linked')
           OR NOT EXISTS (
             SELECT 1 FROM "ConflictRecord"
             WHERE "id" = 'p109-conflict-linked' AND "boardMemberId" IS NULL
           ) THEN
          RAISE EXCEPTION 'Explicit detach did not preserve conflict history';
        END IF;
      END;
      $fixture$;
    `, 'verify explicit detach preserves conflict history before board deletion');

    stdout.write('P1-09 PostgreSQL 16 upgrade fixture passed exact catalog, edge-case, tenant-FK, and preserved-history assertions.\n');
  } catch (error) {
    verificationFailure = error;
  }

  const cleanupFailures = [];
  try {
    rmSync(previousMigrationWorkspace.root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    rmSync(targetMigrationWorkspace.root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (keepDatabases) {
    stdout.write(`Keeping disposable databases for inspection: ${allDatabases.join(', ')}\n`);
  } else {
    try {
      await cleanupDatabases({
        databases: [...allDatabases].reverse(),
        dockerBin,
        container,
        user,
        adminDatabase,
        commandRunner,
        timeoutMs: cleanupTimeoutMs,
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (verificationFailure) {
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${verificationFailure instanceof Error ? verificationFailure.message : verificationFailure}\n` +
        `Additionally, P1-09 disposable cleanup failed: ${cleanupFailures.map((error) => error instanceof Error ? error.message : error).join(' | ')}`,
        { cause: verificationFailure },
      );
    }
    throw verificationFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `P1-09 disposable cleanup failed after successful verification: ${cleanupFailures.map((error) => error instanceof Error ? error.message : error).join(' | ')}`,
      { cause: cleanupFailures[0] },
    );
  }
}

async function main() {
  try {
    await verifyDomainInvariantUpgrade();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
