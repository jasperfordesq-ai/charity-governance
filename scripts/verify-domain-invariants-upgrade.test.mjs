import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cleanupDomainInvariantDatabases,
  discoverDomainInvariantUpgradeMigrations,
  verifyDomainInvariantUpgrade,
} from './verify-domain-invariants-upgrade.mjs';

const migration = readFileSync(
  new URL(
    '../apps/api/prisma/migrations/20260711230000_add_domain_invariants_referential_safety/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(
  new URL('../apps/api/prisma/schema.prisma', import.meta.url),
  'utf8',
);
const verifier = readFileSync(
  new URL('./verify-domain-invariants-upgrade.mjs', import.meta.url),
  'utf8',
);
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release-images.yml', import.meta.url),
  'utf8',
);

const CHECK_CONSTRAINTS = [
  'BoardMember_term_chronology_check',
  'BoardMember_conduct_signed_date_equivalence_check',
  'BoardMember_induction_date_equivalence_check',
  'FundraisingRecord_date_chronology_check',
  'AnnualReportReadiness_filed_date_required_check',
];

test('P1-09 migration is atomic, locks every writer table before preflight, and never rewrites data', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);

  const preflight = migration.indexOf('DO $preflight$');
  const firstMutation = migration.indexOf('ALTER TABLE');
  const lockTimeout = migration.indexOf("SET LOCAL lock_timeout = '15s';");
  assert.ok(preflight > 0);
  assert.ok(firstMutation > preflight);
  assert.ok(
    lockTimeout > 0 && lockTimeout < migration.indexOf('LOCK TABLE'),
    'lock timeout must fail closed before table locking',
  );
  for (const table of [
    'ConflictRecord',
    'BoardMember',
    'FundraisingRecord',
    'AnnualReportReadiness',
  ]) {
    const lock = migration.indexOf(`LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE;`);
    assert.ok(lock >= 0, `${table} writer lock is missing`);
    assert.ok(lock < preflight, `${table} is not locked before the preflight`);
  }
  assert.ok(
    migration.indexOf('LOCK TABLE "ConflictRecord" IN SHARE ROW EXCLUSIVE MODE;') <
      migration.indexOf('LOCK TABLE "BoardMember" IN SHARE ROW EXCLUSIVE MODE;'),
    'migration must lock ConflictRecord before BoardMember to match the application delete write order',
  );

  assert.doesNotMatch(migration, /^\s*(?:INSERT|UPDATE|DELETE)\b/im);
  assert.match(migration, /No legacy row was changed and the migration was rolled back atomically/);
});

test('P1-09 preflight counts every contradiction and fails closed with actionable totals', () => {
  for (const count of [
    'board_chronology',
    'conduct_evidence',
    'induction_evidence',
    'fundraising_chronology',
    'filing_evidence',
    'conflict_scope',
  ]) {
    assert.match(migration, new RegExp(`${count}=%s`));
  }
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /Keep every runtime stopped/);
  assert.match(migration, /prove this transaction left no target objects/);
  assert.match(migration, /resolve this exact migration as rolled back/);
  assert.doesNotMatch(migration, /correct[^.]+then rerun the migration/i);
  assert.match(migration, /LEFT JOIN "BoardMember" AS member[\s\S]*IS DISTINCT FROM conflict\."organisationId"/);
});

test('P1-09 installs exactly the five named domain CHECK backstops with intended optional-date edges', () => {
  for (const constraint of CHECK_CONSTRAINTS) {
    assert.equal(
      migration.split(`ADD CONSTRAINT "${constraint}"`).length - 1,
      1,
      `${constraint} must be installed exactly once`,
    );
  }
  assert.match(migration, /"termEndDate" IS NULL OR "termEndDate" >= "appointedDate"/);
  assert.match(migration, /"conductSigned" = \("conductSignedDate" IS NOT NULL\)/);
  assert.match(migration, /"inductionCompleted" = \("inductionDate" IS NOT NULL\)/);
  assert.match(
    migration,
    /"endDate" IS NULL\s+OR "startDate" IS NULL\s+OR "endDate" >= "startDate"/,
  );
  assert.match(
    migration,
    /"filingStatus" <> 'FILED'::"AnnualReportFilingStatus"\s+OR "filedDate" IS NOT NULL/,
  );
});

test('P1-09 tenant-scopes conflict pointers and preserves history through explicit detach', () => {
  assert.match(schema, /@@unique\(\[id, organisationId\]\)/);
  assert.match(
    schema,
    /BoardMember\?\s+@relation\(fields: \[boardMemberId, organisationId\], references: \[id, organisationId\], onDelete: Restrict, onUpdate: Restrict\)/,
  );
  assert.match(schema, /@@index\(\[boardMemberId, organisationId\]\)/);
  assert.match(migration, /BoardMember_id_organisationId_key/);
  assert.match(migration, /ConflictRecord_boardMemberId_organisationId_fkey/);
  assert.match(
    migration,
    /FOREIGN KEY \("boardMemberId", "organisationId"\)[\s\S]*ON DELETE RESTRICT\s+ON UPDATE RESTRICT/,
  );
  assert.doesNotMatch(migration, /ON DELETE CASCADE/);
});

test('P1-09 disposable PostgreSQL verifier binds the historical boundary and complete proof set', async () => {
  const plan = discoverDomainInvariantUpgradeMigrations();
  assert.equal(plan.previous.at(-1), '20260711213000_add_document_storage_deletion_retry_lifecycle');
  assert.equal(plan.target, '20260711230000_add_domain_invariants_referential_safety');

  for (const proof of [
    'FAILED_PRISMA_HISTORY_ASSERTIONS_SQL',
    'ROLLED_BACK_PRISMA_HISTORY_ASSERTIONS_SQL',
    'RECOVERED_PRISMA_HISTORY_AND_DATA_ASSERTIONS_SQL',
    'REMEDIATED_BLOCKER_ASSERTIONS_SQL',
    'P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT',
    'P109_RECOVERY_MIGRATIONS',
    'buildP109RecoveryPreflightSql',
    'parseP109MigrationChecksumOutput',
    'execute the exact read-only production P1-09 recovery preflight before resolution',
    "['migrate', 'deploy', '--schema', previousMigrationWorkspace.schemaPath]",
    "['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath]",
    'Plain Prisma rerun did not fail with target-bound P3009',
    'deliberately remediate only the disposable P1-09 fixture',
    'board term before appointment',
    'conduct true without signed date',
    'induction true without completed date',
    'fundraising end before start',
    'FILED report without filed date',
    'cross-tenant ConflictRecord board pointer',
    'linked board-member deletion',
    'explicit detach preserves conflict history',
  ]) {
    assert.ok(verifier.includes(proof), `verifier is missing proof contract: ${proof}`);
  }
  const p3009Proof = verifier.indexOf('Plain Prisma rerun did not fail with target-bound P3009');
  const remediation = verifier.indexOf(
    'deliberately remediate only the disposable P1-09 fixture while the failed history remains unresolved',
  );
  const rolledBackResolution = verifier.indexOf(
    "['migrate', 'resolve', '--rolled-back', plan.target, '--schema', targetSchemaPath]",
  );
  const productionWrapperPreflight = verifier.indexOf(
    'executeProductionRecoveryPreflight(databases.invalid)',
  );
  const checksumTamper = verifier.indexOf(
    "'tamper only the disposable failed-target checksum for negative image proof'",
  );
  const checksumRejection = verifier.indexOf(
    "'require checksum-bound production preflight to reject tampered history'",
  );
  const checksumRestore = verifier.indexOf(
    "'restore the exact selected-image checksum after negative proof'",
  );
  assert.ok(p3009Proof >= 0 && p3009Proof < remediation);
  assert.ok(remediation < checksumTamper);
  assert.ok(checksumTamper < checksumRejection);
  assert.ok(checksumRejection < checksumRestore);
  assert.ok(checksumRestore < productionWrapperPreflight);
  assert.ok(productionWrapperPreflight < rolledBackResolution);

  let output = '';
  await verifyDomainInvariantUpgrade({
    args: ['--dry-run'],
    commandRunner: () => {
      throw new Error('dry-run must not execute Docker');
    },
    stdout: { write: (chunk) => { output += chunk; } },
  });
  assert.match(output, /Prisma CLI: 6\.19\.3/);
  assert.match(output, /PostgreSQL endpoint: 127\.0\.0\.1:5432 \(loopback-only\)/);
  assert.match(output, /Target migration: 20260711230000_add_domain_invariants_referential_safety/);
  assert.match(output, /charitypilot_p109_[0-9]+_[a-f0-9]{8}_invalid/);
  assert.match(verifier, /DATABASE_URL: disposableDatabaseUrl/);
  assert.doesNotMatch(verifier, /env\.DATABASE_URL/);
  assert.match(verifier, /COALESCE\(LENGTH\(logs\), 0\) = 0/);
  assert.match(
    verifier,
    /Exact production P1-09 recovery wrapper preflight passed live, preserved the complete logical state fingerprint/,
  );
  assert.match(verifier, /stateAfterProductionPreflight !== stateBeforeProductionPreflight/);
});

test('P1-09 built-image mode uses exact recovery command shapes before release publication', async () => {
  let output = '';
  await verifyDomainInvariantUpgrade({
    args: ['--dry-run', '--migration-image=charitypilot-api-migrations-ci'],
    commandRunner: () => {
      throw new Error('dry-run must not execute the migration image');
    },
    stdout: { write: (chunk) => { output += chunk; } },
  });
  assert.match(output, /Target migration executor: charitypilot-api-migrations-ci/);
  assert.match(
    verifier,
    /'run', '--rm',[\s\S]*options\.input === undefined \? \[\] : \['--interactive'\][\s\S]*'--network', 'host', '--env', 'DATABASE_URL',[\s\S]*migrationImage,[\s\S]*\.\.\.prismaArgs/,
  );
  assert.match(
    verifier,
    /\['db', 'execute', '--stdin', '--schema', 'prisma\/schema\.prisma'\]/,
  );
  assert.match(
    verifier,
    /\['migrate', 'resolve', '--rolled-back', plan\.target, '--schema', targetSchemaPath\]/,
  );
  assert.match(verifier, /targetSchemaPath = migrationImage \? 'prisma\/schema\.prisma' : schemaPath/);
  assert.match(verifier, /\{ input: recoveryPreflightSql \}/);
  assert.match(
    verifier,
    /'run', '--rm', '--network', 'none', '--entrypoint', 'node',[\s\S]*P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT/,
  );
  assert.match(verifier, /parseP109MigrationChecksumOutput\(result\.stdout\)/);
  assert.match(verifier, /buildP109RecoveryPreflightSql\(selectedMigrationChecksums\)/);
  assert.match(verifier, /tamper only the disposable failed-target checksum for negative image proof/);
  assert.match(verifier, /require checksum-bound production preflight to reject tampered history/);
  assert.match(verifier, /restore the exact selected-image checksum after negative proof/);
  assert.match(
    verifier,
    /Built migration image rejected a tampered failed-target checksum and restored the exact selected-image binding/,
  );
  assert.match(
    verifier,
    /Built-image command exits: failed deploy=\$\{failedMigration\.status\}[\s\S]*tampered db execute=\$\{tamperedChecksumPreflightStatus\}[\s\S]*resolve=\$\{resolveResult\.status\}/,
  );

  const smokeName = 'name: Verify P1-09 recovery commands through built migration image';
  assert.match(releaseWorkflow, new RegExp(smokeName));
  assert.match(
    releaseWorkflow,
    /npm run db:verify:p109-upgrade -- --migration-image=charitypilot-api-migrations-ci/,
  );
  assert.match(releaseWorkflow, /CHARITYPILOT_P109_UPGRADE_COMMAND_TIMEOUT_MS: '300000'/);
  assert.match(releaseWorkflow, /CHARITYPILOT_P109_UPGRADE_CLEANUP_TIMEOUT_MS: '60000'/);
  assert.ok(releaseWorkflow.indexOf('name: Build migration runner image') < releaseWorkflow.indexOf(smokeName));
  assert.ok(releaseWorkflow.indexOf(smokeName) < releaseWorkflow.indexOf('name: Push image tags'));
});

test('P1-09 verifier rejects unknown options and unsafe database prefixes before Docker', async () => {
  await assert.rejects(
    verifyDomainInvariantUpgrade({ args: ['--production'] }),
    /Unknown option: --production/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({ args: ['--dry-run', '--migration-image=Unsafe/Image'] }),
    /must be a safe lowercase Docker image reference/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run', '--migration-image=image-a', '--migration-image=image-b'],
    }),
    /Duplicate --migration-image option/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P109_UPGRADE_DB_PREFIX: 'unsafe-prefix' },
    }),
    /must be a short lowercase PostgreSQL identifier/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P109_UPGRADE_COMMAND_TIMEOUT_MS: 'forever' },
    }),
    /must be an integer from 10000 to 600000/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_CI_POSTGRES_HOST: 'production-db.example.com' },
    }),
    /must be loopback-only/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_CI_POSTGRES_PORT: '70000' },
    }),
    /must be an integer from 1 to 65535/,
  );
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: ['--dry-run'],
      env: { CHARITYPILOT_P109_UPGRADE_CLEANUP_TIMEOUT_MS: '0' },
    }),
    /must be an integer from 5000 to 60000/,
  );
});

test('P1-09 cleanup polls after a timed-out drop and uses a second forced-drop pass', async () => {
  let dropCalls = 0;
  let residueQueries = 0;
  await cleanupDomainInvariantDatabases({
    databases: ['charitypilot_p109_cleanup_base', 'charitypilot_p109_cleanup_invalid'],
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
        stdout: residueQueries === 1 ? 'charitypilot_p109_cleanup_base\n' : '',
        stderr: '',
      };
    },
  });
  assert.equal(dropCalls, 4);
  assert.equal(residueQueries, 2);
});

test('P1-09 cleanup fails with exact residue after both bounded forced-drop passes', async () => {
  await assert.rejects(
    cleanupDomainInvariantDatabases({
      databases: ['charitypilot_p109_cleanup_residue'],
      dockerBin: 'docker',
      container: 'charitypilot-ci-postgres',
      user: 'charitypilot',
      adminDatabase: 'postgres',
      timeoutMs: 5_000,
      pollAttempts: 1,
      sleep: async () => {},
      commandRunner: (_command, args) => args.includes('dropdb')
        ? { status: null, error: new Error('simulated timeout') }
        : { status: 0, stdout: 'charitypilot_p109_cleanup_residue\n', stderr: '' },
    }),
    /cleanup left residue: charitypilot_p109_cleanup_residue/,
  );
});

test('P1-09 verifier preserves the original verification failure when cleanup also fails', async () => {
  let cleanupCalls = 0;
  await assert.rejects(
    verifyDomainInvariantUpgrade({
      args: [],
      env: { CHARITYPILOT_P109_UPGRADE_DB_PREFIX: 'charitypilot_p109_failure_test' },
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
      assert.match(error.message, /create disposable database .* failed with exit code 23/);
      assert.match(error.message, /simulated verification failure/);
      assert.match(error.message, /Additionally, P1-09 disposable cleanup failed: simulated cleanup residue/);
      assert.match(error.cause?.message ?? '', /create disposable database/);
      return true;
    },
  );
  assert.equal(cleanupCalls, 2);
});
