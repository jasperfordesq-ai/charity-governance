import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = join(scriptsDir, 'postgres-backup.mjs');

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
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env },
  });
}

test('postgres backup CLI fails safely without a database URL or local database container', () => {
  const result = runBackupCli(['backup', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL or --database-container is required/);
});

test('postgres backup CLI renders a local Docker database dump command without writing a dump in dry-run mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-backup-dry-run-'));

  try {
    const result = runBackupCli([
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

test('postgres backup CLI does not leave a final dump file when local Docker backup fails', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-failed-backup-'));

  try {
    const result = runBackupCli([
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

test('postgres backup CLI preserves an existing dump when overwrite backup fails', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-overwrite-backup-'));
  const dumpPath = join(tempDir, 'existing.dump');
  writeFileSync(dumpPath, 'existing dump');

  try {
    const result = runBackupCli([
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

test('postgres backup CLI renders a database URL dump command without exposing the URL in dry-run mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-dry-run-'));

  try {
    const result = runBackupCli([
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

test('postgres backup CLI supports host networking for database URL dumps in CI', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-url-backup-network-dry-run-'));

  try {
    const result = runBackupCli([
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

test('postgres backup CLI renders restore verification commands in dry-run mode', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-restore-dry-run-'));
  const dumpPath = join(tempDir, 'charitypilot-postgres.dump');
  writeFileSync(dumpPath, 'not-a-real-dump');

  try {
    const result = runBackupCli(['verify-restore', `--dump-file=${dumpPath}`, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /charitypilot-restore-verify-\d+-\d+-[a-f0-9]{8}/);
    assert.match(result.stdout, /pg_restore/);
    assert.match(result.stdout, /select count\(\*\) from information_schema\.tables/);
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
