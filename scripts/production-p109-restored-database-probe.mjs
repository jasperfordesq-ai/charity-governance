const P107A_MIGRATION = "20260712013000_add_password_recovery_integrity";

export const P109_RESTORED_MIGRATIONS = Object.freeze([
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
  "20260711213000_add_document_storage_deletion_retry_lifecycle",
  "20260711230000_add_domain_invariants_referential_safety",
]);

export const P109_RESTORED_MIGRATION_HEAD = P109_RESTORED_MIGRATIONS.at(-1);
const CHECKSUM_VALUES_PLACEHOLDER =
  "__CHARITYPILOT_P109_RESTORED_SELECTED_IMAGE_CHECKSUM_VALUES__";
const MIGRATION_NAMES_SQL = P109_RESTORED_MIGRATIONS.map(
  (migration) => `'${migration}'`,
).join(",\n      ");

// This statement is deliberately left open after its terminal invariant block.
// Prisma 6.19.3 can mask a raised error when a later ROLLBACK succeeds. Closing
// the short-lived read-only connection rolls the transaction back without
// replacing the invariant failure with a successful trailing statement.
export const P109_RESTORED_HISTORY_PROBE_SQL_TEMPLATE = String.raw`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $p109_restored$
DECLARE
  total_history_rows BIGINT;
  applied_history_rows BIGINT;
  applied_distinct_rows BIGINT;
  unresolved_history_rows BIGINT;
  unexpected_history_rows BIGINT;
  p109_head_rows BIGINT;
  p107a_history_rows BIGINT;
  checksum_mismatch_rows BIGINT;
  p107a_table_rows BIGINT;
  p107a_type_rows BIGINT;
  p107a_function_rows BIGINT;
  p107a_trigger_rows BIGINT;
  p107a_existing_table_index_rows BIGINT;
  p109_constraint_rows BIGINT;
  p109_tenant_fk_rows BIGINT;
  p109_composite_index_rows BIGINT;
  legacy_reset_column_rows BIGINT;
BEGIN
  IF TO_REGCLASS('public."_prisma_migrations"') IS NULL THEN
    RAISE EXCEPTION 'P1-09 restored-history probe requires the Prisma migration history table';
  END IF;

  SELECT COUNT(*)
  INTO total_history_rows
  FROM "_prisma_migrations";

  SELECT COUNT(*), COUNT(DISTINCT migration_name)
  INTO applied_history_rows, applied_distinct_rows
  FROM "_prisma_migrations"
  WHERE migration_name IN (
      ${MIGRATION_NAMES_SQL}
    )
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND applied_steps_count = 1;

  SELECT COUNT(*)
  INTO unresolved_history_rows
  FROM "_prisma_migrations"
  WHERE finished_at IS NULL
    AND rolled_back_at IS NULL;

  SELECT COUNT(*)
  INTO unexpected_history_rows
  FROM "_prisma_migrations"
  WHERE migration_name NOT IN (
      ${MIGRATION_NAMES_SQL}
    );

  SELECT COUNT(*)
  INTO p109_head_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '${P109_RESTORED_MIGRATION_HEAD}'
    AND finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND applied_steps_count = 1;

  SELECT COUNT(*)
  INTO p107a_history_rows
  FROM "_prisma_migrations"
  WHERE migration_name = '${P107A_MIGRATION}';

  SELECT COUNT(*)
  INTO checksum_mismatch_rows
  FROM (
    VALUES
      ${CHECKSUM_VALUES_PLACEHOLDER}
  ) AS selected_image(migration_name, checksum)
  LEFT JOIN "_prisma_migrations" AS migration_history
    ON migration_history.migration_name = selected_image.migration_name
  WHERE migration_history.checksum IS DISTINCT FROM selected_image.checksum;

  IF total_history_rows <> 20
     OR applied_history_rows <> 20
     OR applied_distinct_rows <> 20
     OR unresolved_history_rows <> 0
     OR unexpected_history_rows <> 0
     OR p109_head_rows <> 1
     OR p107a_history_rows <> 0
     OR checksum_mismatch_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 restore-only rollback requires exactly 20 selected-image-checksum-bound applied migrations through P1-09, no unresolved or unexpected history, and no P1-07A history';
  END IF;

  SELECT COUNT(*)
  INTO p107a_table_rows
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
  INTO p107a_type_rows
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
  INTO p107a_function_rows
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
  INTO p107a_trigger_rows
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'PasswordRecoveryRequest_guard_integrity',
      'User_invalidate_password_recovery_on_password_change',
      'User_guard_retired_password_recovery_slot',
      'AuthRecoveryRetiredSecret_guard_integrity',
      'AuthRecoveryRetiredSecret_reject_truncate',
      'AuthRecoveryControl_guard_integrity',
      'AuthSecurityEmailOutbox_guard_integrity'
    );

  SELECT COUNT(*)
  INTO p107a_existing_table_index_rows
  FROM pg_catalog.pg_class AS index_row
  WHERE index_row.oid = TO_REGCLASS('public."SecurityAuditEvent_id_organisationId_key"');

  IF p107a_table_rows <> 0
     OR p107a_type_rows <> 0
     OR p107a_function_rows <> 0
     OR p107a_trigger_rows <> 0
     OR p107a_existing_table_index_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 restore-only rollback refused P1-07A catalog residue';
  END IF;

  SELECT COUNT(*)
  INTO p109_constraint_rows
  FROM (
    VALUES
      ('BoardMember', 'BoardMember_term_chronology_check', 'c'::"char"),
      ('BoardMember', 'BoardMember_conduct_signed_date_equivalence_check', 'c'::"char"),
      ('BoardMember', 'BoardMember_induction_date_equivalence_check', 'c'::"char"),
      ('FundraisingRecord', 'FundraisingRecord_date_chronology_check', 'c'::"char"),
      ('AnnualReportReadiness', 'AnnualReportReadiness_filed_date_required_check', 'c'::"char"),
      ('BoardMember', 'BoardMember_id_organisationId_key', 'u'::"char"),
      ('ConflictRecord', 'ConflictRecord_boardMemberId_organisationId_fkey', 'f'::"char")
  ) AS expected(table_name, constraint_name, constraint_type)
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.relname = expected.table_name
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
   AND namespace_row.nspname = 'public'
  JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.conrelid = table_row.oid
   AND constraint_row.conname = expected.constraint_name
   AND constraint_row.contype = expected.constraint_type
   AND constraint_row.convalidated;

  SELECT COUNT(*)
  INTO p109_tenant_fk_rows
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relname = 'ConflictRecord'
    AND constraint_row.conname = 'ConflictRecord_boardMemberId_organisationId_fkey'
    AND constraint_row.contype = 'f'
    AND constraint_row.convalidated
    AND constraint_row.confdeltype = 'r'
    AND constraint_row.confupdtype = 'r'
    AND PG_GET_CONSTRAINTDEF(constraint_row.oid) ILIKE '%FOREIGN KEY ("boardMemberId", "organisationId")%'
    AND PG_GET_CONSTRAINTDEF(constraint_row.oid) ILIKE '%REFERENCES "BoardMember"(id, "organisationId")%';

  SELECT COUNT(*)
  INTO p109_composite_index_rows
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = index_metadata.indrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relname = 'ConflictRecord'
    AND index_row.relname = 'ConflictRecord_boardMemberId_organisationId_idx'
    AND NOT index_metadata.indisunique
    AND index_metadata.indisvalid
    AND index_metadata.indpred IS NULL
    AND index_metadata.indexprs IS NULL
    AND PG_GET_INDEXDEF(index_metadata.indexrelid) ILIKE '%("boardMemberId", "organisationId")%';

  SELECT COUNT(*)
  INTO legacy_reset_column_rows
  FROM pg_catalog.pg_attribute AS attribute_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = attribute_row.attrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relname = 'User'
    AND attribute_row.attname IN ('resetToken', 'resetTokenExpiry')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped
    AND NOT attribute_row.attnotnull
    AND NOT attribute_row.atthasdef
    AND (
      (attribute_row.attname = 'resetToken'
        AND FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod) = 'text')
      OR
      (attribute_row.attname = 'resetTokenExpiry'
        AND FORMAT_TYPE(attribute_row.atttypid, attribute_row.atttypmod) = 'timestamp(3) without time zone')
    );

  IF p109_constraint_rows <> 7
     OR p109_tenant_fk_rows <> 1
     OR p109_composite_index_rows <> 1
     OR TO_REGCLASS('public."ConflictRecord_boardMemberId_idx"') IS NOT NULL
     OR TO_REGCLASS('public."User_resetToken_key"') IS NULL
     OR legacy_reset_column_rows <> 2
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_enum AS enum_value
       JOIN pg_catalog.pg_type AS enum_type
         ON enum_type.oid = enum_value.enumtypid
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = enum_type.typnamespace
       WHERE namespace_row.nspname = 'public'
         AND enum_type.typname = 'SecurityAuditEventType'
         AND enum_value.enumlabel = 'PASSWORD_RESET_COMPLETED'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_enum AS enum_value
       JOIN pg_catalog.pg_type AS enum_type
         ON enum_type.oid = enum_value.enumtypid
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = enum_type.typnamespace
       WHERE namespace_row.nspname = 'public'
         AND enum_type.typname = 'SecurityAuditEventType'
         AND enum_value.enumlabel = 'ALL_SESSIONS_REVOKED'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'P1-09 restore-only rollback requires the exact P1-09 predecessor catalog and both legacy User reset columns';
  END IF;
END;
$p109_restored$;`;

function validatedChecksums(migrations) {
  if (!migrations || Array.isArray(migrations) || typeof migrations !== "object") {
    throw new Error("P1-09 restored-history checksums must be an object");
  }
  const actualNames = Object.keys(migrations).sort();
  const expectedNames = [...P109_RESTORED_MIGRATIONS].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "P1-09 restored-history checksums must contain exactly the 20 reviewed migrations",
    );
  }
  return Object.fromEntries(P109_RESTORED_MIGRATIONS.map((name) => {
    const checksum = migrations[name];
    if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(
        `P1-09 restored-history checksum for ${name} must be 64 lowercase hexadecimal characters`,
      );
    }
    return [name, checksum];
  }));
}

export function assertP109RestoredHistoryProbeSql(sql) {
  if (!sql.startsWith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;")) {
    throw new Error("P1-09 restored-history probe must begin read-only");
  }
  if (/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|ROLLBACK)\b/im.test(sql)) {
    throw new Error("P1-09 restored-history probe must not write or mask its terminal assertion");
  }
  if (!sql.endsWith("END;\n$p109_restored$;")) {
    throw new Error("P1-09 restored-history invariant block must be terminal");
  }
  return sql;
}

export function buildP109RestoredHistoryProbeSql(migrations) {
  const checksums = validatedChecksums(migrations);
  const checksumValues = P109_RESTORED_MIGRATIONS.map(
    (name) => `('${name}', '${checksums[name]}')`,
  ).join(",\n      ");
  const sql = P109_RESTORED_HISTORY_PROBE_SQL_TEMPLATE.replace(
    CHECKSUM_VALUES_PLACEHOLDER,
    checksumValues,
  );
  if (sql.includes(CHECKSUM_VALUES_PLACEHOLDER)) {
    throw new Error("P1-09 restored-history checksum binding was incomplete");
  }
  return assertP109RestoredHistoryProbeSql(sql);
}

export const P109_RESTORED_HISTORY_PROBE_SUCCESS =
  "Exact P1-09 restored-history checksum and P1-07A-absence probe passed before any migration.";

// The selected rollback migration image hashes its own immutable migration
// bytes, refuses any migration directory beyond the exact P1-09 boundary, then
// runs the terminal read-only SQL through the Prisma CLI shipped in that image.
export const P109_RESTORED_HISTORY_PROBE_IMAGE_SCRIPT = [
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  'const childProcess = require("child_process");',
  `const expected = ${JSON.stringify(P109_RESTORED_MIGRATIONS)};`,
  'const actual = fs.readdirSync("prisma/migrations", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();',
  'if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) { throw new Error("Selected rollback migration image must contain exactly the 20 reviewed migrations through P1-09"); }',
  'const migrations = Object.fromEntries(expected.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(`prisma/migrations/${name}/migration.sql`)).digest("hex")]));',
  `const template = ${JSON.stringify(P109_RESTORED_HISTORY_PROBE_SQL_TEMPLATE)};`,
  `const placeholder = ${JSON.stringify(CHECKSUM_VALUES_PLACEHOLDER)};`,
  'const values = expected.map((name) => `(\'${name}\', \'${migrations[name]}\')`).join(",\\n      ");',
  'const sql = template.replace(placeholder, values);',
  'if (sql.includes(placeholder) || !sql.endsWith("END;\\n$p109_restored$;")) { throw new Error("P1-09 restored-history SQL binding failed"); }',
  'const result = childProcess.spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "execute", "--stdin", "--schema", "prisma/schema.prisma"], { input: sql, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });',
  'if (result.error) { throw result.error; }',
  'if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout || "P1-09 restored-history probe failed\\n"); process.exit(result.status || 1); }',
  `process.stdout.write(${JSON.stringify(P109_RESTORED_HISTORY_PROBE_SUCCESS + "\n")});`,
].join("\n");

export function p109RestoredHistoryProbeComposeCommand({
  productionEnvFile,
  tlsProxy = true,
}) {
  return [
    "docker",
    "compose",
    "--env-file",
    productionEnvFile,
    "-f",
    "compose.production.yml",
    ...(tlsProxy ? ["-f", "compose.production-tls.yml"] : []),
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "migrate",
    "-e",
    P109_RESTORED_HISTORY_PROBE_IMAGE_SCRIPT,
  ];
}
