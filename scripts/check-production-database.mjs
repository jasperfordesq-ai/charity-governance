#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  redactPostgresTranscript,
  runPostgresBackupFromArgs as defaultRunPostgresBackupFromArgs,
} from './postgres-backup.mjs';

const DEFAULT_DUMP_FILE = 'production-check.dump';
const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

function usage() {
  return [
    'Usage: node scripts/check-production-database.mjs --production-env-file <path> [--backup-output-dir <path>] [--keep-backup] [--expect-operational-sentinel]',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
    backupOutputDir: null,
    keepBackup: false,
    expectOperationalSentinel: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--production-env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--production-env-file=')) {
      const value = arg.slice('--production-env-file='.length);
      if (!value) throw new Error('--production-env-file requires a value');
      options.productionEnvFile = value;
      continue;
    }
    if (arg === '--backup-output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--backup-output-dir requires a value');
      options.backupOutputDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--backup-output-dir=')) {
      const value = arg.slice('--backup-output-dir='.length);
      if (!value) throw new Error('--backup-output-dir requires a value');
      options.backupOutputDir = value;
      continue;
    }
    if (arg === '--keep-backup') {
      options.keepBackup = true;
      continue;
    }
    if (arg === '--expect-operational-sentinel') {
      options.expectOperationalSentinel = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`production env file not found: ${path}`);
  }

  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

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

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/REPLACE_ME|change-me|your_|your-|project_ref|TODO|TBD|placeholder/i.test(value);
}

function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocalDatabaseHost(hostname) {
  const normalized = normaliseHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === 'host.docker.internal' ||
    normalized.endsWith('.localhost')
  );
}

function isReservedDocumentationHostname(hostname) {
  const normalized = normaliseHostname(hostname);
  return (
    normalized === 'example.com' ||
    normalized === 'example.net' ||
    normalized === 'example.org' ||
    normalized.endsWith('.example') ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid')
  );
}

function databaseUrlIssues(databaseUrl) {
  const issues = [];
  if (!isConfigured(databaseUrl)) {
    issues.push('DATABASE_URL is missing or still contains a placeholder value');
    return issues;
  }

  try {
    const url = new URL(databaseUrl.trim());
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push('DATABASE_URL must use a PostgreSQL connection URL');
    }
    if (isLocalDatabaseHost(url.hostname)) {
      issues.push('DATABASE_URL must not point at localhost in production');
    }
    if (isReservedDocumentationHostname(url.hostname)) {
      issues.push('DATABASE_URL must not use a reserved documentation hostname');
    }
    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    if (!sslMode || !REQUIRED_DATABASE_SSL_MODES.has(sslMode)) {
      issues.push('DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full');
    }
  } catch {
    issues.push('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  return issues;
}

function absolutePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function defaultMakeTempDir() {
  return join(tmpdir(), `charitypilot-production-database-${process.pid}-${Date.now()}`);
}

function redact(value) {
  return redactPostgresTranscript(value);
}

function failed(label, commandResult) {
  const details = redact(`${commandResult.stderr ?? ''}${commandResult.stdout ?? ''}`.trim());
  return result(
    1,
    '',
    `Production database check failed: ${label} failed.${details ? `\n${details}` : ''}\n`,
  );
}

function backupToolEnv(sourceEnv = process.env) {
  const allowedNames = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'CHARITYPILOT_POSTGRES_TOOLS_IMAGE',
  ];
  return Object.fromEntries(
    allowedNames
      .filter((name) => typeof sourceEnv[name] === 'string' && sourceEnv[name].length > 0)
      .map((name) => [name, sourceEnv[name]]),
  );
}

export async function runProductionDatabaseCheckFromArgs(
  args = process.argv.slice(2),
  {
    runPostgresBackupFromArgs = defaultRunPostgresBackupFromArgs,
    makeTempDir = defaultMakeTempDir,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  let env;
  try {
    env = parseEnvFile(resolve(process.cwd(), options.productionEnvFile));
  } catch (error) {
    return result(
      1,
      '',
      `Production database check failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
  }

  const issues = databaseUrlIssues(env.DATABASE_URL);
  if (issues.length > 0) {
    return result(1, '', `Production database check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}\n`);
  }

  const backupDir = absolutePath(options.backupOutputDir ?? makeTempDir());
  const dumpPath = join(backupDir, DEFAULT_DUMP_FILE);
  const helperEnv = backupToolEnv();
  mkdirSync(backupDir, { recursive: true });

  try {
    const backupArgs = [
      'backup',
      `--database-url=${env.DATABASE_URL}`,
      `--output-dir=${backupDir}`,
      `--output-file=${DEFAULT_DUMP_FILE}`,
      '--overwrite',
    ];
    const backupResult = await runPostgresBackupFromArgs(backupArgs, helperEnv);
    if (backupResult.status !== 0) {
      return failed('database backup', backupResult);
    }

    const restoreArgs = [
      'verify-restore',
      `--dump-file=${dumpPath}`,
    ];
    if (options.expectOperationalSentinel) {
      restoreArgs.push('--expect-operational-sentinel');
    }
    const restoreResult = await runPostgresBackupFromArgs(restoreArgs, helperEnv);
    if (restoreResult.status !== 0) {
      return failed('database restore verification', restoreResult);
    }

    return result(
      0,
      `Production database check passed: production PostgreSQL backup completed and restore verification succeeded${options.expectOperationalSentinel ? ' with operational sentinel checks' : ''}.\n`,
      '',
    );
  } catch (error) {
    return result(
      1,
      '',
      `Production database check failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
  } finally {
    if (!options.keepBackup) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkResult = await runProductionDatabaseCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}
