#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const backupRoot = join(repoRoot, '.charitypilot-backups');
const postgresBackupDir = join(backupRoot, 'postgres');
const documentBackupRoot = join(backupRoot, 'documents');
const localDocumentStorageDir = join(repoRoot, '.charitypilot-local-storage', 'documents');
const webAppDir = join(repoRoot, 'apps', 'web');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const databaseContainer = process.env.CHARITYPILOT_LOCAL_DB_CONTAINER || 'charitypilot-db';
const backupFile = `personal-local-${timestamp}.dump`;
const backupPath = join(postgresBackupDir, backupFile);
const documentBackupDir = join(documentBackupRoot, `personal-local-${timestamp}`);

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set([
  '--no-browser',
  '--no-backup',
  '--keep-web-cache',
]);
for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    console.error(`Unknown option: ${arg}`);
    console.error('Usage: npm run personal:ready -- [--no-browser] [--no-backup] [--keep-web-cache]');
    process.exit(2);
  }
}
const skipBrowser = args.has('--no-browser');
const skipBackup = args.has('--no-backup');
const keepWebCache = args.has('--keep-web-cache');

function run(label, command, commandArgs, options = {}) {
  console.log(`\n-- ${label} --`);
  const usesWindowsNpmShim = process.platform === 'win32' && command === 'npm';
  const executable = usesWindowsNpmShim ? 'cmd.exe' : command;
  const executableArgs = usesWindowsNpmShim ? ['/d', '/s', '/c', 'npm', ...commandArgs] : commandArgs;
  const result = spawnSync(executable, executableArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''}`,
    );
  }
}

function npmScript(script, scriptArgs = []) {
  run(`npm run ${script}`, 'npm', ['run', script, ...scriptArgs]);
}

function hasAnyFile(path) {
  if (!existsSync(path)) return false;
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (hasAnyFile(entryPath)) return true;
    } else if (entry.isFile()) {
      return true;
    }
  }
  return false;
}

function localWebContainerIsRunning() {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', 'charitypilot-web-local'], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });

  return result.status === 0 && result.stdout.trim() === 'true';
}

function cleanupGeneratedWebCaches() {
  if (keepWebCache) {
    console.log('\n-- Generated web cache cleanup --\nSKIP because --keep-web-cache was provided.');
    return;
  }

  console.log('\n-- Generated web cache cleanup --');
  if (localWebContainerIsRunning()) {
    console.log('SKIP because charitypilot-web-local is already running; keeping Next.js cache stable for the smoke checks.');
    return;
  }

  const removableNames = readdirSync(webAppDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^(\.next|\.next-build|\.next-dev|next-codex-build|\.turbo|\.test-dist)/.test(name));

  for (const name of removableNames) {
    const path = join(webAppDir, name);
    if (!resolve(path).startsWith(resolve(webAppDir))) {
      throw new Error(`Refusing to remove generated cache outside apps/web: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }

  console.log(`Removed ${removableNames.length} generated web build/cache director${removableNames.length === 1 ? 'y' : 'ies'}.`);
}

function backupLocalDocuments() {
  console.log(`\n-- Local document storage backup --`);
  if (!existsSync(localDocumentStorageDir)) {
    throw new Error(`Local document storage directory does not exist: ${localDocumentStorageDir}`);
  }
  if (!statSync(localDocumentStorageDir).isDirectory()) {
    throw new Error(`Local document storage path is not a directory: ${localDocumentStorageDir}`);
  }
  if (!hasAnyFile(localDocumentStorageDir)) {
    throw new Error(`Local document storage directory is empty: ${localDocumentStorageDir}`);
  }

  mkdirSync(documentBackupRoot, { recursive: true });
  rmSync(documentBackupDir, { recursive: true, force: true });
  cpSync(localDocumentStorageDir, documentBackupDir, { recursive: true });
  if (!hasAnyFile(documentBackupDir)) {
    throw new Error(`Document backup copy is empty: ${documentBackupDir}`);
  }
  console.log(`Documents copied to ${documentBackupDir}`);
}

function runBackupAndRestoreVerification() {
  mkdirSync(postgresBackupDir, { recursive: true });
  run('PostgreSQL local backup', process.execPath, [
    'scripts/postgres-backup.mjs',
    'backup',
    `--database-container=${databaseContainer}`,
    `--output-file=${backupFile}`,
  ]);
  if (!existsSync(backupPath) || statSync(backupPath).size <= 0) {
    throw new Error(`PostgreSQL backup was not written: ${backupPath}`);
  }

  run('PostgreSQL restore verification', process.execPath, [
    'scripts/postgres-backup.mjs',
    'verify-restore',
    `--dump-file=${backupPath}`,
  ]);
  backupLocalDocuments();
}

function ensurePlaywrightInstalled() {
  if (existsSync(join(repoRoot, 'e2e', 'node_modules', '@playwright', 'test'))) {
    return;
  }

  run('Install E2E dependencies', 'npm', ['install', '--prefix', 'e2e']);
}

try {
  console.log('CharityPilot personal local readiness gate');
  console.log('Scope: local personal use on this computer, no Stripe, no production launch evidence.');
  console.log('This command is non-destructive except for a temporary smoke-test document upload that is deleted.');
  console.log('It may remove ignored Next.js build/cache outputs under apps/web; source and charity data are not touched.');
  console.log('Do not use the default full E2E suite against a personal database you care about; it resets tenant/app tables.');

  cleanupGeneratedWebCaches();
  npmScript('test:local-docker:smoke');

  if (skipBackup) {
    console.log('\n-- Backup and restore verification --\nSKIP because --no-backup was provided.');
  } else {
    runBackupAndRestoreVerification();
  }

  if (skipBrowser) {
    console.log('\n-- Personal local browser QA --\nSKIP because --no-browser was provided.');
  } else {
    ensurePlaywrightInstalled();
    run('Personal local browser QA', 'npm', [
      '--prefix',
      'e2e',
      'run',
      'test',
      '--',
      'tests/personal-local-readiness.spec.ts',
      '--config=personal-local.config.ts',
    ]);
  }

  console.log('\nPersonal local readiness passed.');
  if (skipBackup) {
    console.log('Database backup: skipped');
    console.log('Document backup: skipped');
  } else {
    console.log(`Database backup: ${backupPath}`);
    console.log(`Document backup: ${documentBackupDir}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
