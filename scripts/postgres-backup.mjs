#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_POSTGRES_IMAGE = process.env.CHARITYPILOT_POSTGRES_TOOLS_IMAGE || 'postgres:16.4-alpine';
const DEFAULT_BACKUP_DIR = '.charitypilot-backups/postgres';
const DEFAULT_DATABASE_NAME = 'charitypilot';
const DEFAULT_DATABASE_USER = 'charitypilot';
const RESTORE_DATABASE_NAME = 'charitypilot_restore';
const RESTORE_DATABASE_USER = 'charitypilot';
const RESTORE_DATABASE_PASSWORD = 'charitypilot_restore';
const CRITICAL_RESTORE_TABLES = [
  '_prisma_migrations',
  'Organisation',
  'User',
  'Document',
  'DocumentStorageDeletion',
  'StripeWebhookEvent',
];

function usage() {
  return `
Usage:
  node scripts/postgres-backup.mjs backup [options]
  node scripts/postgres-backup.mjs verify-restore --dump-file=<path> [options]

Backup options:
  --database-container=<name>  Dump a local Docker Postgres container with docker exec.
  --database-url=<url>         Dump a database URL with a postgres tools container.
  --docker-network=<name>      Docker network for --database-url backup tools container.
  --database-name=<name>       Database name for --database-container. Default: charitypilot.
  --database-user=<user>       Database user for --database-container. Default: charitypilot.
  --output-dir=<path>          Backup output directory. Default: .charitypilot-backups/postgres.
  --output-file=<name>         Backup file name. Default: timestamped .dump file.
  --overwrite                  Allow replacing an existing output file.
  --dry-run                    Print Docker commands without running them.

Restore verification options:
  --dump-file=<path>           Custom-format dump file to restore into a disposable DB.
  --dry-run                    Print Docker commands without running them.
`;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    if (['dry-run', 'overwrite', 'help'].includes(withoutPrefix)) {
      options[withoutPrefix] = true;
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${withoutPrefix}`);
    }
    options[withoutPrefix] = value;
    index += 1;
  }

  return { command, options };
}

function optionString(options, name) {
  const value = options[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isEnabled(options, name) {
  return options[name] === true;
}

function requireSafeFileName(fileName) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    throw new Error('--output-file must be a file name, not a path');
  }
  return fileName;
}

function timestampedBackupFileName() {
  return `charitypilot-postgres-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
}

function temporaryBackupFileName(outputFile) {
  return `.${outputFile}.${process.pid}.${Date.now()}.tmp`;
}

function temporaryBackupPath(outputPath) {
  return join(dirname(outputPath), temporaryBackupFileName(basename(outputPath)));
}

function absolutePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function ensureDockerAvailable() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Docker is not available');
  }
}

function runCommand(command, args, { dryRun = false, env = process.env } = {}) {
  if (dryRun) {
    console.log(formatCommand(command, args));
    return '';
  }

  ensureDockerAvailable();
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed with exit code ${result.status}`);
  }

  return result.stdout;
}

async function runStreamingCommand(command, args, outputPath, { dryRun = false } = {}) {
  const tempPath = temporaryBackupPath(outputPath);

  if (dryRun) {
    console.log(`${formatCommand(command, args)} > ${quoteForDisplay(tempPath)}`);
    return;
  }

  ensureDockerAvailable();

  try {
    await new Promise((resolvePromise, reject) => {
      const output = createWriteStream(tempPath, { flags: 'wx' });
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let childClosed = false;
      let outputClosed = false;
      let exitCode = null;
      let settled = false;

      const maybeResolve = () => {
        if (settled || !childClosed || !outputClosed) return;
        settled = true;
        if (exitCode === 0) {
          resolvePromise();
        } else {
          reject(new Error(`${command} failed with exit code ${exitCode}`));
        }
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };

      child.stdout.pipe(output);
      child.on('error', fail);
      output.on('error', fail);
      output.on('close', () => {
        outputClosed = true;
        maybeResolve();
      });
      child.on('close', (code) => {
        childClosed = true;
        exitCode = code;
        maybeResolve();
      });
    });
    renameSync(tempPath, outputPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function moveBackupIntoPlace(tempPath, outputPath) {
  try {
    renameSync(tempPath, outputPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function cleanupTemporaryBackup(tempPath) {
  rmSync(tempPath, { force: true });
}

function runUrlBackup(args, env, outputPath, dryRun) {
  if (dryRun) {
    runCommand('docker', args, { dryRun, env });
    return;
  }

  const tempPath = join(dirname(outputPath), env.CHARITYPILOT_BACKUP_FILE);
  try {
    runCommand('docker', args, { dryRun, env });
    moveBackupIntoPlace(tempPath, outputPath);
  } catch (error) {
    cleanupTemporaryBackup(tempPath);
    throw error;
  }
}

function cleanupRestoreContainer(containerName, dryRun) {
  try {
    runCommand('docker', ['rm', '-f', containerName], { dryRun });
  } catch (error) {
    if (!dryRun) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Restore verification cleanup failed for ${containerName}: ${message}`);
    }
  }
}

function runStartRestoreContainer(args, dryRun) {
  runCommand('docker', args, { dryRun });
  return true;
}

function backupTarget(options) {
  const databaseContainer = optionString(options, 'database-container');
  const databaseUrl = optionString(options, 'database-url') ?? process.env.DATABASE_URL;

  if (databaseContainer) {
    return { type: 'container', databaseContainer };
  }

  if (databaseUrl) {
    return { type: 'url', databaseUrl };
  }

  throw new Error('DATABASE_URL or --database-container is required');
}

function validateDatabaseUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
      throw new Error('Database URL must use postgres:// or postgresql://');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Database URL must use postgres:// or postgresql://') {
      throw error;
    }
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
}

async function backup(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const outputDir = absolutePath(optionString(options, 'output-dir') ?? DEFAULT_BACKUP_DIR);
  const outputFile = requireSafeFileName(optionString(options, 'output-file') ?? timestampedBackupFileName());
  const outputPath = join(outputDir, outputFile);
  const overwrite = isEnabled(options, 'overwrite');
  const target = backupTarget(options);

  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
    if (existsSync(outputPath) && !overwrite) {
      throw new Error(`Backup file already exists: ${outputPath}`);
    }
  }

  if (target.type === 'container') {
    const databaseName = optionString(options, 'database-name') ?? DEFAULT_DATABASE_NAME;
    const databaseUser = optionString(options, 'database-user') ?? DEFAULT_DATABASE_USER;
    const args = [
      'exec',
      target.databaseContainer,
      'pg_dump',
      '-U',
      databaseUser,
      '-d',
      databaseName,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ];

    await runStreamingCommand('docker', args, outputPath, { dryRun });
  } else {
    validateDatabaseUrl(target.databaseUrl);
    const tempOutputFile = temporaryBackupFileName(outputFile);
    const dockerNetwork = optionString(options, 'docker-network');
    const env = {
      ...process.env,
      CHARITYPILOT_BACKUP_DATABASE_URL: target.databaseUrl,
      CHARITYPILOT_BACKUP_FILE: tempOutputFile,
    };
    const args = [
      'run',
      '--rm',
      ...(dockerNetwork ? ['--network', dockerNetwork] : []),
      '-e',
      'CHARITYPILOT_BACKUP_DATABASE_URL',
      '-e',
      'CHARITYPILOT_BACKUP_FILE',
      '-v',
      `${outputDir}:/backup`,
      DEFAULT_POSTGRES_IMAGE,
      'sh',
      '-lc',
      'pg_dump --dbname "$CHARITYPILOT_BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges --file "/backup/$CHARITYPILOT_BACKUP_FILE"',
    ];

    runUrlBackup(args, env, outputPath, dryRun);
  }

  console.log(`Backup written to ${outputPath}`);
}

function requireDumpFile(options) {
  const dumpFile = optionString(options, 'dump-file');
  if (!dumpFile) {
    throw new Error('--dump-file is required for verify-restore');
  }

  const absoluteDumpFile = absolutePath(dumpFile);
  if (!existsSync(absoluteDumpFile)) {
    throw new Error(`Dump file not found: ${absoluteDumpFile}`);
  }
  if (!statSync(absoluteDumpFile).isFile()) {
    throw new Error(`Dump path is not a file: ${absoluteDumpFile}`);
  }

  return absoluteDumpFile;
}

function restoreContainerName() {
  return `charitypilot-restore-verify-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function restoreDatabaseUrl() {
  return `postgresql://${RESTORE_DATABASE_USER}:${RESTORE_DATABASE_PASSWORD}@127.0.0.1:5432/${RESTORE_DATABASE_NAME}`;
}

function waitForRestoreDatabase(containerName, dryRun) {
  const readinessArgs = [
    'exec',
    containerName,
    'pg_isready',
    '-h',
    '127.0.0.1',
    '-U',
    RESTORE_DATABASE_USER,
    '-d',
    RESTORE_DATABASE_NAME,
  ];

  if (dryRun) {
    console.log(`until ${formatCommand('docker', readinessArgs)}; do sleep 1; done`);
    return;
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', readinessArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  throw new Error('Timed out waiting for restore verification database to become ready');
}

function verifyRestoredSchema(containerName, dryRun) {
  const criticalTableList = CRITICAL_RESTORE_TABLES
    .map((table) => `'${table.replaceAll("'", "''")}'`)
    .join(', ');
  const query = `select table_name from information_schema.tables where table_schema='public' and table_name in (${criticalTableList}) order by table_name;`;
  const args = [
    'run',
    '--rm',
    '--network',
    `container:${containerName}`,
    DEFAULT_POSTGRES_IMAGE,
    'psql',
    '--dbname',
    restoreDatabaseUrl(),
    '-tAc',
    query,
  ];

  const stdout = runCommand('docker', args, { dryRun });
  if (dryRun) return;

  const restoredTables = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missingTables = CRITICAL_RESTORE_TABLES.filter((table) => !restoredTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Restore verification is missing critical table(s): ${missingTables.join(', ')}`);
  }

  console.log(`Restore verification found critical tables: ${CRITICAL_RESTORE_TABLES.join(', ')}`);
}

function verifyRestore(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const dumpFile = requireDumpFile(options);
  const dumpDir = dirname(dumpFile);
  const dumpName = basename(dumpFile);
  const containerName = restoreContainerName();
  const startArgs = [
    'run',
    '-d',
    '--name',
    containerName,
    '-e',
    `POSTGRES_USER=${RESTORE_DATABASE_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${RESTORE_DATABASE_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${RESTORE_DATABASE_NAME}`,
    DEFAULT_POSTGRES_IMAGE,
  ];
  const restoreArgs = [
    'run',
    '--rm',
    '--network',
    `container:${containerName}`,
    '-v',
    `${dumpDir}:/backup:ro`,
    DEFAULT_POSTGRES_IMAGE,
    'pg_restore',
    '--dbname',
    restoreDatabaseUrl(),
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    `/backup/${dumpName}`,
  ];

  let containerStarted = false;

  try {
    containerStarted = runStartRestoreContainer(startArgs, dryRun);
    waitForRestoreDatabase(containerName, dryRun);
    runCommand('docker', restoreArgs, { dryRun });
    verifyRestoredSchema(containerName, dryRun);
    console.log(`Restore verification passed for ${dumpFile}`);
  } finally {
    if (containerStarted || dryRun) {
      cleanupRestoreContainer(containerName, dryRun);
    }
  }
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (!command || command === 'help' || isEnabled(options, 'help')) {
      console.log(usage().trim());
      return;
    }

    if (command === 'backup') {
      await backup(options);
      return;
    }

    if (command === 'verify-restore') {
      verifyRestore(options);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage().trim());
    process.exitCode = 1;
  }
}

await main();
