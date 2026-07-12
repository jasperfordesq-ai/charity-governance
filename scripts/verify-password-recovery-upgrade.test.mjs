import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cleanupPasswordRecoveryUpgradeDatabases,
  discoverPasswordRecoveryUpgradeMigrations,
  verifyPasswordRecoveryUpgrade,
} from './verify-password-recovery-upgrade.mjs';

const migration = readFileSync(
  new URL(
    '../apps/api/prisma/migrations/20260712013000_add_password_recovery_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
).replace(/\r\n/gu, '\n');
const verifier = readFileSync(
  new URL('./verify-password-recovery-upgrade.mjs', import.meta.url),
  'utf8',
);
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release-images.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('P1-07A migration holds the historical writer locks and fails closed before atomic expansion', () => {
  assert.match(migration, /(?:^|\n)BEGIN;\n/u);
  assert.match(migration, /COMMIT;\s*$/u);

  const preflight = migration.indexOf('DO $preflight$');
  const firstTargetMutation = migration.indexOf('CREATE TYPE "PasswordRecoverySource"');
  assert.ok(preflight > 0);
  assert.ok(firstTargetMutation > preflight);
  for (const table of ['Organisation', 'User', 'AuthSession', 'SecurityAuditEvent']) {
    const lock = migration.indexOf(`LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE;`);
    assert.ok(lock >= 0, `${table} writer lock is missing`);
    assert.ok(lock < preflight, `${table} is not locked before preflight`);
  }
  assert.match(migration, /legacy_half_pairs=%/u);
  assert.match(migration, /malformed_token_hashes=%/u);
  assert.match(migration, /unsafe_future_expiries=%/u);
  assert.match(migration, /overlong_active_emails=%/u);
  assert.match(migration, /CHAR_LENGTH\(account\."email"\) > 254/u);
  assert.match(migration, /ERRCODE = '23514'/u);
});

test('P1-07A migration truthfully backfills usable legacy digests then retires every User slot', () => {
  assert.match(
    migration,
    /'LEGACY_USER_SLOT'::"PasswordRecoverySource"[\s\S]*'UNCERTAIN'::"PasswordRecoveryDeliveryState"/u,
  );
  assert.match(migration, /account\."resetToken"[\s\S]*account\."resetTokenExpiry"/u);
  assert.match(migration, /account\."resetTokenExpiry" > CURRENT_TIMESTAMP/u);
  assert.match(migration, /account\."lifecycleStatus" = 'ACTIVE'/u);
  assert.match(migration, /organisation\."lifecycleStatus" = 'ACTIVE'/u);
  assert.match(
    migration,
    /UPDATE "User"[\s\S]*"resetToken" = NULL[\s\S]*"resetTokenExpiry" = NULL[\s\S]*WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL/u,
  );
  const backfill = migration.slice(
    migration.indexOf('INSERT INTO "PasswordRecoveryRequest"'),
    migration.indexOf('-- The ledger row above is the sole roll-forward representation'),
  );
  assert.doesNotMatch(backfill, /recipientEmail/u);
  assert.match(migration, /User_guard_retired_password_recovery_slot/u);
  assert.match(migration, /Legacy User password recovery slots are retired/u);
});

test('P1-07A historical verifier discovers the exact P1-09 boundary and dry-run never invokes Docker', async () => {
  const plan = discoverPasswordRecoveryUpgradeMigrations();
  assert.equal(plan.target, '20260712013000_add_password_recovery_integrity');
  assert.equal(plan.previous.at(-1), '20260711230000_add_domain_invariants_referential_safety');
  assert.ok(plan.previous.includes('20260402114212_init'));
  assert.ok(!plan.previous.includes(plan.target));

  let commandCalls = 0;
  let output = '';
  await verifyPasswordRecoveryUpgrade({
    args: ['--dry-run'],
    commandRunner() {
      commandCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
    stdout: { write(value) { output += value; } },
  });

  assert.equal(commandCalls, 0);
  assert.match(output, /Prisma CLI: 6\.19\.3/u);
  assert.match(output, /PostgreSQL endpoint: 127\.0\.0\.1:5432 \(loopback-only\)/u);
  assert.match(output, /Pre-P1-07A migrations: 20/u);
  assert.match(output, /Previous migration: 20260711230000_add_domain_invariants_referential_safety/u);
  assert.match(output, /Target migration: 20260712013000_add_password_recovery_integrity/u);
  assert.match(output, /charitypilot_p107a_[0-9]+_[a-f0-9]{8}_invalid/u);
});

test('P1-07A built-image dry-run binds target migration commands to the selected artifact', async () => {
  let output = '';
  await verifyPasswordRecoveryUpgrade({
    args: ['--dry-run', '--migration-image=charitypilot-api-migrations-ci'],
    commandRunner() {
      throw new Error('dry-run must not execute the selected migration image');
    },
    stdout: { write(value) { output += value; } },
  });
  assert.match(output, /Target migration executor: charitypilot-api-migrations-ci/u);
  assert.match(
    verifier,
    /'run', '--rm',[\s\S]*'--mount',[\s\S]*target=\/p107a-proof,readonly[\s\S]*'--network', 'host', '--env', 'DATABASE_URL',[\s\S]*migrationImage,[\s\S]*\.\.\.prismaArgs/u,
  );
  assert.match(
    verifier,
    /targetSchemaPath = migrationImage[\s\S]*\? '\/p107a-proof\/prisma\/schema\.prisma'[\s\S]*: targetMigrationWorkspace\.schemaPath/u,
  );
  assert.match(verifier, /createTargetMigrationWorkspace\(plan, migrationsRoot\)/u);
  assert.match(verifier, /selectedMigrationChecksums\[migrationName\] !== checkoutMigrationChecksums\[migrationName\]/u);
  assert.match(verifier, /P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT/u);
  assert.match(verifier, /Built-image recovery command exits: failed deploy=/u);
});

test('P1-07A verifier binds the complete historical, recovery, catalog, and evidence proof set', () => {
  for (const proof of [
    'VALID_LEGACY_SEED_SQL',
    'INVALID_LEGACY_SEED_SQL',
    'FAILED_MIGRATION_ATOMICITY_SQL',
    'FAILED_PRISMA_HISTORY_ASSERTIONS_SQL',
    'REMEDIATE_DISPOSABLE_INVALID_FIXTURE_SQL',
    'ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL',
    'RECOVERED_PRISMA_HISTORY_ASSERTIONS_SQL',
    'INSTALLED_CATALOG_ASSERTIONS_SQL',
    'P1-07A exact table column/type/nullability/precision catalog differs',
    'P1-07A exact table default catalog differs',
    'P1-07A exact enum label/order catalog differs',
    'P1-07A trigger relation/event/timing/function catalog differs',
    'VALID_BACKFILL_ASSERTIONS_SQL',
    "['migrate', 'deploy', '--schema', previousMigrationWorkspace.schemaPath]",
    "['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath]",
    "['migrate', 'status', '--schema', targetSchemaPath]",
    'half_pair_count <> 1',
    'malformed_hash_count <> 1',
    'unsafe_future_expiry_count <> 1',
    'overlong_active_email_count <> 1',
    "'p107a-overlong-email', REPEAT('e', 242) || '@example.test'",
    "'p107a-remediated-email@example.test'",
    'Plain Prisma retry did not fail with target-bound P3009',
    'P1-07A changed logical Organisation/User fixture data outside documented reset cleanup/backfill',
    'Valid legacy reset digest was not backfilled exactly into consumable UNCERTAIN evidence',
    'P1-07A migration persisted the recoverable raw legacy token',
    'Expired legacy pair was not cleared together or invented recovery evidence',
    'PasswordRecoveryRequest_outstanding_limit',
    'Illegal password recovery delivery-state transition',
    'Password recovery identity and recipient evidence are immutable',
    'Auth security email identity and recipient evidence are immutable',
    'reject a security notice backed only by compatible-looking audit JSON',
    'Terminal password recovery delivery evidence is immutable',
    'Terminal auth security email delivery evidence is immutable',
    'reject a p109-shaped write to the retired User recovery slot',
    'reject direct active-to-active recovery fingerprint replacement',
    'reject authentication recovery control deletion',
    'Out-of-band password change did not invalidate every recovery path',
    'prove a long-running out-of-band password change uses post-lock invalidation time',
    'execute exact production P1-07A recovery preflight',
    'buildP107ARecoveryPreflightSql',
  ]) {
    assert.ok(verifier.includes(proof), `verifier is missing proof contract: ${proof}`);
  }

  const p3009 = verifier.indexOf('Plain Prisma retry did not fail with target-bound P3009');
  const remediation = verifier.indexOf(
    'deliberately remediate only the disposable malformed P1-07A fixture',
  );
  const resolve = verifier.indexOf(
    "['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath]",
  );
  const productionPreflight = verifier.indexOf(
    'executeProductionRecoveryPreflight(databases.invalid)',
  );
  const redeploy = verifier.indexOf(
    'redeploy P1-07A after deliberate fixture remediation and exact resolution',
  );
  const status = verifier.indexOf('verify recovered P1-07A Prisma migration status');
  assert.ok(p3009 >= 0 && p3009 < remediation);
  assert.ok(remediation < productionPreflight);
  assert.ok(productionPreflight < resolve);
  assert.ok(resolve < redeploy);
  assert.ok(redeploy < status);

  assert.match(verifier, /DATABASE_URL: disposableDatabaseUrl/u);
  assert.doesNotMatch(verifier, /env\.DATABASE_URL/u);
  assert.match(verifier, /randomBytes\(4\)\.toString\('hex'\)/u);
  assert.match(verifier, /dropdb', '--if-exists', '--force'/u);
  assert.match(verifier, /proof workspace did not stop at its exact target migration/u);
});

test('CI and release prove the real P1-07A upgrade before ordinary migration execution/publication', () => {
  const ciP109 = ciWorkflow.indexOf('name: Verify P1-09 domain invariants upgrade from legacy PostgreSQL data');
  const ciP107a = ciWorkflow.indexOf('name: Verify P1-07A password recovery upgrade from legacy PostgreSQL data');
  const ciDeploy = ciWorkflow.indexOf('name: Deploy Prisma migrations');
  assert.ok(ciP109 >= 0 && ciP109 < ciP107a);
  assert.ok(ciP107a < ciDeploy);
  assert.match(ciWorkflow.slice(ciP107a, ciDeploy), /npm run db:verify:p107a-upgrade/u);

  const releaseP109 = releaseWorkflow.indexOf(
    'name: Verify P1-09 domain invariants upgrade from legacy PostgreSQL data',
  );
  const releaseP107a = releaseWorkflow.indexOf(
    'name: Verify P1-07A password recovery upgrade from legacy PostgreSQL data',
  );
  const migrationRun = releaseWorkflow.indexOf('name: Run migration runner against CI PostgreSQL');
  const imagePush = releaseWorkflow.indexOf('name: Push image tags');
  const imageBuild = releaseWorkflow.indexOf('name: Build migration runner image');
  const builtArtifactProof = releaseWorkflow.indexOf(
    'name: Verify P1-07A recovery commands through built migration image',
  );
  assert.ok(releaseP109 >= 0 && releaseP109 < releaseP107a);
  assert.ok(releaseP107a < migrationRun);
  assert.ok(releaseP107a < imagePush);
  assert.ok(imageBuild >= 0 && imageBuild < builtArtifactProof);
  assert.ok(builtArtifactProof < migrationRun);
  assert.ok(builtArtifactProof < imagePush);
  assert.match(
    releaseWorkflow.slice(releaseP107a, migrationRun),
    /npm run db:verify:p107a-upgrade/u,
  );
  assert.match(
    releaseWorkflow.slice(builtArtifactProof, migrationRun),
    /npm run db:verify:p107a-upgrade -- --migration-image=charitypilot-api-migrations-ci/u,
  );
  assert.match(
    releaseWorkflow.slice(builtArtifactProof, migrationRun),
    /CHARITYPILOT_P107A_UPGRADE_COMMAND_TIMEOUT_MS: '300000'/u,
  );
  assert.match(
    releaseWorkflow.slice(builtArtifactProof, migrationRun),
    /CHARITYPILOT_P107A_UPGRADE_CLEANUP_TIMEOUT_MS: '60000'/u,
  );

  assert.equal(
    packageJson.scripts['db:verify:p107a-upgrade'],
    'node scripts/verify-password-recovery-upgrade.mjs',
  );
  assert.match(
    packageJson.scripts['test:production-check'],
    /scripts\/verify-password-recovery-upgrade\.test\.mjs/u,
  );
});

test('P1-07A verifier rejects unknown options and unsafe database configuration before Docker', async () => {
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({ args: ['--production'] }),
    /Unknown option: --production/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run', '--migration-image=Unsafe/Image'],
    }),
    /must be a safe lowercase Docker image reference/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run', '--migration-image=image-a', '--migration-image=image-b'],
    }),
    /Duplicate --migration-image option/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P107A_UPGRADE_DB_PREFIX: 'unsafe-prefix' },
    }),
    /must be a short lowercase PostgreSQL identifier/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P107A_UPGRADE_COMMAND_TIMEOUT_MS: 'forever' },
    }),
    /must be an integer from 10000 to 600000/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P107A_UPGRADE_CLEANUP_TIMEOUT_MS: '0' },
    }),
    /must be an integer from 5000 to 60000/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_CI_POSTGRES_HOST: 'production-db.example.com' },
    }),
    /must be loopback-only/u,
  );
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_CI_POSTGRES_PORT: '70000' },
    }),
    /must be an integer from 1 to 65535/u,
  );
});

test('P1-07A cleanup polls after a timed-out drop and uses a second forced-drop pass', async () => {
  let dropCalls = 0;
  let residueQueries = 0;
  await cleanupPasswordRecoveryUpgradeDatabases({
    databases: ['charitypilot_p107a_cleanup_base', 'charitypilot_p107a_cleanup_invalid'],
    dockerBin: 'docker',
    container: 'charitypilot-ci-postgres',
    user: 'charitypilot',
    adminDatabase: 'postgres',
    timeoutMs: 5_000,
    pollAttempts: 1,
    sleep: async () => {},
    commandRunner: (_command, args, options) => {
      assert.equal(options.timeoutMs, 5_000);
      if (args.includes('dropdb')) {
        dropCalls += 1;
        if (dropCalls === 1) return { status: null, error: new Error('simulated timeout') };
        return { status: 0, stdout: '', stderr: '' };
      }
      residueQueries += 1;
      return {
        status: 0,
        stdout: residueQueries === 1 ? 'charitypilot_p107a_cleanup_base\n' : '',
        stderr: '',
      };
    },
  });
  assert.equal(dropCalls, 4);
  assert.equal(residueQueries, 2);
});

test('P1-07A cleanup fails with exact residue after both bounded forced-drop passes', async () => {
  await assert.rejects(
    cleanupPasswordRecoveryUpgradeDatabases({
      databases: ['charitypilot_p107a_cleanup_residue'],
      dockerBin: 'docker',
      container: 'charitypilot-ci-postgres',
      user: 'charitypilot',
      adminDatabase: 'postgres',
      timeoutMs: 5_000,
      pollAttempts: 1,
      sleep: async () => {},
      commandRunner: (_command, args) => args.includes('dropdb')
        ? { status: null, error: new Error('simulated timeout') }
        : { status: 0, stdout: 'charitypilot_p107a_cleanup_residue\n', stderr: '' },
    }),
    /cleanup left residue: charitypilot_p107a_cleanup_residue/u,
  );
});

test('P1-07A verifier preserves the original verification failure when cleanup also fails', async () => {
  let cleanupCalls = 0;
  await assert.rejects(
    verifyPasswordRecoveryUpgrade({
      args: [],
      env: { CHARITYPILOT_P107A_UPGRADE_DB_PREFIX: 'charitypilot_p107a_failure_test' },
      stdout: { write: () => {} },
      cleanupDatabases: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 2) throw new Error('simulated cleanup residue');
      },
      commandRunner: (_command, args) => args.includes('createdb')
        ? { status: 23, stdout: '', stderr: 'simulated verification failure' }
        : { status: 0, stdout: '', stderr: '' },
    }),
    (error) => {
      assert.match(error.message, /create disposable database .* failed with exit code 23/u);
      assert.match(error.message, /simulated verification failure/u);
      assert.match(error.message, /Additionally, P1-07A disposable cleanup failed: simulated cleanup residue/u);
      assert.match(error.cause?.message ?? '', /create disposable database/u);
      return true;
    },
  );
  assert.equal(cleanupCalls, 2);
});
