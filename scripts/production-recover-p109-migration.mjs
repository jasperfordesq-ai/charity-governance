#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProductionComposeDeployFromArgs } from "./production-compose-deploy.mjs";
import {
  redactProductionDeployTranscript,
  runProductionDeployPreflightFromArgs,
} from "./production-deploy-preflight.mjs";
import {
  acquireProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;
const MAX_ATTESTATION_AGE_MS = 30 * 60 * 1000;
const MAX_PRODUCTION_ENV_BYTES = 1024 * 1024;
const MAX_ATTESTATION_BYTES = 128 * 1024;

export const P109_RECOVERY_MIGRATION =
  "20260711230000_add_domain_invariants_referential_safety";
export const P109_RECOVERY_ACKNOWLEDGEMENT =
  "I confirm the production runtime is quiesced, the failed P1-09 transaction rolled back without target catalog residue, the documented governance-data remediation or unexpected-writer resolution is complete, and only migration 20260711230000_add_domain_invariants_referential_safety may be marked rolled back before immediate controlled redeployment.";

const RECOVERY_ATTESTATION_KIND =
  "charitypilot-p109-failed-migration-recovery-attestation";
const PREVIOUS_MIGRATION =
  "20260711213000_add_document_storage_deletion_retry_lifecycle";
export const P109_RECOVERY_PREDECESSOR_MIGRATIONS = Object.freeze([
  "20260402114212_init",
  "20260403120000_add_auth_tokens",
  "20260507162000_add_compliance_signoffs",
  "20260507173000_add_governance_registers",
  "20260507190000_add_team_invites_and_reminder_logs",
  "20260507203000_add_auth_sessions",
  "20260606193000_add_stripe_webhook_events",
  "20260607120000_add_document_storage_deletions",
  "20260607173000_add_document_storage_deletion_claims",
  "20260608053000_add_active_team_invite_unique_index",
  "20260608072000_seed_governance_reference_data",
  "20260703214500_add_conditional_obligation_profile",
  "20260710064500_add_billing_checkout_attempts",
  "20260710123000_add_compliance_revision_snapshots",
  "20260710190000_add_deadline_calendar_lifecycle",
  "20260711030000_add_team_lifecycle_security",
  "20260711120000_add_billing_authority_grants",
  "20260711180000_add_security_audit_subject_label_snapshot",
  PREVIOUS_MIGRATION,
]);
export const P109_RECOVERY_MIGRATIONS = Object.freeze([
  ...P109_RECOVERY_PREDECESSOR_MIGRATIONS,
  P109_RECOVERY_MIGRATION,
]);
const P109_PREDECESSOR_SQL_LIST = P109_RECOVERY_PREDECESSOR_MIGRATIONS.map(
  (migration) => `'${migration}'`,
).join(",\n      ");
const P109_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER =
  "__CHARITYPILOT_P109_SELECTED_IMAGE_CHECKSUM_VALUES__";
export const P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX =
  "CHARITYPILOT_P109_MIGRATION_CHECKSUMS_V1=";
export const P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT = [
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  `const expected = ${JSON.stringify(P109_RECOVERY_MIGRATIONS)};`,
  'const migrations = Object.fromEntries(expected.map((name) => {',
  '  const bytes = fs.readFileSync(`prisma/migrations/${name}/migration.sql`);',
  '  return [name, crypto.createHash("sha256").update(bytes).digest("hex")];',
  '}));',
  `process.stdout.write(${JSON.stringify(P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX)} + JSON.stringify({ schemaVersion: 1, migrations }) + "\\n");`,
].join("\n");
const MIGRATION_IMAGE_PATTERN =
  /^ghcr\.io\/jasperfordesq-ai\/charity-governance-migrations@sha256:[a-f0-9]{64}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Keep the invariant DO block as the terminal SQL statement. Prisma 6.19.3 can
// report success when a later ROLLBACK follows a raised exception, so success
// relies on this short-lived CLI process closing the still-open read-only
// transaction; PostgreSQL then rolls it back without masking a DO failure.
export const P109_RECOVERY_PREFLIGHT_SQL = String.raw`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $p109_recovery$
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
  target_constraint_rows BIGINT;
  legacy_fk_rows BIGINT;
  legacy_index_rows BIGINT;
  invalid_board_chronology BIGINT;
  invalid_conduct_evidence BIGINT;
  invalid_induction_evidence BIGINT;
  invalid_fundraising_chronology BIGINT;
  invalid_filing_evidence BIGINT;
  invalid_conflict_scope BIGINT;
BEGIN
  IF TO_REGCLASS('public."_prisma_migrations"') IS NULL THEN
    RAISE EXCEPTION 'P1-09 recovery preflight requires the Prisma migration history table';
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
         )
  INTO target_rows, target_failed_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '${P109_RECOVERY_MIGRATION}';

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
    AND rolled_back_at IS NULL;

  SELECT MAX(started_at)
  INTO target_started_at
  FROM "_prisma_migrations"
  WHERE migration_name = '${P109_RECOVERY_MIGRATION}'
    AND finished_at IS NULL
    AND rolled_back_at IS NULL;

  SELECT COUNT(*), COUNT(DISTINCT migration_name)
  INTO applied_predecessor_rows, applied_predecessor_distinct_rows
  FROM "_prisma_migrations"
  WHERE migration_name IN (
      ${P109_PREDECESSOR_SQL_LIST}
    )
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL;

  SELECT COUNT(*)
  INTO total_history_rows
  FROM "_prisma_migrations";

  SELECT COUNT(*)
  INTO unexpected_history_rows
  FROM "_prisma_migrations"
  WHERE migration_name NOT IN (
      ${P109_PREDECESSOR_SQL_LIST},
      '${P109_RECOVERY_MIGRATION}'
    );

  SELECT COUNT(*)
  INTO later_applied_rows
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND (
      migration_name > '${P109_RECOVERY_MIGRATION}'
      OR started_at > target_started_at
    );

  SELECT COUNT(*)
  INTO checksum_mismatch_rows
  FROM (
    VALUES
      ${P109_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER}
  ) AS selected_image(migration_name, checksum)
  LEFT JOIN "_prisma_migrations" AS migration_history
    ON migration_history.migration_name = selected_image.migration_name
  WHERE migration_history.checksum IS DISTINCT FROM selected_image.checksum;

  IF target_rows <> 1
     OR target_failed_rows <> 1
     OR unresolved_rows <> 1
     OR previous_applied_rows <> 1
     OR applied_predecessor_rows <> 19
     OR applied_predecessor_distinct_rows <> 19
     OR total_history_rows <> 20
     OR unexpected_history_rows <> 0
     OR later_applied_rows <> 0
     OR checksum_mismatch_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 recovery requires the exact selected-image checksums for the 19-migration applied predecessor chain followed only by one unresolved failed target attempt';
  END IF;

  SELECT COUNT(*)
  INTO target_constraint_rows
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND constraint_row.conname IN (
      'BoardMember_term_chronology_check',
      'BoardMember_conduct_signed_date_equivalence_check',
      'BoardMember_induction_date_equivalence_check',
      'FundraisingRecord_date_chronology_check',
      'AnnualReportReadiness_filed_date_required_check',
      'BoardMember_id_organisationId_key',
      'ConflictRecord_boardMemberId_organisationId_fkey'
    );

  IF target_constraint_rows <> 0
     OR TO_REGCLASS('public."ConflictRecord_boardMemberId_organisationId_idx"') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 recovery refused a partial or mixed target catalog';
  END IF;

  SELECT COUNT(*)
  INTO legacy_fk_rows
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'ConflictRecord_boardMemberId_fkey'
    AND constraint_row.conrelid = 'public."ConflictRecord"'::REGCLASS
    AND constraint_row.confrelid = 'public."BoardMember"'::REGCLASS
    AND constraint_row.contype = 'f'
    AND constraint_row.confdeltype = 'n'
    AND constraint_row.confupdtype = 'c'
    AND constraint_row.conkey = ARRAY[
      (
        SELECT attribute_row.attnum::SMALLINT
        FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = 'public."ConflictRecord"'::REGCLASS
          AND attribute_row.attname = 'boardMemberId'
          AND NOT attribute_row.attisdropped
      )
    ]::SMALLINT[]
    AND constraint_row.confkey = ARRAY[
      (
        SELECT attribute_row.attnum::SMALLINT
        FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = 'public."BoardMember"'::REGCLASS
          AND attribute_row.attname = 'id'
          AND NOT attribute_row.attisdropped
      )
    ]::SMALLINT[];

  SELECT COUNT(*)
  INTO legacy_index_rows
  FROM pg_catalog.pg_class AS index_row
  JOIN pg_catalog.pg_index AS index_definition
    ON index_definition.indexrelid = index_row.oid
  WHERE index_row.oid = TO_REGCLASS('public."ConflictRecord_boardMemberId_idx"')
    AND index_definition.indrelid = 'public."ConflictRecord"'::REGCLASS
    AND index_definition.indisvalid
    AND index_definition.indisready
    AND NOT index_definition.indisunique
    AND index_definition.indnkeyatts = 1
    AND index_definition.indkey::TEXT = (
      SELECT attribute_row.attnum::TEXT
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid = 'public."ConflictRecord"'::REGCLASS
        AND attribute_row.attname = 'boardMemberId'
        AND NOT attribute_row.attisdropped
    );

  IF legacy_fk_rows <> 1
     OR legacy_index_rows <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 recovery requires the exact legacy ConflictRecord foreign key and index';
  END IF;

  SELECT COUNT(*) INTO invalid_board_chronology
  FROM "BoardMember"
  WHERE "termEndDate" IS NOT NULL
    AND "termEndDate" < "appointedDate";

  SELECT COUNT(*) INTO invalid_conduct_evidence
  FROM "BoardMember"
  WHERE "conductSigned" <> ("conductSignedDate" IS NOT NULL);

  SELECT COUNT(*) INTO invalid_induction_evidence
  FROM "BoardMember"
  WHERE "inductionCompleted" <> ("inductionDate" IS NOT NULL);

  SELECT COUNT(*) INTO invalid_fundraising_chronology
  FROM "FundraisingRecord"
  WHERE "startDate" IS NOT NULL
    AND "endDate" IS NOT NULL
    AND "endDate" < "startDate";

  SELECT COUNT(*) INTO invalid_filing_evidence
  FROM "AnnualReportReadiness"
  WHERE "filingStatus" = 'FILED'::"AnnualReportFilingStatus"
    AND "filedDate" IS NULL;

  SELECT COUNT(*) INTO invalid_conflict_scope
  FROM "ConflictRecord" AS conflict
  LEFT JOIN "BoardMember" AS member
    ON member."id" = conflict."boardMemberId"
  WHERE conflict."boardMemberId" IS NOT NULL
    AND (
      member."id" IS NULL
      OR member."organisationId" IS DISTINCT FROM conflict."organisationId"
    );

  IF invalid_board_chronology > 0
     OR invalid_conduct_evidence > 0
     OR invalid_induction_evidence > 0
     OR invalid_fundraising_chronology > 0
     OR invalid_filing_evidence > 0
     OR invalid_conflict_scope > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'P1-09 recovery data preflight failed: board_chronology=%s, conduct_evidence=%s, induction_evidence=%s, fundraising_chronology=%s, filing_evidence=%s, conflict_scope=%s',
        invalid_board_chronology,
        invalid_conduct_evidence,
        invalid_induction_evidence,
        invalid_fundraising_chronology,
        invalid_filing_evidence,
        invalid_conflict_scope
      );
  END IF;
END;
$p109_recovery$;`;

function validateP109MigrationChecksums(migrations) {
  if (!migrations || Array.isArray(migrations) || typeof migrations !== "object") {
    throw new Error("selected migration image checksum manifest must contain a migrations object");
  }
  const actualNames = Object.keys(migrations).sort();
  const expectedNames = [...P109_RECOVERY_MIGRATIONS].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "selected migration image checksum manifest must contain exactly the 20 reviewed P1-09 migration names",
    );
  }
  const validated = {};
  for (const name of P109_RECOVERY_MIGRATIONS) {
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

export function parseP109MigrationChecksumOutput(stdout) {
  const markerLines = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX));
  if (markerLines.length !== 1) {
    throw new Error(
      "selected migration image must emit exactly one P1-09 checksum manifest marker",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(
      markerLines[0].slice(P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX.length),
    );
  } catch {
    throw new Error(
      "selected migration image emitted invalid P1-09 checksum manifest JSON",
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
  return validateP109MigrationChecksums(manifest.migrations);
}

export function assertP109RecoveryPreflightTerminalAssertion(sql) {
  if (
    !sql.startsWith(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    )
  ) {
    throw new Error(
      "P1-09 recovery SQL must begin a repeatable-read read-only transaction",
    );
  }
  if (/\b(?:COMMIT|ROLLBACK)\s*;/i.test(sql)) {
    throw new Error(
      "P1-09 recovery SQL must not contain COMMIT or ROLLBACK after its terminal assertion",
    );
  }
  if (!sql.endsWith("END;\n$p109_recovery$;")) {
    throw new Error(
      "P1-09 recovery invariant DO block must be the terminal SQL statement",
    );
  }
  return sql;
}

export function buildP109RecoveryPreflightSql(migrations) {
  const validated = validateP109MigrationChecksums(migrations);
  const checksumValues = P109_RECOVERY_MIGRATIONS.map(
    (name) => `('${name}', '${validated[name]}')`,
  ).join(",\n      ");
  const sql = P109_RECOVERY_PREFLIGHT_SQL.replace(
    P109_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER,
    checksumValues,
  );
  if (sql.includes(P109_RECOVERY_CHECKSUM_VALUES_PLACEHOLDER)) {
    throw new Error("P1-09 recovery SQL checksum binding was incomplete");
  }
  return assertP109RecoveryPreflightTerminalAssertion(sql);
}

function usage() {
  return [
    "Usage: node scripts/production-recover-p109-migration.mjs --production-env-file <path> --backup-output-dir <approved-encrypted-base> --recovery-attestation-file <path> [--dry-run] [--wait-timeout <seconds>] [--no-tls-proxy]",
    "",
  ].join("\n");
}

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function parsePositiveInteger(value, flagName) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new Error(`${flagName} must be a positive integer number of seconds`);
  }
  return Number(value);
}

function validateBackupBase(path) {
  const resolvedBackupBase = resolve(repoRoot, path);
  const relativeToRepo = relative(repoRoot, resolvedBackupBase);
  const insideRepo =
    relativeToRepo === "" ||
    (relativeToRepo !== ".." &&
      !relativeToRepo.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToRepo));
  if (!isAbsolute(path) || insideRepo) {
    throw new Error(
      "--backup-output-dir must be an absolute path outside the repository on approved encrypted storage",
    );
  }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tlsProxy: true,
    productionEnvFile: ".env.production",
    backupOutputDir: null,
    recoveryAttestationFile: null,
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
  };
  const seenOptions = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      if (seenOptions.has(arg)) throw new Error(`${arg} must not be repeated`);
      seenOptions.add(arg);
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-tls-proxy") {
      if (seenOptions.has(arg)) throw new Error(`${arg} must not be repeated`);
      seenOptions.add(arg);
      options.tlsProxy = false;
      continue;
    }
    const valueFlags = [
      "--production-env-file",
      "--backup-output-dir",
      "--recovery-attestation-file",
      "--wait-timeout",
    ];
    const exactFlag = valueFlags.find((flag) => arg === flag);
    const assignedFlag = valueFlags.find((flag) => arg.startsWith(`${flag}=`));
    const flag = exactFlag ?? assignedFlag;
    if (!flag) throw new Error(`Unknown argument: ${arg}`);
    if (seenOptions.has(flag)) throw new Error(`${flag} must not be repeated`);
    seenOptions.add(flag);

    const value = exactFlag
      ? argv[index + 1]
      : arg.slice(`${assignedFlag}=`.length);
    if (!value) throw new Error(`${flag} requires a value`);
    if (exactFlag) index += 1;

    if (flag === "--production-env-file") options.productionEnvFile = value;
    if (flag === "--backup-output-dir") options.backupOutputDir = value;
    if (flag === "--recovery-attestation-file") {
      options.recoveryAttestationFile = value;
    }
    if (flag === "--wait-timeout") {
      options.waitTimeoutSeconds = parsePositiveInteger(value, flag);
    }
  }

  if (!options.backupOutputDir) {
    throw new Error(
      "--backup-output-dir is required and must point to approved encrypted backup storage",
    );
  }
  validateBackupBase(options.backupOutputDir);
  if (!options.recoveryAttestationFile) {
    throw new Error("--recovery-attestation-file is required");
  }
  return options;
}

function readBoundedRegularFile(path, label, maxBytes) {
  if (!existsSync(path)) throw new Error(`${label} file not found`);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link file`);
  }
  if (status.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`);
  }
  return readFileSync(path);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseEnv(bytes) {
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) {
    throw new Error("production env file must contain valid UTF-8 text");
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function requiredString(attestation, key, issues) {
  const value = attestation?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${key} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function validateRecoveryAttestation(
  path,
  productionEnvPath,
  productionEnvHash,
  migrationImage,
  now,
) {
  const bytes = readBoundedRegularFile(
    path,
    "P1-09 recovery attestation",
    MAX_ATTESTATION_BYTES,
  );
  let attestation;
  try {
    attestation = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("P1-09 recovery attestation must contain valid JSON");
  }
  if (!attestation || Array.isArray(attestation) || typeof attestation !== "object") {
    throw new Error("P1-09 recovery attestation must be a JSON object");
  }

  const issues = [];
  if (attestation.kind !== RECOVERY_ATTESTATION_KIND) {
    issues.push(`kind must be ${RECOVERY_ATTESTATION_KIND}`);
  }
  if (attestation.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (attestation.environment !== "production") {
    issues.push("environment must be production");
  }
  if (attestation.migrationName !== P109_RECOVERY_MIGRATION) {
    issues.push(`migrationName must be ${P109_RECOVERY_MIGRATION}`);
  }
  if (attestation.productionEnvFile !== basename(productionEnvPath)) {
    issues.push(`productionEnvFile must be ${basename(productionEnvPath)}`);
  }
  if (attestation.productionEnvSha256 !== productionEnvHash) {
    issues.push("productionEnvSha256 does not match the exact production env bytes");
  }
  if (attestation.migrationImage !== migrationImage) {
    issues.push("migrationImage does not match the exact selected migration image digest");
  }

  const assessedAt = requiredString(attestation, "assessedAt", issues);
  const assessedAtMs = Date.parse(assessedAt);
  if (
    assessedAt &&
    (!UTC_TIMESTAMP_PATTERN.test(assessedAt) || Number.isNaN(assessedAtMs))
  ) {
    issues.push("assessedAt must be an exact UTC ISO-8601 timestamp");
  } else if (assessedAtMs > now.getTime()) {
    issues.push("assessedAt must not be in the future");
  } else if (now.getTime() - assessedAtMs > MAX_ATTESTATION_AGE_MS) {
    issues.push("assessedAt must be no more than 30 minutes old");
  }

  requiredString(attestation, "operator", issues);
  requiredString(attestation, "evidenceReference", issues);
  if (attestation.runtimeQuiesced !== true) {
    issues.push("runtimeQuiesced must be true");
  }
  if (attestation.failedMigrationTransactionRolledBack !== true) {
    issues.push("failedMigrationTransactionRolledBack must be true");
  }
  if (attestation.targetCatalogRollbackVerified !== true) {
    issues.push("targetCatalogRollbackVerified must be true");
  }
  if (attestation.remediationOrUnexpectedWriterResolutionCompleted !== true) {
    issues.push("remediationOrUnexpectedWriterResolutionCompleted must be true");
  }
  if (attestation.acknowledgement !== P109_RECOVERY_ACKNOWLEDGEMENT) {
    issues.push(
      `acknowledgement must exactly equal: ${P109_RECOVERY_ACKNOWLEDGEMENT}`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      [
        `P1-09 recovery attestation failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(" ");
}

function composePrefix(options) {
  return [
    "docker",
    "compose",
    "--env-file",
    options.productionEnvFile,
    "-f",
    "compose.production.yml",
    ...(options.tlsProxy ? ["-f", "compose.production-tls.yml"] : []),
  ];
}

function composePullMigrationCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "pull",
    "migrate",
  ];
}

function composeQuiesceCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "--profile",
    "jobs",
    "down",
    "--remove-orphans",
  ];
}

function composeImageChecksumCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "run",
    "-T",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "migrate",
    "-e",
    P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  ];
}

function composeSqlPreflightCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "run",
    "-T",
    "--rm",
    "--no-deps",
    "migrate",
    "db",
    "execute",
    "--stdin",
    "--schema",
    "prisma/schema.prisma",
  ];
}

function composeResolveCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "run",
    "-T",
    "--rm",
    "--no-deps",
    "migrate",
    "migrate",
    "resolve",
    "--rolled-back",
    P109_RECOVERY_MIGRATION,
    "--schema",
    "prisma/schema.prisma",
  ];
}

function defaultRunCommand(command, env, { input } = {}) {
  const commandResult = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    input,
  });
  return {
    status: commandResult.status ?? 1,
    stdout: commandResult.stdout ?? "",
    stderr: commandResult.stderr ?? "",
    error: commandResult.error,
  };
}

function checkedCommand(runCommand, command, env, label, input) {
  let commandResult;
  try {
    commandResult = runCommand(command, env, { input });
  } catch (error) {
    throw new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (commandResult === undefined) {
    return { status: 0, stdout: "", stderr: "" };
  }
  if (commandResult?.status === 0) return commandResult;
  const detail = [
    commandResult?.error instanceof Error ? commandResult.error.message : "",
    commandResult?.stdout ?? "",
    commandResult?.stderr ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-4000);
  throw new Error(
    `${label} failed with exit code ${commandResult?.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
  );
}

function failClosedCleanup(runCommand, command, env) {
  try {
    checkedCommand(
      runCommand,
      command,
      env,
      "fail-closed runtime re-quiesce",
    );
    return "";
  } catch (error) {
    return `Fail-closed runtime cleanup also failed: ${redactProductionDeployTranscript(error instanceof Error ? error.message : String(error))}\n`;
  }
}

function displayCommand(command, options) {
  return commandLine(
    command.map((part) =>
      part === options.productionEnvFile ? "<production-env>" : part,
    ),
  );
}

function displayChecksumCommand(command, options) {
  return displayCommand(
    command.map((part) =>
      part === P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT
        ? "<repository-owned-checksum-script>"
        : part,
    ),
    options,
  );
}

function sanitizeTranscript(value, options) {
  let sanitized = redactProductionDeployTranscript(value);
  for (const path of [
    options.originalProductionEnvFile,
    options.productionEnvFile,
  ]) {
    if (path) sanitized = sanitized.replaceAll(path, "<production-env>");
  }
  return sanitized.replaceAll(
    options.backupOutputDir,
    "<approved-backup-dir>",
  );
}

export function runProductionP109RecoveryFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    now = () => new Date(),
    runPreflight = runProductionDeployPreflightFromArgs,
    runCommand = defaultRunCommand,
    runDeploy = runProductionComposeDeployFromArgs,
    cutoverLockPath = undefined,
    acquireCutoverLock = acquireProductionCutoverLock,
    releaseCutoverLock = releaseProductionCutoverLock,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, "", `${usage()}${error.message}\n`);
  }

  let cutoverLock;
  try {
    cutoverLock = acquireCutoverLock({ lockPath: cutoverLockPath });
  } catch (error) {
    return result(
      1,
      "",
      `P1-09 production recovery failed before validation: ${redactProductionDeployTranscript(error instanceof Error ? error.message : String(error))}\n`,
    );
  }

  let verifiedEnvTempDir = null;
  const executeRecovery = () => {
    const originalProductionEnvPath = resolve(
      repoRoot,
      options.productionEnvFile,
    );
    const attestationPath = resolve(repoRoot, options.recoveryAttestationFile);
    options = {
      ...options,
      originalProductionEnvFile: originalProductionEnvPath,
      productionEnvFile: originalProductionEnvPath,
    };

    let productionEnvBytes;
    let productionEnvHash;
    let migrationImage;
    try {
      productionEnvBytes = readBoundedRegularFile(
        originalProductionEnvPath,
        "production env",
        MAX_PRODUCTION_ENV_BYTES,
      );
      productionEnvHash = sha256(productionEnvBytes);
      const productionEnv = parseEnv(productionEnvBytes);
      migrationImage = productionEnv.CHARITYPILOT_MIGRATION_IMAGE?.trim() ?? "";
      if (!MIGRATION_IMAGE_PATTERN.test(migrationImage)) {
        throw new Error(
          "CHARITYPILOT_MIGRATION_IMAGE must be the canonical migration repository pinned to a lowercase sha256 digest",
        );
      }
      validateRecoveryAttestation(
        attestationPath,
        originalProductionEnvPath,
        productionEnvHash,
        migrationImage,
        now(),
      );
      if (!options.dryRun) {
        verifiedEnvTempDir = mkdtempSync(
          join(tmpdir(), "charitypilot-p109-recovery-env-"),
        );
        const verifiedProductionEnvPath = join(
          verifiedEnvTempDir,
          "validated-production.env",
        );
        writeFileSync(verifiedProductionEnvPath, productionEnvBytes, {
          flag: "wx",
          mode: 0o600,
        });
        options = {
          ...options,
          productionEnvFile: verifiedProductionEnvPath,
        };
      }
    } catch (error) {
      return result(
        1,
        "",
        `P1-09 production recovery failed validation: ${sanitizeTranscript(error instanceof Error ? error.message : String(error), options)}\n`,
      );
    }

    const preflightArgs = [
      "--production-env-file",
      options.productionEnvFile,
      ...(options.dryRun ? ["--dry-run"] : []),
      ...(options.tlsProxy ? [] : ["--no-tls-proxy"]),
    ];
    const preflightResult = runPreflight(preflightArgs, processEnv);
    if (preflightResult.status !== 0) {
      return result(
        1,
        sanitizeTranscript(preflightResult.stdout ?? "", options),
        `P1-09 production recovery failed: standard deploy preflight failed.\n${sanitizeTranscript(preflightResult.stderr ?? "", options)}`,
      );
    }

    const commandEnv = {
      ...processEnv,
      CHARITYPILOT_PRODUCTION_ENV_FILE: options.productionEnvFile,
    };
    const pullCommand = composePullMigrationCommand(options);
    const checksumCommand = composeImageChecksumCommand(options);
    const quiesceCommand = composeQuiesceCommand(options);
    const sqlPreflightCommand = composeSqlPreflightCommand(options);
    const resolveCommand = composeResolveCommand(options);
    const deployArgs = [
      "--production-env-file",
      options.productionEnvFile,
      "--backup-output-dir",
      options.backupOutputDir,
      "--wait-timeout",
      String(options.waitTimeoutSeconds),
      ...(options.dryRun ? ["--dry-run"] : []),
      ...(options.tlsProxy ? [] : ["--no-tls-proxy"]),
    ];

    if (options.dryRun) {
      const deployResult = runDeploy(deployArgs, {
        processEnv,
        cutoverLock,
      });
      if (deployResult.status !== 0) {
        return result(
          deployResult.status,
          sanitizeTranscript(deployResult.stdout ?? "", options),
          `P1-09 production recovery dry-run failed in the delegated deploy plan.\n${sanitizeTranscript(deployResult.stderr ?? "", options)}`,
        );
      }
      return result(
        0,
        [
          "P1-09 production recovery dry-run:",
          `Validated a fresh exact-env-and-image-bound recovery attestation for ${P109_RECOVERY_MIGRATION}.`,
          "Standard deploy preflight:",
          sanitizeTranscript(preflightResult.stdout ?? "", options).trimEnd(),
          "1. Pull the pinned migration image before maintenance mode:",
          displayCommand(pullCommand, options),
          "2. Hash all 20 reviewed migration files inside that selected image:",
          displayChecksumCommand(checksumCommand, options),
          "3. Re-quiesce the complete production runtime and jobs stack:",
          displayCommand(quiesceCommand, options),
          "4. Run the checksum-bound, read-only failed-history, catalog, legacy-object, and six-category data preflight through the pinned image:",
          displayCommand(sqlPreflightCommand, options),
          "   stdin: bounded repository-owned P1-09 recovery SQL (not printed)",
          "5. Mark only the exact failed P1-09 migration rolled back through the pinned image:",
          displayCommand(resolveCommand, options),
          "6. Immediately run the normal locked deploy path with a new retained backup, migration, status, reconciliation, startup, and smoke:",
          sanitizeTranscript(deployResult.stdout ?? "", options).trimEnd(),
          "",
        ]
          .filter((line) => line !== "")
          .join("\n") + "\n",
      );
    }

    let quiesceAttempted = false;
    let migrationResolved = false;
    try {
      checkedCommand(
        runCommand,
        pullCommand,
        commandEnv,
        "pinned migration image pull",
      );
      const checksumResult = checkedCommand(
        runCommand,
        checksumCommand,
        commandEnv,
        "selected migration image checksum capture",
      );
      const selectedImageChecksums = parseP109MigrationChecksumOutput(
        checksumResult.stdout,
      );
      const recoveryPreflightSql = buildP109RecoveryPreflightSql(
        selectedImageChecksums,
      );
      quiesceAttempted = true;
      checkedCommand(
        runCommand,
        quiesceCommand,
        commandEnv,
        "production runtime quiesce",
      );
      checkedCommand(
        runCommand,
        sqlPreflightCommand,
        commandEnv,
        "read-only P1-09 recovery preflight",
        recoveryPreflightSql,
      );

      const currentEnvHash = sha256(
        readBoundedRegularFile(
          options.productionEnvFile,
          "production env",
          MAX_PRODUCTION_ENV_BYTES,
        ),
      );
      if (currentEnvHash !== productionEnvHash) {
        throw new Error(
          "production env bytes changed after attestation validation and before migration resolution",
        );
      }

      checkedCommand(
        runCommand,
        resolveCommand,
        commandEnv,
        `exact ${P109_RECOVERY_MIGRATION} rolled-back resolution`,
      );
      migrationResolved = true;

      const deployResult = runDeploy(deployArgs, {
        processEnv,
        cutoverLock,
      });
      if (deployResult.status !== 0) {
        const cleanupError = failClosedCleanup(
          runCommand,
          quiesceCommand,
          commandEnv,
        );
        return result(
          deployResult.status,
          sanitizeTranscript(deployResult.stdout ?? "", options),
          `P1-09 production recovery failed after exact rolled-back resolution: the delegated production deploy did not complete, and the runtime remains stopped.\n${sanitizeTranscript(deployResult.stderr ?? "", options)}${cleanupError}`,
        );
      }
      return result(
        0,
        `${sanitizeTranscript(preflightResult.stdout ?? "", options)}${sanitizeTranscript(deployResult.stdout ?? "", options)}P1-09 failed migration was resolved as rolled back and immediately recovered through the complete production deploy path.\n`,
      );
    } catch (error) {
      const cleanupError = quiesceAttempted
        ? failClosedCleanup(runCommand, quiesceCommand, commandEnv)
        : "";
      const resolutionPosture = migrationResolved
        ? " The exact migration history row was already marked rolled back; the runtime remains stopped and requires a fresh controlled deploy after the failure is resolved."
        : " No migration-history resolution was accepted.";
      return result(
        1,
        sanitizeTranscript(preflightResult.stdout ?? "", options),
        `P1-09 production recovery failed: ${sanitizeTranscript(error instanceof Error ? error.message : String(error), options)}.${resolutionPosture}\n${cleanupError}`,
      );
    }
  };

  let recoveryResult;
  let operationError;
  try {
    recoveryResult = executeRecovery();
  } catch (error) {
    operationError = error;
  }

  if (verifiedEnvTempDir) {
    try {
      rmSync(verifiedEnvTempDir, { recursive: true, force: true });
    } catch (error) {
      const cleanupMessage = redactProductionDeployTranscript(
        error instanceof Error ? error.message : String(error),
      );
      const priorError = recoveryResult?.stderr
        ? `${recoveryResult.stderr.trimEnd()}\n`
        : "";
      recoveryResult = result(
        1,
        recoveryResult?.stdout ?? "",
        `${priorError}P1-09 production recovery could not remove its owner-only validated env copy: ${cleanupMessage}. Do not start another cutover until the temporary-file state is reconciled.\n`,
      );
    }
  }

  try {
    releaseCutoverLock(cutoverLock);
  } catch (error) {
    const priorError = recoveryResult?.stderr
      ? `${recoveryResult.stderr.trimEnd()}\n`
      : operationError
        ? `P1-09 production recovery failed unexpectedly: ${redactProductionDeployTranscript(operationError instanceof Error ? operationError.message : String(operationError))}\n`
        : "";
    const releaseError = redactProductionDeployTranscript(
      error instanceof Error ? error.message : String(error),
    );
    return result(
      1,
      recoveryResult?.stdout ?? "",
      `${priorError}P1-09 production recovery could not release the host cutover lock: ${releaseError}. The prior recovery result is preserved above; do not start another deploy, rollback, or recovery until the lock owner and runtime state are reconciled.\n`,
    );
  }

  if (operationError) {
    return result(
      1,
      recoveryResult?.stdout ?? "",
      `P1-09 production recovery failed unexpectedly: ${redactProductionDeployTranscript(operationError instanceof Error ? operationError.message : String(operationError))}\n`,
    );
  }
  return recoveryResult;
}

function main() {
  const recoveryResult = runProductionP109RecoveryFromArgs();
  if (recoveryResult.stdout) process.stdout.write(recoveryResult.stdout);
  if (recoveryResult.stderr) process.stderr.write(recoveryResult.stderr);
  process.exit(recoveryResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
