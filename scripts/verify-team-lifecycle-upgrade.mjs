#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_MIGRATIONS_ROOT = join(REPOSITORY_ROOT, 'apps', 'api', 'prisma', 'migrations');
const TARGET_MIGRATION = '20260711030000_add_team_lifecycle_security';
const PREVIOUS_MIGRATION = '20260710190000_add_deadline_calendar_lifecycle';
const USAGE = 'Usage: node scripts/verify-team-lifecycle-upgrade.mjs [--keep-databases] [--dry-run]';

const VALID_UPGRADE_SEED_SQL = String.raw`
INSERT INTO "Organisation" ("id", "name", "createdAt", "updatedAt") VALUES
  ('p007-org-a', 'P0-07 Organisation A', TIMESTAMP '2024-01-02 03:04:05', TIMESTAMP '2026-07-10 22:00:00'),
  ('p007-org-b', 'P0-07 Organisation B', TIMESTAMP '2024-02-03 04:05:06', TIMESTAMP '2026-07-10 22:00:00');

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId",
  "emailVerified", "createdAt", "updatedAt"
) VALUES
  ('p007-owner-a', 'owner-a@example.test', 'Owner A', 'fixture-hash', 'OWNER', 'p007-org-a', true, TIMESTAMP '2024-01-02 03:05:00', TIMESTAMP '2026-07-10 22:00:00'),
  ('p007-member-a', 'member-a@example.test', 'Member A', 'fixture-hash', 'MEMBER', 'p007-org-a', true, TIMESTAMP '2024-01-03 03:05:00', TIMESTAMP '2026-07-10 22:00:00'),
  ('p007-member-remove', 'remove-a@example.test', 'Removal Candidate', 'fixture-hash', 'MEMBER', 'p007-org-a', true, TIMESTAMP '2024-01-04 03:05:00', TIMESTAMP '2026-07-10 22:00:00'),
  ('p007-member-delete', 'delete-a@example.test', 'Deletion Candidate', 'fixture-hash', 'MEMBER', 'p007-org-a', true, TIMESTAMP '2024-01-05 03:05:00', TIMESTAMP '2026-07-10 22:00:00'),
  ('p007-owner-b', 'owner-b@example.test', 'Owner B', 'fixture-hash', 'OWNER', 'p007-org-b', true, TIMESTAMP '2024-02-03 04:06:00', TIMESTAMP '2026-07-10 22:00:00');

INSERT INTO "TeamInvite" (
  "id", "organisationId", "email", "role", "token", "invitedById",
  "expiresAt", "updatedAt"
) VALUES (
  'p007-invite-valid', 'p007-org-a', 'invitee@example.test', 'MEMBER',
  'p007-valid-token', 'p007-owner-a', TIMESTAMP '2099-01-01 00:00:00',
  TIMESTAMP '2026-07-10 22:00:00'
);

INSERT INTO "AuthSession" (
  "id", "userId", "refreshTokenHash", "expiresAt", "revokedAt", "createdAt", "updatedAt"
) VALUES
  ('p007-session-active', 'p007-owner-a', 'p007-active-hash', TIMESTAMP '2099-01-01 00:00:00', NULL, TIMESTAMP '2026-01-01 01:00:00', TIMESTAMP '2026-01-01 01:00:00'),
  ('p007-session-revoked', 'p007-member-a', 'p007-revoked-hash', TIMESTAMP '2026-06-01 00:00:00', TIMESTAMP '2026-05-01 00:00:00', TIMESTAMP '2026-01-02 01:00:00', TIMESTAMP '2026-05-01 00:00:00');
`;

const VALID_UPGRADE_ASSERTIONS_SQL = String.raw`
DO $fixture$
DECLARE
  owner_index_definition TEXT;
  family_index_definition TEXT;
  unsafe_truncate_triggers INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Organisation"
    WHERE "lifecycleStatus" <> 'ACTIVE'::"OrganisationLifecycleStatus"
       OR "lifecycleVersion" <> 1
       OR "lifecycleChangedAt" <> "createdAt"
  ) THEN
    RAISE EXCEPTION 'Organisation lifecycle provenance was not backfilled exactly';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE "lifecycleStatus" <> 'ACTIVE'::"UserLifecycleStatus"
       OR "membershipVersion" <> 1
       OR "membershipChangedAt" <> "createdAt"
  ) THEN
    RAISE EXCEPTION 'User lifecycle provenance was not backfilled exactly';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AuthSession"
    WHERE "revokedAt" IS NULL
       OR "revocationReason" <> 'LEGACY_UNSPECIFIED'::"AuthSessionRevocationReason"
       OR "familyId" IS NULL
       OR "familyCreatedAt" <> "createdAt"
  ) THEN
    RAISE EXCEPTION 'Legacy sessions were not conservatively revoked with family provenance';
  END IF;

  SELECT PG_GET_INDEXDEF(index_entry.indexrelid)
  INTO owner_index_definition
  FROM pg_catalog.pg_index AS index_entry
  JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_entry.indexrelid
  WHERE index_class.relname = 'User_one_active_owner_per_organisation';

  IF owner_index_definition IS NULL
     OR owner_index_definition NOT ILIKE '%WHERE%role%OWNER%lifecycleStatus%ACTIVE%' THEN
    RAISE EXCEPTION 'Active-owner partial unique index is missing or has the wrong predicate';
  END IF;

  SELECT PG_GET_INDEXDEF(index_entry.indexrelid)
  INTO family_index_definition
  FROM pg_catalog.pg_index AS index_entry
  JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_entry.indexrelid
  WHERE index_class.relname = 'AuthSession_one_active_session_per_family';

  IF family_index_definition IS NULL
     OR family_index_definition NOT ILIKE '%WHERE%revokedAt%IS NULL%' THEN
    RAISE EXCEPTION 'Active session-family partial unique index is missing or malformed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_catalog.pg_trigger
    WHERE tgname IN (
      'User_exactly_one_active_owner',
      'Organisation_exactly_one_active_owner'
    )
      AND tgdeferrable
      AND tginitdeferred
  ) <> 2 THEN
    RAISE EXCEPTION 'Owner continuity triggers are not both deferrable and initially deferred';
  END IF;

  IF TO_REGCLASS('public."SecurityAuditEvent"') IS NULL THEN
    RAISE EXCEPTION 'SecurityAuditEvent table is missing';
  END IF;

  SELECT COUNT(*)::INTEGER
  INTO unsafe_truncate_triggers
  FROM pg_catalog.pg_trigger
  WHERE NOT tgisinternal
    AND (tgtype::INTEGER & 32) = 32
    AND tgrelid IN (
      'public."User"'::regclass,
      'public."AuthSession"'::regclass,
      'public."SecurityAuditEvent"'::regclass
    );

  IF unsafe_truncate_triggers <> 0 THEN
    RAISE EXCEPTION 'P0-07 added an unsafe ON TRUNCATE trigger';
  END IF;
END;
$fixture$;
`;

const FAILED_MIGRATION_ATOMICITY_SQL = String.raw`
DO $fixture$
BEGIN
  IF TO_REGTYPE('public."OrganisationLifecycleStatus"') IS NOT NULL
     OR TO_REGTYPE('public."UserLifecycleStatus"') IS NOT NULL
     OR TO_REGTYPE('public."AuthSessionRevocationReason"') IS NOT NULL
     OR TO_REGTYPE('public."SecurityAuditEventType"') IS NOT NULL
     OR TO_REGCLASS('public."SecurityAuditEvent"') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'Organisation' AND column_name = 'lifecycleStatus')
           OR (table_name = 'User' AND column_name = 'lifecycleStatus')
           OR (table_name = 'AuthSession' AND column_name = 'familyId')
         )
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc
       WHERE proname IN (
         'assert_exactly_one_active_owner',
         'guard_auth_session_principal',
         'reject_security_audit_mutation'
       )
     ) THEN
    RAISE EXCEPTION 'Failed P0-07 migration left partial schema objects behind';
  END IF;
END;
$fixture$;
`;

const ZERO_OWNER_SEED_SQL = String.raw`
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p007-zero-owner', 'Zero owner fixture', CURRENT_TIMESTAMP);
`;

const MULTIPLE_OWNER_SEED_SQL = String.raw`
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p007-two-owner', 'Two owner fixture', CURRENT_TIMESTAMP);
INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt"
) VALUES
  ('p007-two-owner-a', 'two-owner-a@example.test', 'Owner A', 'fixture', 'OWNER', 'p007-two-owner', true, CURRENT_TIMESTAMP),
  ('p007-two-owner-b', 'two-owner-b@example.test', 'Owner B', 'fixture', 'OWNER', 'p007-two-owner', true, CURRENT_TIMESTAMP);
`;

const OWNER_INVITE_SEED_SQL = String.raw`
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p007-owner-invite-org', 'Owner invite fixture', CURRENT_TIMESTAMP);
INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt"
) VALUES ('p007-owner-invite-owner', 'owner-invite-owner@example.test', 'Owner', 'fixture', 'OWNER', 'p007-owner-invite-org', true, CURRENT_TIMESTAMP);
INSERT INTO "TeamInvite" (
  "id", "organisationId", "email", "role", "token", "invitedById", "expiresAt", "updatedAt"
) VALUES (
  'p007-owner-invite', 'p007-owner-invite-org', 'future-owner@example.test', 'OWNER',
  'p007-owner-invite-token', 'p007-owner-invite-owner', TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
);
`;

const DUAL_TERMINAL_INVITE_SEED_SQL = String.raw`
INSERT INTO "Organisation" ("id", "name", "updatedAt")
VALUES ('p007-dual-invite-org', 'Dual invite fixture', CURRENT_TIMESTAMP);
INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt"
) VALUES ('p007-dual-invite-owner', 'dual-invite-owner@example.test', 'Owner', 'fixture', 'OWNER', 'p007-dual-invite-org', true, CURRENT_TIMESTAMP);
INSERT INTO "TeamInvite" (
  "id", "organisationId", "email", "role", "token", "invitedById",
  "acceptedAt", "revokedAt", "expiresAt", "updatedAt"
) VALUES (
  'p007-dual-invite', 'p007-dual-invite-org', 'dual@example.test', 'MEMBER',
  'p007-dual-invite-token', 'p007-dual-invite-owner', CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP, TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
);
`;

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function resultText(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function requireSuccess(result, description) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}:\n${resultText(result)}`);
  }
}

function validateDatabasePrefix(prefix) {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(prefix)) {
    throw new Error('CHARITYPILOT_P007_UPGRADE_DB_PREFIX must be a short lowercase PostgreSQL identifier');
  }
  return prefix;
}

export function discoverTeamLifecycleUpgradeMigrations(migrationsRoot = DEFAULT_MIGRATIONS_ROOT) {
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const targetIndex = migrations.indexOf(TARGET_MIGRATION);
  if (targetIndex === -1) throw new Error(`Missing target migration: ${TARGET_MIGRATION}`);
  if (migrations[targetIndex - 1] !== PREVIOUS_MIGRATION) {
    throw new Error(`P0-07 historical boundary must immediately follow ${PREVIOUS_MIGRATION}`);
  }
  return { previous: migrations.slice(0, targetIndex), target: TARGET_MIGRATION };
}

export async function verifyTeamLifecycleUpgrade({
  args = process.argv.slice(2),
  env = process.env,
  migrationsRoot = DEFAULT_MIGRATIONS_ROOT,
  commandRunner = defaultCommandRunner,
  stdout = process.stdout,
} = {}) {
  const allowedArgs = new Set(['--keep-databases', '--dry-run']);
  const unknown = args.find((arg) => !allowedArgs.has(arg));
  if (unknown) throw new Error(`Unknown option: ${unknown}\n${USAGE}`);

  const keepDatabases = args.includes('--keep-databases');
  const dryRun = args.includes('--dry-run');
  const dockerBin = env.CHARITYPILOT_CI_POSTGRES_DOCKER_BIN ?? 'docker';
  const container = env.CHARITYPILOT_CI_POSTGRES_CONTAINER ?? 'charitypilot-ci-postgres';
  const user = env.CHARITYPILOT_CI_POSTGRES_USER ?? 'charitypilot';
  const adminDatabase = env.CHARITYPILOT_CI_POSTGRES_ADMIN_DB ?? 'postgres';
  const prefix = validateDatabasePrefix(
    env.CHARITYPILOT_P007_UPGRADE_DB_PREFIX ?? 'charitypilot_p007_upgrade',
  );
  const databases = {
    base: `${prefix}_base`,
    success: `${prefix}_success`,
    zeroOwner: `${prefix}_zero_owner`,
    multipleOwner: `${prefix}_multiple_owner`,
    ownerInvite: `${prefix}_owner_invite`,
    dualInvite: `${prefix}_dual_invite`,
  };
  const allDatabases = Object.values(databases);
  const plan = discoverTeamLifecycleUpgradeMigrations(migrationsRoot);

  if (dryRun) {
    stdout.write(`Container: ${container}\n`);
    stdout.write(`Pre-P0-07 migrations: ${plan.previous.length}\n`);
    stdout.write(`Previous migration: ${plan.previous.at(-1)}\n`);
    stdout.write(`Target migration: ${plan.target}\n`);
    stdout.write(`Disposable databases: ${allDatabases.join(', ')}\n`);
    return;
  }

  const runDocker = (dockerArgs, description, options = {}) => {
    const result = commandRunner(dockerBin, dockerArgs, options);
    if (!options.allowFailure) requireSuccess(result, description);
    return result;
  };
  const psql = (database, sql, description, options = {}) => runDocker([
    'exec', '-i', container,
    'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--username', user, '--dbname', database,
  ], description, { ...options, input: sql });
  const dropDatabase = (database) => runDocker([
    'exec', container, 'dropdb', '--if-exists', '--force', '--username', user, database,
  ], `drop disposable database ${database}`, { allowFailure: true });
  const createDatabase = (database, template) => runDocker([
    'exec', container, 'createdb', '--username', user,
    ...(template ? ['--template', template] : []),
    database,
  ], `create disposable database ${database}`);
  const applyMigration = (database, migrationName, options = {}) => {
    const sql = readFileSync(join(migrationsRoot, migrationName, 'migration.sql'), 'utf8');
    return psql(
      database,
      `BEGIN;\n${sql}\nCOMMIT;\n`,
      `apply ${migrationName} to ${database}`,
      options,
    );
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
  const assertMigrationFailure = (database, seedSql, expectedError, description) => {
    createDatabase(database, databases.base);
    psql(database, seedSql, `seed ${description}`);
    const result = applyMigration(database, plan.target, { allowFailure: true });
    if (result.error) throw result.error;
    if (result.status === 0) throw new Error(`${description} migration unexpectedly succeeded`);
    const failure = resultText(result);
    if (!expectedError.test(failure)) {
      throw new Error(`${description} migration failed for an unexpected reason:\n${failure}`);
    }
    psql(database, FAILED_MIGRATION_ATOMICITY_SQL, `verify ${description} atomic rollback`);
    stdout.write(`Verified fail-closed ${description} migration and atomic rollback.\n`);
  };

  for (const database of [...allDatabases].reverse()) dropDatabase(database);

  try {
    createDatabase(databases.base);
    for (const migrationName of plan.previous) applyMigration(databases.base, migrationName);
    stdout.write(`Applied ${plan.previous.length} migrations through ${plan.previous.at(-1)}.\n`);

    assertMigrationFailure(
      databases.zeroOwner,
      ZERO_OWNER_SEED_SQL,
      /exactly one legacy owner/i,
      'zero-owner',
    );
    assertMigrationFailure(
      databases.multipleOwner,
      MULTIPLE_OWNER_SEED_SQL,
      /exactly one legacy owner/i,
      'multiple-owner',
    );
    assertMigrationFailure(
      databases.ownerInvite,
      OWNER_INVITE_SEED_SQL,
      /OWNER invitations require manual resolution/i,
      'OWNER-invite',
    );
    assertMigrationFailure(
      databases.dualInvite,
      DUAL_TERMINAL_INVITE_SEED_SQL,
      /cannot be both accepted and revoked/i,
      'accepted-and-revoked-invite',
    );

    createDatabase(databases.success, databases.base);
    psql(databases.success, VALID_UPGRADE_SEED_SQL, 'seed representative P0-07 upgrade fixture');
    applyMigration(databases.success, plan.target);
    psql(databases.success, VALID_UPGRADE_ASSERTIONS_SQL, 'assert P0-07 upgrade provenance and catalog');

    psql(databases.success, String.raw`
      BEGIN;
      UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = 'p007-owner-a';
      UPDATE "User" SET "role" = 'OWNER' WHERE "id" = 'p007-member-a';
      COMMIT;
    `, 'verify valid deferred ownership transfer');
    assertSqlFailure(databases.success, String.raw`
      UPDATE "User" SET "role" = 'MEMBER' WHERE "id" = 'p007-member-a';
    `, /exactly one active owner/i, 'last-owner demotion');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "User" (
        "id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt"
      ) VALUES ('p007-second-owner', 'second-owner@example.test', 'Second Owner', 'fixture', 'OWNER', 'p007-org-a', true, CURRENT_TIMESTAMP);
    `, /User_one_active_owner_per_organisation|duplicate key/i, 'second active owner insertion');
    assertSqlFailure(databases.success, String.raw`
      DELETE FROM "User" WHERE "id" = 'p007-member-delete';
    `, /auditable lifecycle workflow/i, 'hard user deletion');

    psql(databases.success, String.raw`
      UPDATE "User" SET "lifecycleStatus" = 'SUSPENDED' WHERE "id" = 'p007-member-remove';
    `, 'suspend a non-owner membership');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "AuthSession" (
        "id", "userId", "refreshTokenHash", "familyId", "familyCreatedAt", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-inactive-session', 'p007-member-remove', 'p007-inactive-session-hash',
        '00000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP,
        TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, /active organisation and active user/i, 'inactive-user session insertion');
    psql(databases.success, String.raw`
      UPDATE "User" SET "lifecycleStatus" = 'REMOVED' WHERE "id" = 'p007-member-remove';
    `, 'remove a suspended membership');
    assertSqlFailure(databases.success, String.raw`
      UPDATE "User" SET "lifecycleStatus" = 'ACTIVE' WHERE "id" = 'p007-member-remove';
    `, /Removed memberships are terminal/i, 'removed membership reactivation');

    psql(databases.success, String.raw`
      INSERT INTO "AuthSession" (
        "id", "userId", "refreshTokenHash", "familyId", "familyCreatedAt", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-family-root', 'p007-member-a', 'p007-family-root-hash',
        '00000000-0000-4000-8000-000000000002', TIMESTAMP '2026-07-10 23:00:00',
        TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, 'create an active post-upgrade session family');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "AuthSession" (
        "id", "userId", "refreshTokenHash", "familyId", "familyCreatedAt", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-family-second-active', 'p007-member-a', 'p007-family-second-active-hash',
        '00000000-0000-4000-8000-000000000002', TIMESTAMP '2026-07-10 23:00:00',
        TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, /AuthSession_one_active_session_per_family|duplicate key/i, 'second active family session');
    psql(databases.success, String.raw`
      UPDATE "AuthSession"
      SET "revokedAt" = CURRENT_TIMESTAMP,
          "revocationReason" = 'LOGOUT',
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'p007-family-root';
    `, 'record one-way session revocation');
    assertSqlFailure(databases.success, String.raw`
      UPDATE "AuthSession"
      SET "revokedAt" = NULL, "revocationReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'p007-family-root';
    `, /revocation evidence is immutable/i, 'session reactivation');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "AuthSession" (
        "id", "userId", "refreshTokenHash", "familyId", "familyCreatedAt", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-family-cross-user', 'p007-owner-a', 'p007-family-cross-user-hash',
        '00000000-0000-4000-8000-000000000002', TIMESTAMP '2026-07-10 23:00:00',
        TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, /family identity is inconsistent/i, 'cross-user family reuse');

    psql(databases.success, String.raw`
      UPDATE "Organisation" SET "lifecycleStatus" = 'CLOSED' WHERE "id" = 'p007-org-b';
    `, 'close an organisation');
    assertSqlFailure(databases.success, String.raw`
      UPDATE "Organisation" SET "lifecycleStatus" = 'ACTIVE' WHERE "id" = 'p007-org-b';
    `, /Closed organisations cannot be reactivated/i, 'closed organisation reactivation');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "AuthSession" (
        "id", "userId", "refreshTokenHash", "familyId", "familyCreatedAt", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-closed-org-session', 'p007-owner-b', 'p007-closed-org-session-hash',
        '00000000-0000-4000-8000-000000000003', CURRENT_TIMESTAMP,
        TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, /active organisation and active user/i, 'closed-organisation session insertion');

    psql(databases.success, String.raw`
      INSERT INTO "SecurityAuditEvent" (
        "id", "organisationId", "type", "actorKind", "actorUserId", "actorLabel",
        "subjectUserId", "reason", "context", "requestId"
      ) VALUES (
        'p007-audit-valid', 'p007-org-a', 'MEMBER_REMOVED', 'USER', 'p007-member-a',
        'Member A', 'p007-member-remove', 'Membership removed after governance review',
        '{"caseReference":"CASE-007"}'::jsonb, 'request-p007-1'
      );
    `, 'insert immutable tenant-scoped security audit evidence');
    assertSqlFailure(databases.success, String.raw`
      UPDATE "SecurityAuditEvent" SET "reason" = 'rewritten' WHERE "id" = 'p007-audit-valid';
    `, /append-only/i, 'security audit update');
    assertSqlFailure(databases.success, String.raw`
      DELETE FROM "SecurityAuditEvent" WHERE "id" = 'p007-audit-valid';
    `, /append-only/i, 'security audit deletion');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "SecurityAuditEvent" (
        "id", "organisationId", "type", "actorKind", "actorUserId", "actorLabel",
        "subjectUserId", "reason"
      ) VALUES (
        'p007-audit-cross-tenant', 'p007-org-a', 'MEMBER_REMOVED', 'USER',
        'p007-owner-b', 'Owner B', 'p007-member-remove', 'Invalid cross-tenant actor'
      );
    `, /SecurityAuditEvent_actorUserId_organisationId_fkey|foreign key/i, 'cross-tenant audit actor');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "SecurityAuditEvent" (
        "id", "organisationId", "type", "actorKind", "actorUserId", "actorLabel",
        "subjectUserId", "reason"
      ) VALUES (
        'p007-audit-blank', 'p007-org-a', 'MEMBER_REMOVED', 'USER',
        'p007-member-a', 'Member A', 'p007-member-remove', '   '
      );
    `, /SecurityAuditEvent_evidence_check|check constraint/i, 'blank security audit evidence');
    assertSqlFailure(databases.success, String.raw`
      INSERT INTO "TeamInvite" (
        "id", "organisationId", "email", "role", "token", "invitedById", "expiresAt", "updatedAt"
      ) VALUES (
        'p007-owner-invite-runtime', 'p007-org-a', 'runtime-owner@example.test', 'OWNER',
        'p007-owner-invite-runtime-token', 'p007-member-a', TIMESTAMP '2099-01-01 00:00:00', CURRENT_TIMESTAMP
      );
    `, /TeamInvite_non_owner_role_check|check constraint/i, 'runtime OWNER invitation');

    stdout.write('P0-07 PostgreSQL upgrade fixture passed lifecycle, owner, session-family, tenant, and immutable-audit probes.\n');
  } finally {
    if (keepDatabases) {
      stdout.write(`Keeping disposable databases for inspection: ${allDatabases.join(', ')}\n`);
    } else {
      for (const database of [...allDatabases].reverse()) dropDatabase(database);
    }
  }
}

async function main() {
  try {
    await verifyTeamLifecycleUpgrade();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
