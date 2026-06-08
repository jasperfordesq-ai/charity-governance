#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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
const EXPECTED_GOVERNANCE_REFERENCE_DATA = {
  principles: 6,
  standards: 49,
  coreStandards: 32,
  additionalStandards: 17,
  principleSignature: '81b5ed4b083af3ed389277d07bfda9a6',
  standardSignature: '45465a0d0362b6e4696b04009f9a32eb',
};
const RESTORE_OPERATIONAL_SENTINEL = {
  organisationId: 'charitypilot-restore-sentinel-org',
  userId: 'charitypilot-restore-sentinel-user',
  documentId: 'charitypilot-restore-sentinel-document',
  complianceRecordId: 'charitypilot-restore-sentinel-compliance',
  documentStorageDeletionId: 'charitypilot-restore-sentinel-storage-deletion',
  stripeWebhookEventId: 'evt_charitypilot_restore_sentinel',
  organisationName: 'Restore Sentinel Organisation',
  contactEmail: 'restore-sentinel@charitypilot.ie',
  website: 'https://restore-sentinel.charitypilot.ie',
  userEmail: 'restore-sentinel-user@charitypilot.ie',
  userName: 'Restore Sentinel User',
  documentName: 'Restore Sentinel Board Minutes',
  documentUrl: 'supabase://restore-sentinel/board-minutes.pdf',
  complianceStandardCode: '1.1',
  storagePath: 'restore-sentinel/documents/board-minutes.pdf',
  webhookType: 'restore.sentinel',
};

function usage() {
  return `
Usage:
  node scripts/postgres-backup.mjs backup [options]
  node scripts/postgres-backup.mjs seed-restore-sentinel [options]
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
  --expect-operational-sentinel
                               Require the CI restore sentinel rows to survive restore.
  --dry-run                    Print Docker commands without running them.

Restore sentinel options:
  --database-url=<url>         Database URL to seed. Defaults to DATABASE_URL.
  --docker-network=<name>      Docker network for the postgres tools container.
  --allow-remote-sentinel      Permit seeding sentinel rows into a non-local database URL.
  --dry-run                    Print Docker commands and SQL without running them.
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

    if (['dry-run', 'overwrite', 'help', 'expect-operational-sentinel', 'allow-remote-sentinel'].includes(withoutPrefix)) {
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

function isLocalDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function restoreOperationalSentinelSignature() {
  const sentinel = RESTORE_OPERATIONAL_SENTINEL;
  return createHash('md5')
    .update(
      [
        [
          sentinel.organisationId,
          sentinel.organisationName,
          sentinel.contactEmail,
          sentinel.website,
        ].join('|'),
        [
          sentinel.userId,
          sentinel.userEmail,
          sentinel.userName,
          'OWNER',
          sentinel.organisationId,
          'true',
        ].join('|'),
        [
          sentinel.documentId,
          sentinel.documentName,
          'BOARD_MINUTES',
          sentinel.documentUrl,
          '12345',
          'application/pdf',
          sentinel.userId,
        ].join('|'),
        [
          sentinel.complianceRecordId,
          '2026',
          'COMPLIANT',
          sentinel.complianceStandardCode,
          sentinel.organisationId,
        ].join('|'),
        [
          sentinel.documentStorageDeletionId,
          sentinel.organisationId,
          sentinel.storagePath,
          '2',
          'restore sentinel last error',
        ].join('|'),
        [
          sentinel.stripeWebhookEventId,
          sentinel.webhookType,
        ].join('|'),
      ].join('\n'),
    )
    .digest('hex');
}

function restoreSentinelSeedSql() {
  const sentinel = RESTORE_OPERATIONAL_SENTINEL;
  const fixedTimestamp = sqlLiteral('2026-01-01 00:00:00+00');

  return `
INSERT INTO "Organisation" (
  "id", "name", "charitablePurpose", "contactEmail", "website", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.organisationId)},
  ${sqlLiteral(sentinel.organisationName)},
  ARRAY['COMMUNITY_BENEFIT']::"CharitablePurpose"[],
  ${sqlLiteral(sentinel.contactEmail)},
  ${sqlLiteral(sentinel.website)},
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "charitablePurpose" = EXCLUDED."charitablePurpose",
  "contactEmail" = EXCLUDED."contactEmail",
  "website" = EXCLUDED."website",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.userId)},
  ${sqlLiteral(sentinel.userEmail)},
  ${sqlLiteral(sentinel.userName)},
  ${sqlLiteral('$2a$10$restoreSentinelHashForBackupGate')},
  'OWNER'::"UserRole",
  ${sqlLiteral(sentinel.organisationId)},
  true,
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO UPDATE SET
  "email" = EXCLUDED."email",
  "name" = EXCLUDED."name",
  "passwordHash" = EXCLUDED."passwordHash",
  "role" = EXCLUDED."role",
  "organisationId" = EXCLUDED."organisationId",
  "emailVerified" = EXCLUDED."emailVerified",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "Document" (
  "id", "organisationId", "name", "category", "fileUrl", "fileSize", "mimeType", "owner", "uploadedById", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.documentId)},
  ${sqlLiteral(sentinel.organisationId)},
  ${sqlLiteral(sentinel.documentName)},
  'BOARD_MINUTES'::"DocumentCategory",
  ${sqlLiteral(sentinel.documentUrl)},
  12345,
  'application/pdf',
  ${sqlLiteral(sentinel.userName)},
  ${sqlLiteral(sentinel.userId)},
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO UPDATE SET
  "organisationId" = EXCLUDED."organisationId",
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "fileUrl" = EXCLUDED."fileUrl",
  "fileSize" = EXCLUDED."fileSize",
  "mimeType" = EXCLUDED."mimeType",
  "owner" = EXCLUDED."owner",
  "uploadedById" = EXCLUDED."uploadedById",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "ComplianceRecord" (
  "id", "organisationId", "standardId", "reportingYear", "status", "actionTaken", "evidence", "notes", "updatedById", "createdAt", "updatedAt"
)
SELECT
  ${sqlLiteral(sentinel.complianceRecordId)},
  ${sqlLiteral(sentinel.organisationId)},
  standards."id",
  2026,
  'COMPLIANT'::"ComplianceStatus",
  'Restore sentinel action',
  'Restore sentinel evidence',
  'Restore sentinel notes',
  ${sqlLiteral(sentinel.userId)},
  ${fixedTimestamp},
  ${fixedTimestamp}
FROM "GovernanceStandard" standards
WHERE standards."code" = ${sqlLiteral(sentinel.complianceStandardCode)}
ON CONFLICT ("organisationId", "standardId", "reportingYear") DO UPDATE SET
  "id" = EXCLUDED."id",
  "status" = EXCLUDED."status",
  "actionTaken" = EXCLUDED."actionTaken",
  "evidence" = EXCLUDED."evidence",
  "notes" = EXCLUDED."notes",
  "updatedById" = EXCLUDED."updatedById",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "DocumentStorageDeletion" (
  "id", "organisationId", "storagePath", "attempts", "lastError", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.documentStorageDeletionId)},
  ${sqlLiteral(sentinel.organisationId)},
  ${sqlLiteral(sentinel.storagePath)},
  2,
  'restore sentinel last error',
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO UPDATE SET
  "organisationId" = EXCLUDED."organisationId",
  "storagePath" = EXCLUDED."storagePath",
  "attempts" = EXCLUDED."attempts",
  "lastError" = EXCLUDED."lastError",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "StripeWebhookEvent" ("id", "type", "processedAt", "createdAt")
VALUES (
  ${sqlLiteral(sentinel.stripeWebhookEventId)},
  ${sqlLiteral(sentinel.webhookType)},
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO UPDATE SET
  "type" = EXCLUDED."type",
  "processedAt" = EXCLUDED."processedAt";
`.trim();
}

function runDatabaseUrlSql(databaseUrl, query, { dryRun = false, dockerNetwork } = {}) {
  validateDatabaseUrl(databaseUrl);

  const env = {
    ...process.env,
    CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL: databaseUrl,
    CHARITYPILOT_RESTORE_SENTINEL_SQL: query,
  };
  const args = [
    'run',
    '--rm',
    ...(dockerNetwork ? ['--network', dockerNetwork] : []),
    '-e',
    'CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_SENTINEL_SQL',
    DEFAULT_POSTGRES_IMAGE,
    'sh',
    '-lc',
    'psql --dbname "$CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL" -v ON_ERROR_STOP=1 -c "$CHARITYPILOT_RESTORE_SENTINEL_SQL"',
  ];

  if (dryRun) {
    console.log(query);
  }
  runCommand('docker', args, { dryRun, env });
}

function seedRestoreSentinel(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const databaseUrl = optionString(options, 'database-url') ?? process.env.DATABASE_URL;
  const dockerNetwork = optionString(options, 'docker-network');
  const allowRemoteSentinel = isEnabled(options, 'allow-remote-sentinel');

  if (!databaseUrl) {
    throw new Error('DATABASE_URL or --database-url is required for seed-restore-sentinel');
  }
  validateDatabaseUrl(databaseUrl);
  if (!allowRemoteSentinel && !isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(
      'Refusing to seed restore sentinel into a non-local database URL. ' +
        'Use --allow-remote-sentinel only for an intentionally disposable database.',
    );
  }

  runDatabaseUrlSql(databaseUrl, restoreSentinelSeedSql(), { dryRun, dockerNetwork });
  console.log(`Restore verification operational sentinel seeded for organisation ${RESTORE_OPERATIONAL_SENTINEL.organisationId}`);
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

function verifyRestoredReferenceData(containerName, dryRun) {
  const query = [
    'select',
    '(select count(*) from "GovernancePrinciple") as principles,',
    '(select count(*) from "GovernanceStandard") as standards,',
    '(select count(*) from "GovernanceStandard" where "isCore" = true) as core_standards,',
    '(select count(*) from "GovernanceStandard" where "isAdditional" = true) as additional_standards,',
    `(select md5(string_agg("number"::text || '|' || "title" || '|' || "description" || '|' || "sortOrder"::text, E'\\n' order by "sortOrder")) from "GovernancePrinciple") as principle_signature,`,
    `(select md5(string_agg(principles."number"::text || '|' || standards."code" || '|' || standards."title" || '|' || standards."isCore"::text || '|' || standards."isAdditional"::text || '|' || standards."sortOrder"::text, E'\\n' order by standards."sortOrder")) from "GovernanceStandard" standards join "GovernancePrinciple" principles on principles."id" = standards."principleId") as standard_signature;`,
  ].join(' ');
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

  const [
    principles,
    standards,
    coreStandards,
    additionalStandards,
    principleSignature,
    standardSignature,
  ] = stdout
    .trim()
    .split('|');

  const expected = EXPECTED_GOVERNANCE_REFERENCE_DATA;
  if (
    Number.parseInt(principles, 10) !== expected.principles ||
    Number.parseInt(standards, 10) !== expected.standards ||
    Number.parseInt(coreStandards, 10) !== expected.coreStandards ||
    Number.parseInt(additionalStandards, 10) !== expected.additionalStandards ||
    principleSignature !== expected.principleSignature ||
    standardSignature !== expected.standardSignature
  ) {
    throw new Error(
      'Restore verification found invalid governance reference data: ' +
        `principles=${principles}, standards=${standards}, ` +
        `coreStandards=${coreStandards}, additionalStandards=${additionalStandards}, ` +
        `principleSignature=${principleSignature}, standardSignature=${standardSignature}`,
    );
  }

  console.log(
    'Restore verification found governance reference data: ' +
      `${principles} principles, ${standards} standards, ` +
      `${coreStandards} core, ${additionalStandards} additional`,
  );
}

function verifyRestoredOperationalSentinel(containerName, dryRun) {
  const sentinel = RESTORE_OPERATIONAL_SENTINEL;
  const query = [
    'select',
    `(select count(*) from "Organisation" where "id" = ${sqlLiteral(sentinel.organisationId)}) as organisations,`,
    `(select count(*) from "User" where "id" = ${sqlLiteral(sentinel.userId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as users,`,
    `(select count(*) from "Document" where "id" = ${sqlLiteral(sentinel.documentId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as documents,`,
    `(select count(*) from "ComplianceRecord" where "id" = ${sqlLiteral(sentinel.complianceRecordId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as compliance_records,`,
    `(select count(*) from "DocumentStorageDeletion" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as document_storage_deletions,`,
    `(select count(*) from "StripeWebhookEvent" where "id" = ${sqlLiteral(sentinel.stripeWebhookEventId)}) as stripe_webhook_events,`,
    `(select md5(concat_ws(E'\\n',`,
    `  coalesce((select concat_ws('|', "id", "name", "contactEmail", "website") from "Organisation" where "id" = ${sqlLiteral(sentinel.organisationId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "email", "name", "role"::text, "organisationId", "emailVerified"::text) from "User" where "id" = ${sqlLiteral(sentinel.userId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "name", "category"::text, "fileUrl", "fileSize"::text, "mimeType", "uploadedById") from "Document" where "id" = ${sqlLiteral(sentinel.documentId)}), ''),`,
    `  coalesce((select concat_ws('|', records."id", records."reportingYear"::text, records."status"::text, standards."code", records."organisationId") from "ComplianceRecord" records join "GovernanceStandard" standards on standards."id" = records."standardId" where records."id" = ${sqlLiteral(sentinel.complianceRecordId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "organisationId", "storagePath", "attempts"::text, "lastError") from "DocumentStorageDeletion" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "type") from "StripeWebhookEvent" where "id" = ${sqlLiteral(sentinel.stripeWebhookEventId)}), '')`,
    `))) as operational_signature;`,
  ].join(' ');
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

  const [
    organisations,
    users,
    documents,
    complianceRecords,
    documentStorageDeletions,
    stripeWebhookEvents,
    operationalSignature,
  ] = stdout
    .trim()
    .split('|');

  const expectedCounts = [organisations, users, documents, complianceRecords, documentStorageDeletions, stripeWebhookEvents]
    .map((value) => Number.parseInt(value, 10));
  const expectedSignature = restoreOperationalSentinelSignature();
  if (expectedCounts.some((count) => count !== 1) || operationalSignature !== expectedSignature) {
    throw new Error(
      'Restore verification found invalid operational sentinel data: ' +
        `organisations=${organisations}, users=${users}, documents=${documents}, ` +
        `complianceRecords=${complianceRecords}, documentStorageDeletions=${documentStorageDeletions}, ` +
        `stripeWebhookEvents=${stripeWebhookEvents}, operationalSignature=${operationalSignature}`,
    );
  }

  console.log('Restore verification found operational sentinel data across organisation, user, document, compliance, storage deletion, and webhook tables');
}

function verifyRestore(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const expectOperationalSentinel = isEnabled(options, 'expect-operational-sentinel');
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
    verifyRestoredReferenceData(containerName, dryRun);
    if (expectOperationalSentinel) {
      verifyRestoredOperationalSentinel(containerName, dryRun);
    }
    console.log(`Restore verification passed for ${dumpFile}`);
  } finally {
    if (containerStarted || dryRun) {
      cleanupRestoreContainer(containerName, dryRun);
    }
  }
}

async function withProcessEnv(env, callback) {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

function captureConsole() {
  let stdout = '';
  let stderr = '';
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...values) => {
    stdout += `${values.map(String).join(' ')}\n`;
  };
  console.error = (...values) => {
    stderr += `${values.map(String).join(' ')}\n`;
  };

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export async function runPostgresBackupFromArgs(args = process.argv.slice(2), env = process.env) {
  const output = captureConsole();

  try {
    await withProcessEnv(env, async () => {
      const { command, options } = parseArgs(args);
      if (!command || command === 'help' || isEnabled(options, 'help')) {
        console.log(usage().trim());
        return;
      }

      if (command === 'backup') {
        await backup(options);
        return;
      }

      if (command === 'seed-restore-sentinel') {
        seedRestoreSentinel(options);
        return;
      }

      if (command === 'verify-restore') {
        verifyRestore(options);
        return;
      }

      throw new Error(`Unknown command: ${command}`);
    });

    return result(0, output.stdout, output.stderr);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage().trim());
    return result(1, output.stdout, output.stderr);
  } finally {
    output.restore();
  }
}

async function main() {
  const backupResult = await runPostgresBackupFromArgs();
  if (backupResult.stdout) process.stdout.write(backupResult.stdout);
  if (backupResult.stderr) process.stderr.write(backupResult.stderr);
  process.exit(backupResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
