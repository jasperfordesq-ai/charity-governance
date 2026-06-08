import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPostgresBackupFromArgs } from './postgres-backup.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function cleanEnv() {
  const env = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

function runBackupCli(args, env = {}) {
  return runPostgresBackupFromArgs(args, { ...cleanEnv(), ...env });
}

test('postgres backup CLI fails safely without a database URL or local database container', async () => {
  const result = await runBackupCli(['backup', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL or --database-container is required/);
});

test('postgres backup CLI renders a local Docker database dump command without writing a dump in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-backup-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-db',
      `--output-dir=${tempDir}`,
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker exec charitypilot-db pg_dump/);
    assert.match(result.stdout, /--format=custom/);
    assert.deepEqual(readdirSync(tempDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI does not leave a final dump file when local Docker backup fails', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-failed-backup-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-missing-db',
      `--output-dir=${tempDir}`,
      '--output-file=failed.dump',
    ]);

    assert.equal(result.status, 1);
    assert.equal(existsSync(join(tempDir, 'failed.dump')), false);
    assert.deepEqual(readdirSync(tempDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI preserves an existing dump when overwrite backup fails', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-overwrite-backup-'));
  const dumpPath = join(tempDir, 'existing.dump');
  writeFileSync(dumpPath, 'existing dump');

  try {
    const result = await runBackupCli([
      'backup',
      '--database-container=charitypilot-missing-db',
      `--output-dir=${tempDir}`,
      '--output-file=existing.dump',
      '--overwrite',
    ]);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Backup file already exists|EEXIST/);
    assert.equal(readFileSync(dumpPath, 'utf8'), 'existing dump');
    assert.deepEqual(readdirSync(tempDir), ['existing.dump']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders a database URL dump command without exposing the URL in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
      `--output-dir=${tempDir}`,
      '--output-file=remote.dump',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker run --rm/);
    assert.match(result.stdout, /CHARITYPILOT_BACKUP_DATABASE_URL/);
    assert.match(result.stdout, /pg_dump --dbname/);
    assert.doesNotMatch(result.stdout, /backup-user:secret/);
    assert.equal(existsSync(join(tempDir, 'remote.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI supports host networking for database URL dumps in CI', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-network-dry-run-'));

  try {
    const result = await runBackupCli([
      'backup',
      '--database-url=postgresql://backup-user:secret@localhost:5432/charitypilot_ci',
      '--docker-network=host',
      `--output-dir=${tempDir}`,
      '--output-file=remote.dump',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docker run --rm --network host/);
    assert.match(result.stdout, /CHARITYPILOT_BACKUP_DATABASE_URL/);
    assert.doesNotMatch(result.stdout, /backup-user:secret/);
    assert.equal(existsSync(join(tempDir, 'remote.dump')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders operational restore sentinel seeding without exposing the database URL', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@localhost:5432/charitypilot_ci',
    '--docker-network=host',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docker run --rm --network host/);
  assert.match(result.stdout, /CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-org/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-user/);
  assert.match(result.stdout, /charitypilot-restore-sentinel-document/);
  assert.match(result.stdout, /"ComplianceRecord"/);
  assert.match(result.stdout, /ON CONFLICT/);
  assert.doesNotMatch(result.stdout, /backup-user:secret/);
});

test('postgres backup CLI refuses remote operational sentinel seeding unless explicitly allowed', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    '--dry-run',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to seed restore sentinel into a non-local database URL/);
  assert.doesNotMatch(result.stdout, /INSERT INTO "Organisation"/);
  assert.doesNotMatch(result.stderr, /backup-user:secret/);
});

test('postgres backup CLI can render remote sentinel seeding only with explicit opt-in', async () => {
  const result = await runBackupCli([
    'seed-restore-sentinel',
    '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    '--allow-remote-sentinel',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /INSERT INTO "Organisation"/);
  assert.match(result.stdout, /docker run --rm/);
  assert.doesNotMatch(result.stdout, /backup-user:secret/);
});

test('postgres backup CLI renders restore verification commands in dry-run mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-restore-dry-run-'));
  const dumpPath = join(tempDir, 'charitypilot-postgres.dump');
  writeFileSync(dumpPath, 'not-a-real-dump');

  try {
    const result = await runBackupCli(['verify-restore', `--dump-file=${dumpPath}`, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /charitypilot-restore-verify-\d+-\d+-[a-f0-9]{8}/);
    assert.match(result.stdout, /pg_isready -h 127\.0\.0\.1/);
    assert.match(result.stdout, /pg_restore/);
    assert.match(
      result.stdout,
      /postgresql:\/\/charitypilot:charitypilot_restore@127\.0\.0\.1:5432\/charitypilot_restore/,
    );
    assert.match(result.stdout, /select table_name from information_schema\.tables/);
    assert.match(result.stdout, /'_prisma_migrations'/);
    assert.match(result.stdout, /'Organisation'/);
    assert.match(result.stdout, /'User'/);
    assert.match(result.stdout, /'Document'/);
    assert.match(result.stdout, /'DocumentStorageDeletion'/);
    assert.match(result.stdout, /'StripeWebhookEvent'/);
    assert.match(result.stdout, /from \\"GovernancePrinciple\\"/);
    assert.match(result.stdout, /from \\"GovernanceStandard\\"/);
    assert.match(result.stdout, /core_standards/);
    assert.match(result.stdout, /additional_standards/);
    assert.match(result.stdout, /principle_signature/);
    assert.match(result.stdout, /standard_signature/);
    assert.match(result.stdout, /md5\(string_agg/);
    assert.match(result.stdout, /\\"title\\"/);
    assert.match(result.stdout, /\\"sortOrder\\"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres backup CLI renders operational sentinel verification in dry-run mode when requested', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-restore-sentinel-dry-run-'));
  const dumpPath = join(tempDir, 'charitypilot-postgres.dump');
  writeFileSync(dumpPath, 'not-a-real-dump');

  try {
    const result = await runBackupCli([
      'verify-restore',
      `--dump-file=${dumpPath}`,
      '--expect-operational-sentinel',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /from \\"Organisation\\"/);
    assert.match(result.stdout, /from \\"User\\"/);
    assert.match(result.stdout, /from \\"Document\\"/);
    assert.match(result.stdout, /from \\"ComplianceRecord\\"/);
    assert.match(result.stdout, /from \\"DocumentStorageDeletion\\"/);
    assert.match(result.stdout, /from \\"StripeWebhookEvent\\"/);
    assert.match(result.stdout, /charitypilot-restore-sentinel-org/);
    assert.match(result.stdout, /operational_signature/);
    assert.match(result.stdout, /md5\(concat_ws/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('package scripts expose database backup and restore verification commands', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['db:backup'], 'node scripts/postgres-backup.mjs backup');
  assert.equal(packageJson.scripts['db:restore:verify'], 'node scripts/postgres-backup.mjs verify-restore');
  assert.match(packageJson.scripts['test:production-check'], /scripts\/postgres-backup\.test\.mjs/);
});
