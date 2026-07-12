#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  P109_RECOVERY_MIGRATIONS,
  runProductionFailedMigrationRecoveryFromArgs,
} from "./production-recover-p109-migration.mjs";

export const P107A_RECOVERY_MIGRATION =
  "20260712013000_add_password_recovery_integrity";
export const P107A_RECOVERY_ACKNOWLEDGEMENT =
  "I confirm the production runtime is quiesced, the failed P1-07A transaction rolled back without target catalog residue, every active-principal legacy reset-token half-pair, malformed hash, unsafe future expiry, and overlong account email has been deliberately remediated, each valid active pre-cutover slot may be backfilled exactly once into the P107A ledger before both User fields are atomically retired, inactive-principal reset fields are accepted only for deterministic clearing without recovery evidence, and only migration 20260712013000_add_password_recovery_integrity may be marked rolled back before immediate controlled redeployment.";

const RECOVERY_ATTESTATION_KIND =
  "charitypilot-p107a-failed-migration-recovery-attestation";
const PREVIOUS_MIGRATION =
  "20260711230000_add_domain_invariants_referential_safety";
export const P107A_RECOVERY_PREDECESSOR_MIGRATIONS = Object.freeze([
  ...P109_RECOVERY_MIGRATIONS,
]);
export const P107A_RECOVERY_MIGRATIONS = Object.freeze([
  ...P107A_RECOVERY_PREDECESSOR_MIGRATIONS,
  P107A_RECOVERY_MIGRATION,
]);
const P107A_PREDECESSOR_SQL_LIST = P107A_RECOVERY_PREDECESSOR_MIGRATIONS.map(
  (migration) => `'${migration}'`,
).join(",\n      ");
const P107A_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER =
  "__CHARITYPILOT_P107A_SELECTED_IMAGE_CHECKSUM_VALUES__";
export const P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX =
  "CHARITYPILOT_P107A_MIGRATION_CHECKSUMS_V1=";
export const P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT = [
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  `const expected = ${JSON.stringify(P107A_RECOVERY_MIGRATIONS)};`,
  'const migrations = Object.fromEntries(expected.map((name) => {',
  '  const bytes = fs.readFileSync(`prisma/migrations/${name}/migration.sql`);',
  '  return [name, crypto.createHash("sha256").update(bytes).digest("hex")];',
  '}));',
  `process.stdout.write(${JSON.stringify(P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX)} + JSON.stringify({ schemaVersion: 1, migrations }) + "\\n");`,
].join("\n");

// The invariant DO block must remain terminal. Prisma 6.19.3 can mask a raised
// exception if a later ROLLBACK statement follows it. Connection close rolls
// this short-lived read-only transaction back without hiding a failed DO block.
export const P107A_RECOVERY_PREFLIGHT_SQL = String.raw`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $p107a_recovery$
DECLARE
  target_rows BIGINT;
  target_failed_rows BIGINT;
  unresolved_rows BIGINT;
  previous_applied_rows BIGINT;
  applied_predecessor_rows BIGINT;
  applied_predecessor_distinct_rows BIGINT;
  total_history_rows BIGINT;
  unexpected_history_rows BIGINT;
  later_applied_rows BIGINT;
  checksum_mismatch_rows BIGINT;
  target_started_at TIMESTAMPTZ;
  target_table_rows BIGINT;
  target_type_rows BIGINT;
  target_function_rows BIGINT;
  target_trigger_rows BIGINT;
  target_existing_table_index_rows BIGINT;
  predecessor_constraint_rows BIGINT;
  half_pair_count BIGINT;
  malformed_hash_count BIGINT;
  unsafe_future_expiry_count BIGINT;
  overlong_active_email_count BIGINT;
  inactive_principal_cleanup_rows BIGINT;
BEGIN
  IF TO_REGCLASS('public."_prisma_migrations"') IS NULL THEN
    RAISE EXCEPTION 'P1-07A recovery preflight requires the Prisma migration history table';
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
         )
  INTO target_rows, target_failed_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '${P107A_RECOVERY_MIGRATION}';

  SELECT COUNT(*)
  INTO unresolved_rows
  FROM "_prisma_migrations"
  WHERE finished_at IS NULL
    AND rolled_back_at IS NULL;

  SELECT COUNT(*)
  INTO previous_applied_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '${PREVIOUS_MIGRATION}'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND applied_steps_count = 1;

  SELECT MAX(started_at)
  INTO target_started_at
  FROM "_prisma_migrations"
  WHERE migration_name = '${P107A_RECOVERY_MIGRATION}'
    AND finished_at IS NULL
    AND rolled_back_at IS NULL;

  SELECT COUNT(*), COUNT(DISTINCT migration_name)
  INTO applied_predecessor_rows, applied_predecessor_distinct_rows
  FROM "_prisma_migrations"
  WHERE migration_name IN (
      ${P107A_PREDECESSOR_SQL_LIST}
    )
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND applied_steps_count = 1;

  SELECT COUNT(*)
  INTO total_history_rows
  FROM "_prisma_migrations";

  SELECT COUNT(*)
  INTO unexpected_history_rows
  FROM "_prisma_migrations"
  WHERE migration_name NOT IN (
      ${P107A_PREDECESSOR_SQL_LIST},
      '${P107A_RECOVERY_MIGRATION}'
    );

  SELECT COUNT(*)
  INTO later_applied_rows
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND (
      migration_name > '${P107A_RECOVERY_MIGRATION}'
      OR started_at > target_started_at
    );

  SELECT COUNT(*)
  INTO checksum_mismatch_rows
  FROM (
    VALUES
      ${P107A_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER}
  ) AS selected_image(migration_name, checksum)
  LEFT JOIN "_prisma_migrations" AS migration_history
    ON migration_history.migration_name = selected_image.migration_name
  WHERE migration_history.checksum IS DISTINCT FROM selected_image.checksum;

  IF target_rows <> 1
     OR target_failed_rows <> 1
     OR unresolved_rows <> 1
     OR previous_applied_rows <> 1
     OR applied_predecessor_rows <> 20
     OR applied_predecessor_distinct_rows <> 20
     OR total_history_rows <> 21
     OR unexpected_history_rows <> 0
     OR later_applied_rows <> 0
     OR checksum_mismatch_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-07A recovery requires the exact selected-image checksums for the 20-migration applied predecessor chain followed only by one unresolved failed target attempt';
  END IF;

  SELECT COUNT(*)
  INTO target_table_rows
  FROM pg_catalog.pg_class AS table_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relkind IN ('r', 'p')
    AND table_row.relname IN (
      'PasswordRecoveryRequest',
      'AuthRecoveryRateLimitBucket',
      'AuthRecoveryControl',
      'AuthRecoveryRetiredSecret',
      'AuthSecurityEmailOutbox'
    );

  SELECT COUNT(*)
  INTO target_type_rows
  FROM pg_catalog.pg_type AS type_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = type_row.typnamespace
  WHERE namespace_row.nspname = 'public'
    AND type_row.typname IN (
      'PasswordRecoverySource',
      'PasswordRecoveryDeliveryState',
      'PasswordRecoverySuppressionReason',
      'PasswordRecoveryTerminationReason',
      'AuthRecoveryRateLimitScope',
      'AuthSecurityEmailKind',
      'AuthSecurityEmailDeliveryState'
    );

  SELECT COUNT(*)
  INTO target_function_rows
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND function_row.proname IN (
      'guard_password_recovery_request',
      'invalidate_password_recovery_on_password_change',
      'guard_retired_user_password_recovery_slot',
      'guard_auth_recovery_retired_secret',
      'reject_auth_recovery_retired_secret_truncate',
      'guard_auth_recovery_control',
      'guard_auth_security_email_outbox'
    );

  SELECT COUNT(*)
  INTO target_trigger_rows
  FROM pg_catalog.pg_trigger
  WHERE NOT tgisinternal
    AND tgname IN (
      'PasswordRecoveryRequest_guard_integrity',
      'User_invalidate_password_recovery_on_password_change',
      'User_guard_retired_password_recovery_slot',
      'AuthRecoveryRetiredSecret_guard_integrity',
      'AuthRecoveryRetiredSecret_reject_truncate',
      'AuthRecoveryControl_guard_integrity',
      'AuthSecurityEmailOutbox_guard_integrity'
    );

  SELECT COUNT(*)
  INTO target_existing_table_index_rows
  FROM pg_catalog.pg_class AS index_row
  WHERE index_row.oid = TO_REGCLASS('public."SecurityAuditEvent_id_organisationId_key"');

  IF target_table_rows <> 0
     OR target_type_rows <> 0
     OR target_function_rows <> 0
     OR target_trigger_rows <> 0
     OR target_existing_table_index_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-07A recovery refused a partial or mixed target catalog';
  END IF;

  SELECT COUNT(*)
  INTO predecessor_constraint_rows
  FROM pg_catalog.pg_constraint
  WHERE conname IN (
      'BoardMember_term_chronology_check',
      'BoardMember_conduct_signed_date_equivalence_check',
      'BoardMember_induction_date_equivalence_check',
      'FundraisingRecord_date_chronology_check',
      'AnnualReportReadiness_filed_date_required_check',
      'BoardMember_id_organisationId_key',
      'ConflictRecord_boardMemberId_organisationId_fkey'
    );

  IF predecessor_constraint_rows <> 7
     OR TO_REGCLASS('public."ConflictRecord_boardMemberId_organisationId_idx"') IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_enum AS enum_value
       JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
       WHERE enum_type.typname = 'SecurityAuditEventType'
         AND enum_value.enumlabel = 'PASSWORD_RESET_COMPLETED'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_enum AS enum_value
       JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
       WHERE enum_type.typname = 'SecurityAuditEventType'
         AND enum_value.enumlabel = 'ALL_SESSIONS_REVOKED'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-07A recovery requires the exact P1-09 predecessor catalog and unchanged audit enum';
  END IF;

  SELECT COUNT(*)
  INTO half_pair_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE (account."resetToken" IS NULL) <> (account."resetTokenExpiry" IS NULL)
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  SELECT COUNT(*)
  INTO malformed_hash_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE account."resetToken" IS NOT NULL
    AND account."resetToken" !~ '^[0-9a-f]{64}$'
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  SELECT COUNT(*)
  INTO unsafe_future_expiry_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE account."resetToken" IS NOT NULL
    AND account."resetTokenExpiry" > CURRENT_TIMESTAMP + INTERVAL '1 hour'
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  SELECT COUNT(*)
  INTO overlong_active_email_count
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE CHAR_LENGTH(account."email") > 254
    AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
    AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

  SELECT COUNT(*)
  INTO inactive_principal_cleanup_rows
  FROM "User" AS account
  JOIN "Organisation" AS organisation
    ON organisation."id" = account."organisationId"
  WHERE (account."resetToken" IS NOT NULL OR account."resetTokenExpiry" IS NOT NULL)
    AND (
      account."lifecycleStatus" <> 'ACTIVE'::"UserLifecycleStatus"
      OR organisation."lifecycleStatus" <> 'ACTIVE'::"OrganisationLifecycleStatus"
    );

  IF half_pair_count > 0
     OR malformed_hash_count > 0
     OR unsafe_future_expiry_count > 0
     OR overlong_active_email_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'P1-07A recovery active-principal data preflight failed: legacy_half_pairs=%s, malformed_token_hashes=%s, unsafe_future_expiries=%s, overlong_active_emails=%s; inactive_principal_cleanup_rows=%s are permitted only because the exact selected migration clears both legacy fields',
        half_pair_count,
        malformed_hash_count,
        unsafe_future_expiry_count,
        overlong_active_email_count,
        inactive_principal_cleanup_rows
      );
  END IF;
END;
$p107a_recovery$;`;

function validateP107AMigrationChecksums(migrations) {
  if (!migrations || Array.isArray(migrations) || typeof migrations !== "object") {
    throw new Error("selected migration image checksum manifest must contain a migrations object");
  }
  const actualNames = Object.keys(migrations).sort();
  const expectedNames = [...P107A_RECOVERY_MIGRATIONS].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "selected migration image checksum manifest must contain exactly the 21 reviewed P1-07A migration names",
    );
  }
  const validated = {};
  for (const name of P107A_RECOVERY_MIGRATIONS) {
    const checksum = migrations[name];
    if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(
        `selected migration image checksum for ${name} must be 64 lowercase hexadecimal characters`,
      );
    }
    validated[name] = checksum;
  }
  return validated;
}

export function parseP107AMigrationChecksumOutput(stdout) {
  const markerLines = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX));
  if (markerLines.length !== 1) {
    throw new Error(
      "selected migration image must emit exactly one P1-07A checksum manifest marker",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(
      markerLines[0].slice(P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX.length),
    );
  } catch {
    throw new Error(
      "selected migration image emitted invalid P1-07A checksum manifest JSON",
    );
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error(
      "selected migration image checksum manifest must be a JSON object",
    );
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("selected migration image checksum schemaVersion must be 1");
  }
  return validateP107AMigrationChecksums(manifest.migrations);
}

export function assertP107ARecoveryPreflightTerminalAssertion(sql) {
  if (
    !sql.startsWith(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    )
  ) {
    throw new Error(
      "P1-07A recovery SQL must begin a repeatable-read read-only transaction",
    );
  }
  if (/\b(?:COMMIT|ROLLBACK)\s*;/i.test(sql)) {
    throw new Error(
      "P1-07A recovery SQL must not contain COMMIT or ROLLBACK after its terminal assertion",
    );
  }
  if (!sql.endsWith("END;\n$p107a_recovery$;")) {
    throw new Error(
      "P1-07A recovery invariant DO block must be the terminal SQL statement",
    );
  }
  return sql;
}

export function buildP107ARecoveryPreflightSql(migrations) {
  const validated = validateP107AMigrationChecksums(migrations);
  const checksumValues = P107A_RECOVERY_MIGRATIONS.map(
    (name) => `('${name}', '${validated[name]}')`,
  ).join(",\n      ");
  const sql = P107A_RECOVERY_PREFLIGHT_SQL.replace(
    P107A_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER,
    checksumValues,
  );
  if (sql.includes(P107A_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER)) {
    throw new Error("P1-07A recovery SQL checksum binding was incomplete");
  }
  return assertP107ARecoveryPreflightTerminalAssertion(sql);
}

const P107A_RECOVERY_CONFIG = Object.freeze({
  taskLabel: "P1-07A",
  scriptName: "production-recover-p107a-migration.mjs",
  migrationName: P107A_RECOVERY_MIGRATION,
  acknowledgement: P107A_RECOVERY_ACKNOWLEDGEMENT,
  attestationKind: RECOVERY_ATTESTATION_KIND,
  imageChecksumScript: P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  migrationCount: P107A_RECOVERY_MIGRATIONS.length,
  parseMigrationChecksumOutput: parseP107AMigrationChecksumOutput,
  buildRecoveryPreflightSql: buildP107ARecoveryPreflightSql,
  preflightDescription:
    "failed-history, target-catalog-residue, four-category active-principal data preflight, and inactive-principal cleanup inventory",
  tempEnvPrefix: "charitypilot-p107a-recovery-env-",
});

export function runProductionP107ARecoveryFromArgs(
  args = process.argv.slice(2),
  dependencies = {},
) {
  return runProductionFailedMigrationRecoveryFromArgs(
    P107A_RECOVERY_CONFIG,
    args,
    dependencies,
  );
}

function main() {
  const recoveryResult = runProductionP107ARecoveryFromArgs();
  if (recoveryResult.stdout) process.stdout.write(recoveryResult.stdout);
  if (recoveryResult.stderr) process.stderr.write(recoveryResult.stderr);
  process.exit(recoveryResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
