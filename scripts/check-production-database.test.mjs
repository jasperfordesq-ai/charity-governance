import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const databaseScriptPath = join(scriptsDir, 'check-production-database.mjs');

async function loadDatabaseRunner() {
  assert.ok(existsSync(databaseScriptPath), 'production database checker script must exist');
  const module = await import(pathToFileURL(databaseScriptPath).href);
  assert.equal(typeof module.runProductionDatabaseCheckFromArgs, 'function');
  return module.runProductionDatabaseCheckFromArgs;
}

function productionEnv(overrides = {}) {
  const values = {
    DATABASE_URL: 'postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
    ...overrides,
  };

  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function writeEnvFile(content) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-production-database-'));
  const envPath = join(tempDir, 'production.env');
  writeFileSync(envPath, content);
  return { tempDir, envPath };
}

test('production database checker backs up, verifies restore, and removes the temporary dump', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const calls = [];

  try {
    const result = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        makeTempDir: () => join(tempDir, 'database-check'),
        runPostgresBackupFromArgs: async (args, env) => {
          calls.push({ args, env });
          if (args[0] === 'backup') {
            writeFileSync(join(tempDir, 'database-check', 'production-check.dump'), 'backup dump');
            return { status: 0, stdout: 'backup completed\n', stderr: '' };
          }
          if (args[0] === 'verify-restore') {
            assert.ok(existsSync(args.find((arg) => arg.startsWith('--dump-file=')).slice('--dump-file='.length)));
            return { status: 0, stdout: 'restore verification passed\n', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: 'unexpected command\n' };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production database check passed/);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
      'backup',
      '--database-url=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require',
      `--output-dir=${join(tempDir, 'database-check')}`,
      '--output-file=production-check.dump',
      '--overwrite',
    ]);
    assert.deepEqual(calls[1].args, [
      'verify-restore',
      `--dump-file=${join(tempDir, 'database-check', 'production-check.dump')}`,
    ]);
    assert.equal(calls[0].env.DATABASE_URL, undefined);
    assert.doesNotMatch(result.stdout, /backup-user:secret|DATABASE_URL/);
    assert.equal(existsSync(join(tempDir, 'database-check')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production database checker can require an operational restore sentinel', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const verifyArgs = [];

  try {
    const result = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath, '--expect-operational-sentinel'],
      {
        makeTempDir: () => join(tempDir, 'database-check'),
        runPostgresBackupFromArgs: async (args) => {
          if (args[0] === 'backup') {
            writeFileSync(join(tempDir, 'database-check', 'production-check.dump'), 'backup dump');
          }
          if (args[0] === 'verify-restore') {
            verifyArgs.push(...args);
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(verifyArgs.includes('--expect-operational-sentinel'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production database checker rejects missing, local, and non-TLS database URLs before backup', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv({
    DATABASE_URL: 'postgresql://user:secret@localhost:5432/charitypilot',
  }));
  let called = false;

  try {
    const result = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        runPostgresBackupFromArgs: async () => {
          called = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(called, false);
    assert.match(result.stderr, /DATABASE_URL must not point at localhost/);
    assert.match(result.stderr, /DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full/);
    assert.doesNotMatch(result.stderr, /user:secret/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production database checker propagates backup and restore failures without leaking credentials', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const backupResult = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        makeTempDir: () => join(tempDir, 'backup-failure'),
        runPostgresBackupFromArgs: async () => ({
          status: 1,
          stdout: 'pg_dump failed\n',
          stderr: 'connection failed for postgresql://backup-user:secret@db.charitypilot.ie\n',
        }),
      },
    );

    assert.equal(backupResult.status, 1);
    assert.match(backupResult.stderr, /database backup failed/);
    assert.doesNotMatch(backupResult.stderr, /backup-user:secret|postgresql:\/\//);

    const restoreResult = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        makeTempDir: () => join(tempDir, 'restore-failure'),
        runPostgresBackupFromArgs: async (args) => {
          if (args[0] === 'backup') {
            writeFileSync(join(tempDir, 'restore-failure', 'production-check.dump'), 'backup dump');
            return { status: 0, stdout: '', stderr: '' };
          }
          return {
            status: 1,
            stdout: '',
            stderr: 'pg_restore failed for DATABASE_URL=postgresql://backup-user:secret@db.charitypilot.ie\n',
          };
        },
      },
    );

    assert.equal(restoreResult.status, 1);
    assert.match(restoreResult.stderr, /database restore verification failed/);
    assert.doesNotMatch(restoreResult.stderr, /backup-user:secret|postgresql:\/\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production database checker keeps the backup only when explicitly requested', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());
  const outputDir = join(tempDir, 'retained-backup');

  try {
    const result = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath, `--backup-output-dir=${outputDir}`, '--keep-backup'],
      {
        runPostgresBackupFromArgs: async (args) => {
          if (args[0] === 'backup') {
            writeFileSync(join(outputDir, 'production-check.dump'), 'backup dump');
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(outputDir), ['production-check.dump']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production database checker redacts thrown backup helper failures', async () => {
  const runProductionDatabaseCheckFromArgs = await loadDatabaseRunner();
  const { tempDir, envPath } = writeEnvFile(productionEnv());

  try {
    const result = await runProductionDatabaseCheckFromArgs(
      ['--production-env-file', envPath],
      {
        makeTempDir: () => join(tempDir, 'thrown-failure'),
        runPostgresBackupFromArgs: async () => {
          throw new Error(
            'backup crashed with DATABASE_URL=postgresql://backup-user:secret@db.charitypilot.ie:5432/charitypilot?sslmode=require and --database-url=postgresql://backup-user:secret@db.charitypilot.ie/db',
          );
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production database check failed:/);
    assert.match(result.stderr, /DATABASE_URL=\[redacted\]/);
    assert.match(result.stderr, /--database-url=\[redacted\]/);
    assert.doesNotMatch(result.stderr, /backup-user:secret|postgresql:\/\//);
    assert.equal(existsSync(join(tempDir, 'thrown-failure')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
