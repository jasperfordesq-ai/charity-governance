#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_POSTGRES_IMAGE = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const APPROVED_POSTGRES_IMAGE_DIGEST_SHA256 = '5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const HELPER_IMPLEMENTATION_FORMAT = 'charitypilot-postgres-proof-helper/v1';
const HELPER_IMPLEMENTATION_REPOSITORY_URL = 'https://github.com/jasperfordesq-ai/charity-governance';
const HELPER_IMPLEMENTATION_SOURCE_PATH = 'scripts/postgres-backup.mjs';
const MAX_HELPER_IMPLEMENTATION_BYTES = 1024 * 1024;
const DEFAULT_BACKUP_DIR = '.charitypilot-backups/postgres';
const SOURCE_IDENTITY_FORMAT = 'charitypilot-postgres-source-identity/v2';
const RESTORE_PROOF_FORMAT = 'charitypilot-postgres-restore-proof/v2';
const SOURCE_IDENTITY_PROVENANCE_LIMITATION =
  'The identity digest proves consistency with the supplied source endpoint and read-only server metadata; independent immutable capture and operator control remain external evidence.';
const RESTORE_PROOF_PROVENANCE_LIMITATION =
  'This proof verifies a read-only source snapshot against one isolated restore. PostgreSQL ownership and ACL privileges are intentionally excluded by --no-owner and --no-privileges, sequence runtime state is excluded, and provider retention, immutable external custody, document-object recovery, and operator approval remain separate evidence.';
const PROOF_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DOCKER_AVAILABILITY_TIMEOUT_MS = 30 * 1000;
const PROOF_CONTAINER_STALE_AFTER_MS = PROOF_COMMAND_TIMEOUT_MS + 15 * 60 * 1000;
const PROOF_STDIO_LIMIT_BYTES = 512 * 1024;
const DEFAULT_TEMP_FILE_LIMIT_MB = 1024;
const MIN_TEMP_FILE_LIMIT_MB = 64;
const MAX_TEMP_FILE_LIMIT_MB = 2048;
const MAX_PUBLIC_TABLES = 5000;
const MAX_ROWS_PER_TABLE = 25_000_000;
const MAX_TOTAL_ROWS = 100_000_000;
const MAX_FINGERPRINT_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_DUMP_BYTES = 64 * 1024 * 1024 * 1024;
const CAPACITY_SAFETY_FACTOR = 2;
const CAPACITY_SAFETY_MARGIN_BYTES = 1024 * 1024 * 1024;
const CAPACITY_PREFLIGHT_METHOD = 'pg-database-size-factor-margin/v1';
const DEFAULT_DATABASE_NAME = 'charitypilot';
const DEFAULT_DATABASE_USER = 'charitypilot';
const RESTORE_DATABASE_NAME = 'charitypilot_restore';
const RESTORE_DATABASE_USER = 'charitypilot';
const RESTORE_BOOTSTRAP_DATABASE_NAME = 'postgres';
const SEQUENCE_STATE_EXCLUSION_REASON =
  'PostgreSQL sequence values are non-MVCC and cannot be bound to the exported snapshot; this proof therefore fails unless the public schema has zero sequences, identity columns, and nextval defaults.';
const OWNERSHIP_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-owner, so PostgreSQL object ownership is outside this proof.';
const ACL_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-privileges, so PostgreSQL ACL grants and default privileges are outside this proof.';
const CERTIFIED_DATA_CLASSES = [
  'ordinary-table-rows',
  'partitioned-table-own-rows',
  'materialized-view-rows',
];
const CERTIFIED_OBJECT_CLASSES = [
  'relations',
  'columns',
  'constraints',
  'indexes',
  'triggers',
  'row-security-policies',
  'routines-and-bodies',
  'types-domains-enums-and-ranges',
  'sequence-definitions-and-owned-by-relations',
  'extended-statistics',
  'user-rules',
];
const SCHEMA_CERTIFICATION_EXCLUSIONS = [
  {
    scope: 'non-public-schemas',
    reason: 'Only objects in the public schema are fingerprinted and compared.',
  },
  {
    scope: 'large-objects',
    reason: 'PostgreSQL large objects are excluded and proof fails unless the source and restore contain zero large objects.',
  },
  {
    scope: 'extension-membership',
    reason: 'Extension installation and membership metadata are excluded; supported extension-owned objects in public are fingerprinted by object definition.',
  },
  {
    scope: 'comments-and-security-labels',
    reason: 'Comments and security labels are not recovery-critical application integrity data and are excluded.',
  },
  {
    scope: 'database-level-objects',
    reason: 'Roles, tablespaces, database settings, foreign-data wrappers and servers, publications, subscriptions, and event triggers are excluded.',
  },
];
const CRITICAL_RESTORE_TABLES = [
  '_prisma_migrations',
  'Organisation',
  'User',
  'BillingAuthorityGrant',
  'SecurityAuditEvent',
  'Document',
  'DocumentStorageDeletion',
  'DocumentStorageDeletionRecovery',
  'StripeWebhookEvent',
  'Deadline',
  'DeadlineReminderLog',
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
  documentStorageDeletionRecoveryId: 'charitypilot-restore-sentinel-storage-recovery',
  documentStorageDeletionRecoveryNonce: '00000000-0000-4000-8000-000000000001',
  stripeWebhookEventId: 'evt_charitypilot_restore_sentinel',
  organisationName: 'Restore Sentinel Organisation',
  contactEmail: 'restore-sentinel@charitypilot.ie',
  website: 'https://restore-sentinel.charitypilot.ie',
  userEmail: 'restore-sentinel-user@charitypilot.ie',
  userName: 'Restore Sentinel User',
  documentName: 'Restore Sentinel Board Minutes',
  documentUrl: 'supabase://restore-sentinel/board-minutes.pdf',
  complianceStandardCode: '1.1',
  storagePath: 'charitypilot-restore-sentinel-org/documents/board-minutes.pdf',
  storageRecoveryReason: 'Restore sentinel validates immutable deletion recovery evidence.',
  webhookType: 'restore.sentinel',
};

function requireDigestPinnedPostgresImage(image) {
  if (image !== DEFAULT_POSTGRES_IMAGE) {
    throw new Error(
      `CHARITYPILOT_POSTGRES_TOOLS_IMAGE must exactly match the repository-approved tools image ${DEFAULT_POSTGRES_IMAGE}`,
    );
  }

  return image;
}

function postgresToolsImage() {
  const configuredImage = process.env.CHARITYPILOT_POSTGRES_TOOLS_IMAGE?.trim();
  return requireDigestPinnedPostgresImage(configuredImage || DEFAULT_POSTGRES_IMAGE);
}

export function linuxDockerHostUserArgs(
  {
    platform = process.platform,
    getuid = process.getuid,
    getgid = process.getgid,
  } = {},
) {
  if (platform !== 'linux' || typeof getuid !== 'function' || typeof getgid !== 'function') {
    return [];
  }

  const uid = getuid();
  const gid = getgid();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error('Could not determine the Linux deploy owner uid:gid for protected backup output');
  }
  return ['--user', `${uid}:${gid}`];
}

function usage() {
  return `
Usage:
  node scripts/postgres-backup.mjs backup [options]
  node scripts/postgres-backup.mjs seed-restore-sentinel [options]
  node scripts/postgres-backup.mjs verify-restore --dump-file=<path> [options]
  node scripts/postgres-backup.mjs source-identity [options]
  node scripts/postgres-backup.mjs prove-restore [options]

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
  --dry-run                    Print Docker commands and SQL without running them.

Production-safe source identity options:
  --database-url=<url>         Read-only source URL. Defaults to DATABASE_URL.
  --docker-network=<name>      Docker network for the read-only tools container.
  --temp-file-limit-mb=<mb>    Session temp-file cap (64-2048). Default: 1024.
  --json                       Emit one allowlisted JSON result line.
  --dry-run                    Render the read-only capture without claiming evidence.

Production-safe restore proof options:
  --database-url=<url>         Read-only source URL. Defaults to DATABASE_URL.
  --docker-network=<name>      Docker network for the read-only source tools container.
  --recovery-set-id=<id>       External recovery-set identifier (3-128 safe characters).
  --expected-source-database-identity-sha256=<sha256>
                               Independently captured source identity digest.
  --output-dir=<path>          Required explicit absolute owner-only proof directory.
  --output-file=<name>         Custom-format dump name. Default: timestamped .dump file.
  --report-file=<name>         Restore-proof JSON name. Default: <dump>.restore-proof.json.
  --temp-file-limit-mb=<mb>    Session temp-file cap (64-2048). Default: 1024.
  --dry-run                    Render commands without capturing or claiming evidence.
`;
}

const BOOLEAN_OPTIONS = new Set(['dry-run', 'overwrite', 'help', 'expect-operational-sentinel', 'json']);
const COMMAND_OPTIONS = new Map([
  ['backup', new Set([
    'database-container', 'database-url', 'docker-network', 'database-name', 'database-user',
    'output-dir', 'output-file', 'overwrite', 'dry-run', 'help',
  ])],
  ['seed-restore-sentinel', new Set(['database-url', 'docker-network', 'dry-run', 'help'])],
  ['verify-restore', new Set(['dump-file', 'expect-operational-sentinel', 'dry-run', 'help'])],
  ['source-identity', new Set(['database-url', 'docker-network', 'temp-file-limit-mb', 'json', 'dry-run', 'help'])],
  ['prove-restore', new Set([
    'database-url', 'docker-network', 'recovery-set-id', 'expected-source-database-identity-sha256',
    'output-dir', 'output-file', 'report-file', 'temp-file-limit-mb', 'dry-run', 'help',
  ])],
]);

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  const allowed = COMMAND_OPTIONS.get(command);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    if (withoutPrefix === 'allow-remote-sentinel') {
      throw new Error(
        '--allow-remote-sentinel has been removed; restore sentinels are restricted to confirmed local disposable databases',
      );
    }
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      const name = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      if (!name || !value.trim()) throw new Error(`Empty value for --${name || '<option>'}`);
      if (BOOLEAN_OPTIONS.has(name)) throw new Error(`--${name} does not accept a value`);
      if (Object.hasOwn(options, name)) throw new Error(`Duplicate option --${name}`);
      if (allowed && !allowed.has(name)) throw new Error(`Unknown option --${name} for ${command}`);
      options[name] = value;
      continue;
    }

    if (Object.hasOwn(options, withoutPrefix)) throw new Error(`Duplicate option --${withoutPrefix}`);
    if (allowed && !allowed.has(withoutPrefix)) {
      throw new Error(`Unknown option --${withoutPrefix} for ${command}`);
    }
    if (BOOLEAN_OPTIONS.has(withoutPrefix)) {
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

function requireIntegerOption(options, name, { minimum, maximum, defaultValue }) {
  const raw = optionString(options, name);
  if (raw === undefined) return defaultValue;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function proofTempFileLimitMb(options) {
  return requireIntegerOption(options, 'temp-file-limit-mb', {
    minimum: MIN_TEMP_FILE_LIMIT_MB,
    maximum: MAX_TEMP_FILE_LIMIT_MB,
    defaultValue: DEFAULT_TEMP_FILE_LIMIT_MB,
  });
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

export function redactPostgresTranscript(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'")]+/gi, '[redacted-database-url]')
    .replace(/DATABASE_URL=[^\s'")]+/gi, 'DATABASE_URL=[redacted]')
    .replace(/--database-url=[^\s'")]+/gi, '--database-url=[redacted]')
    .replace(/[A-Za-z0-9._%+-]+:[^@\s'")]+@/g, '[redacted-credentials]@')
    .replace(/\b(host|hostaddr|dbname|database|user|username|service|servicefile|passfile|sslkey)\s*=\s*[^\s,'";]+/gi, '$1=[redacted]')
    .replace(/\b(host|hostaddr|dbname|database|user|username)\s*:\s*[^\s,'";]+/gi, '$1: [redacted]');
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function canonicalSha256(domain, values) {
  return sha256Text(JSON.stringify({ domain, values: values.map((value) => String(value)) }));
}

function regularFileIdentity(status) {
  return {
    dev: String(status.dev),
    ino: String(status.ino),
    size: String(status.size),
    mode: String(status.mode),
    mtimeNs: String(status.mtimeNs ?? BigInt(Math.trunc(Number(status.mtimeMs) * 1_000_000))),
    ctimeNs: String(status.ctimeNs ?? BigInt(Math.trunc(Number(status.ctimeMs) * 1_000_000))),
  };
}

function identitiesEqual(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function sameUnderlyingFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs'].every((key) => left[key] === right[key]);
}

export function openProtectedRegularFile(filePath, label = 'proof artifact') {
  const before = lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Refusing non-regular or symbolic-link ${label}: ${filePath}`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
    const opened = fstatSync(fd, { bigint: true });
    const beforeIdentity = regularFileIdentity(before);
    const openedIdentity = regularFileIdentity(opened);
    if (!opened.isFile() || !identitiesEqual(beforeIdentity, openedIdentity)) {
      throw new Error(`${label} changed while its protected descriptor was opened`);
    }
    return { fd, filePath, label, identity: openedIdentity };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

export function assertProtectedFileUnchanged(handle, phase) {
  const opened = fstatSync(handle.fd, { bigint: true });
  const current = lstatSync(handle.filePath, { bigint: true });
  const openedIdentity = regularFileIdentity(opened);
  const currentIdentity = regularFileIdentity(current);
  if (
    !opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
    !identitiesEqual(handle.identity, openedIdentity) ||
    !identitiesEqual(handle.identity, currentIdentity)
  ) {
    throw new Error(`${handle.label} changed or was substituted ${phase}`);
  }
  return opened;
}

function sha256ProtectedFile(handle, phase) {
  const status = assertProtectedFileUnchanged(handle, `before ${phase}`);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < Number(status.size)) {
    const bytesRead = readSync(handle.fd, buffer, 0, Math.min(buffer.length, Number(status.size) - position), position);
    if (bytesRead <= 0) throw new Error(`${handle.label} ended unexpectedly during ${phase}`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  assertProtectedFileUnchanged(handle, `after ${phase}`);
  return hash.digest('hex');
}

function readProtectedFile(handle, maximumBytes, phase) {
  const status = assertProtectedFileUnchanged(handle, `before ${phase}`);
  const size = Number(status.size);
  if (!Number.isSafeInteger(size) || size > maximumBytes) {
    throw new Error(`${handle.label} exceeds the ${maximumBytes}-byte safety bound`);
  }
  const bytes = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const bytesRead = readSync(handle.fd, bytes, position, size - position, position);
    if (bytesRead <= 0) throw new Error(`${handle.label} ended unexpectedly during ${phase}`);
    position += bytesRead;
  }
  assertProtectedFileUnchanged(handle, `after ${phase}`);
  return bytes.toString('utf8');
}

function closeProtectedFile(handle) {
  if (handle?.fd !== undefined) closeSync(handle.fd);
}

function normalizeCanonicalRepositoryUrl(value) {
  const trimmed = String(value ?? '').trim().replace(/\.git$/i, '');
  if (trimmed === HELPER_IMPLEMENTATION_REPOSITORY_URL) return HELPER_IMPLEMENTATION_REPOSITORY_URL;
  if (trimmed === 'git@github.com:jasperfordesq-ai/charity-governance') {
    return HELPER_IMPLEMENTATION_REPOSITORY_URL;
  }
  if (trimmed === 'ssh://git@github.com/jasperfordesq-ai/charity-governance') {
    return HELPER_IMPLEMENTATION_REPOSITORY_URL;
  }
  return null;
}

function boundedGitResult(repoRoot, args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: binary ? null : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_HELPER_IMPLEMENTATION_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout;
}

export function captureHelperImplementationBinding({
  sourceFile = fileURLToPath(import.meta.url),
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
  let sourceHandle;
  try {
    sourceHandle = openProtectedRegularFile(sourceFile, 'PostgreSQL proof helper implementation');
    const sourceStatus = assertProtectedFileUnchanged(sourceHandle, 'before implementation binding');
    if (sourceStatus.size <= 0n || sourceStatus.size > BigInt(MAX_HELPER_IMPLEMENTATION_BYTES)) {
      throw new Error('PostgreSQL proof helper implementation exceeds its source byte bound');
    }
    const sourceSha256 = sha256ProtectedFile(sourceHandle, 'implementation binding');
    const commitRaw = boundedGitResult(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const commitSha = typeof commitRaw === 'string' && /^[a-f0-9]{40}\r?\n$/i.test(commitRaw)
      ? commitRaw.trim().toLowerCase()
      : null;
    const committedBytes = commitSha
      ? boundedGitResult(repoRoot, ['show', `${commitSha}:${HELPER_IMPLEMENTATION_SOURCE_PATH}`], { binary: true })
      : null;
    const commitSourceSha256 = Buffer.isBuffer(committedBytes) && committedBytes.length > 0
      ? createHash('sha256').update(committedBytes).digest('hex')
      : null;
    const originRaw = boundedGitResult(repoRoot, ['remote', 'get-url', 'origin']);
    const canonicalRepositoryMatched = typeof originRaw === 'string' &&
      normalizeCanonicalRepositoryUrl(originRaw) === HELPER_IMPLEMENTATION_REPOSITORY_URL;
    return {
      format: HELPER_IMPLEMENTATION_FORMAT,
      repositoryUrl: HELPER_IMPLEMENTATION_REPOSITORY_URL,
      commitSha,
      sourcePath: HELPER_IMPLEMENTATION_SOURCE_PATH,
      sourceSha256,
      commitSourceSha256,
      sourceMatchesCommit: commitSourceSha256 === sourceSha256,
      canonicalRepositoryMatched,
    };
  } finally {
    closeProtectedFile(sourceHandle);
  }
}

function requireHelperImplementationBinding(value) {
  const expectedKeys = [
    'format',
    'repositoryUrl',
    'commitSha',
    'sourcePath',
    'sourceSha256',
    'commitSourceSha256',
    'sourceMatchesCommit',
    'canonicalRepositoryMatched',
  ];
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys) ||
    value.format !== HELPER_IMPLEMENTATION_FORMAT ||
    value.repositoryUrl !== HELPER_IMPLEMENTATION_REPOSITORY_URL ||
    value.sourcePath !== HELPER_IMPLEMENTATION_SOURCE_PATH ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256 ?? '') ||
    !(value.commitSha === null || /^[a-f0-9]{40}$/.test(value.commitSha)) ||
    !(value.commitSourceSha256 === null || /^[a-f0-9]{64}$/.test(value.commitSourceSha256)) ||
    typeof value.sourceMatchesCommit !== 'boolean' ||
    typeof value.canonicalRepositoryMatched !== 'boolean' ||
    value.sourceMatchesCommit !== (
      value.commitSourceSha256 !== null && value.commitSourceSha256 === value.sourceSha256
    )
  ) {
    throw new Error('PostgreSQL proof helper implementation binding failed strict validation');
  }
  return value;
}

function assertHelperImplementationUnchanged(binding, phase) {
  const current = requireHelperImplementationBinding(captureHelperImplementationBinding());
  if (JSON.stringify(current) !== JSON.stringify(binding)) {
    throw new Error(`PostgreSQL proof helper implementation changed ${phase}`);
  }
}

function requireSha256(value, optionName) {
  if (!/^[a-f0-9]{64}$/i.test(value ?? '')) {
    throw new Error(`${optionName} must be exactly 64 hexadecimal SHA-256 characters`);
  }
  return value.toLowerCase();
}

function requireRecoverySetId(value) {
  if (!value) {
    throw new Error('--recovery-set-id is required for prove-restore');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{1,126}[A-Za-z0-9]$/.test(value)) {
    throw new Error('--recovery-set-id must be 3-128 safe characters and start/end with an alphanumeric character');
  }
  return value;
}

function sourceEndpointIdentitySha256(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const userName = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !databaseName || !userName) {
    throw new Error('DATABASE_URL must include a host, database name, and user for source identity capture');
  }
  const canonical = [
    'charitypilot-source-endpoint-identity/v1',
    parsed.protocol.toLowerCase(),
    parsed.hostname.toLowerCase(),
    parsed.port || '5432',
    databaseName,
    userName,
  ].join('\n');
  return sha256Text(canonical);
}

function safeJsonStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function protectOwnerOnly(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function protectDirectoryOwnerOnly(directoryPath, { newlyCreated = false } = {}) {
  if (newlyCreated) {
    try {
      chmodSync(directoryPath, 0o700);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  }
  const status = lstatSync(directoryPath);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Proof output directory must be a non-symbolic-link directory: ${directoryPath}`);
  }
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error(`Proof output directory must be owner-only mode 0700: ${directoryPath}`);
  }
  if (
    process.platform !== 'win32' && typeof process.getuid === 'function' &&
    status.uid !== process.getuid()
  ) {
    throw new Error(`Proof output directory must be owned by the current user: ${directoryPath}`);
  }
}

function protectedDirectoryIdentity(directoryPath) {
  const status = lstatSync(directoryPath, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Protected output directory is not stable');
  return { dev: String(status.dev), ino: String(status.ino), mode: String(status.mode), uid: String(status.uid) };
}

function assertProtectedDirectoryUnchanged(directoryPath, identity, phase) {
  const current = protectedDirectoryIdentity(directoryPath);
  if (!identitiesEqual(identity, current)) {
    throw new Error(`Protected output directory changed or was substituted ${phase}`);
  }
}

function requireProofOutputDirectory(options, { dryRun = false } = {}) {
  const configured = optionString(options, 'output-dir');
  if (!configured) throw new Error('--output-dir is required for prove-restore and must be an explicit absolute path');
  if (!isAbsolute(configured)) throw new Error('--output-dir for prove-restore must be an explicit absolute path');
  const outputDir = resolve(configured);
  let newlyCreated = false;
  if (!existsSync(outputDir)) {
    if (dryRun) throw new Error('prove-restore dry-run requires an existing protected --output-dir');
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    newlyCreated = true;
  }
  protectDirectoryOwnerOnly(outputDir, { newlyCreated });
  return outputDir;
}

export function preflightOutputFilesystemCapacity(
  outputDir,
  requiredBytes = MAX_DUMP_BYTES,
  { statfs = statfsSync } = {},
) {
  try {
    const status = statfs(outputDir, { bigint: true });
    const availableBytes = status.bavail * status.bsize;
    if (availableBytes < BigInt(requiredBytes)) {
      throw new Error(
        `Protected output filesystem has ${availableBytes} available bytes; at least ${requiredBytes} are required by maxDumpBytes`,
      );
    }
    return availableBytes;
  } catch (error) {
    if (error?.code === 'ENOSYS' || error?.code === 'ENOTSUP') return undefined;
    throw error;
  }
}

export function nextDumpByteCount(currentBytes, incomingBytes, maximumBytes = MAX_DUMP_BYTES) {
  if (
    !Number.isSafeInteger(currentBytes) || currentBytes < 0 ||
    !Number.isSafeInteger(incomingBytes) || incomingBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0
  ) {
    throw new Error('PostgreSQL dump byte counters failed strict validation');
  }
  const nextBytes = currentBytes + incomingBytes;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > maximumBytes) {
    throw new Error(`PostgreSQL dump stream exceeds maxDumpBytes (${maximumBytes})`);
  }
  return nextBytes;
}

function requireCanonicalNonnegativeDecimal(value, label) {
  const raw = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${label} must be a canonical nonnegative decimal integer`);
  return BigInt(raw);
}

export function calculateCapacityRequirement(sourceDatabaseSizeBytes) {
  const sourceBytes = requireCanonicalNonnegativeDecimal(sourceDatabaseSizeBytes, 'sourceDatabaseSizeBytes');
  const calculated = sourceBytes * BigInt(CAPACITY_SAFETY_FACTOR) + BigInt(CAPACITY_SAFETY_MARGIN_BYTES);
  const maximum = BigInt(MAX_DUMP_BYTES);
  return (calculated > maximum ? maximum : calculated).toString();
}

function ensureReplaceableProofPath(filePath, overwrite) {
  if (!existsSync(filePath)) return;
  const status = lstatSync(filePath);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Refusing non-regular or symbolic-link proof output path: ${filePath}`);
  }
  if (!overwrite) {
    throw new Error(`Proof output already exists: ${filePath}`);
  }
}

function temporaryProofFileName(finalName, label) {
  return `.${finalName}.${label}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
}

function decodeIdentifierHex(value, label) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) {
    throw new Error(`Fingerprint report contains invalid ${label} identifier encoding`);
  }
  const decoded = Buffer.from(value, 'hex').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('hex') !== value.toLowerCase()) {
    throw new Error(`Fingerprint report contains non-canonical UTF-8 ${label} identifier encoding`);
  }
  return decoded;
}

function decodeCanonicalUtf8Hex(value, label, { allowEmpty = false, maximumBytes = 256 } = {}) {
  if (allowEmpty && value === '') return '';
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) {
    throw new Error(`Fingerprint report contains invalid ${label} UTF-8 encoding`);
  }
  const bytes = Buffer.from(value, 'hex');
  if (bytes.length > maximumBytes) {
    throw new Error(`Fingerprint report ${label} exceeds its ${maximumBytes}-byte safety bound`);
  }
  const decoded = bytes.toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('hex') !== value.toLowerCase()) {
    throw new Error(`Fingerprint report contains non-canonical UTF-8 ${label} encoding`);
  }
  return decoded;
}

function requireRestorableDatabaseEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Source database environment is missing or malformed');
  }
  const expectedKeys = ['encoding', 'collation', 'ctype', 'localeProvider', 'collationVersion'];
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys)) {
    throw new Error('Source database environment has an unsupported shape');
  }
  if (!/^[A-Z0-9_]{1,32}$/.test(value.encoding ?? '')) {
    throw new Error('Source database encoding is not a canonical PostgreSQL encoding name');
  }
  for (const [label, locale] of [
    ['collation', value.collation],
    ['ctype', value.ctype],
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(locale ?? '')) {
      throw new Error(`Source database ${label} is not a supported libc locale name`);
    }
  }
  if (value.localeProvider !== 'libc') {
    throw new Error('Source database locale provider is unsupported; restore proof currently requires libc');
  }
  if (!(value.collationVersion === null || (
    typeof value.collationVersion === 'string' &&
    value.collationVersion.length > 0 &&
    Buffer.byteLength(value.collationVersion, 'utf8') <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value.collationVersion)
  ))) {
    throw new Error('Source database collation version is malformed');
  }
  return value;
}

function tableFingerprintSha256(table) {
  return canonicalSha256('charitypilot-table-fingerprint/v2', [
    table.schemaHex,
    table.tableHex,
    table.relationKind,
    table.isPartition ? 'partition' : 'not-partition',
    table.rowCount,
    table.schemaSha256,
    table.rowsSha256,
  ]);
}

export function parseDatabaseFingerprintReport(rawReport) {
  if (Buffer.byteLength(rawReport, 'utf8') > 16 * 1024 * 1024) {
    throw new Error('Fingerprint report exceeds the 16 MiB safety bound');
  }

  const metadata = new Map();
  const tables = [];
  const seenTables = new Set();
  const lines = String(rawReport).split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const fields = line.split('|');
    if (fields[0] === 'meta' && fields.length === 3) {
      if (metadata.has(fields[1])) {
        throw new Error(`Fingerprint report repeats metadata field ${fields[1]}`);
      }
      metadata.set(fields[1], fields[2]);
      continue;
    }
    if (fields[0] !== 'table' || fields.length !== 9) {
      throw new Error('Fingerprint report contains an unsupported or malformed record');
    }

    const [, schemaHexRaw, tableHexRaw, relationKind, partitionFlag, readableFlag, rowCount, schemaShaRaw, rowsShaRaw] = fields;
    const schemaHex = schemaHexRaw.toLowerCase();
    const tableHex = tableHexRaw.toLowerCase();
    const tableKey = `${schemaHex}:${tableHex}`;
    if (seenTables.has(tableKey)) {
      throw new Error('Fingerprint report repeats a public table');
    }
    seenTables.add(tableKey);
    if (!['r', 'p', 'm'].includes(relationKind) || !['0', '1'].includes(partitionFlag)) {
      throw new Error('Fingerprint report contains an invalid table or partition kind');
    }
    if (readableFlag !== '1') {
      throw new Error('Fingerprint report proves that at least one public application table was not fully readable');
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(rowCount)) {
      throw new Error('Fingerprint report contains an invalid row count');
    }

    const table = {
      schema: decodeIdentifierHex(schemaHex, 'schema'),
      table: decodeIdentifierHex(tableHex, 'table'),
      schemaHex,
      tableHex,
      relationKind,
      isPartition: partitionFlag === '1',
      rowCount,
      schemaSha256: requireSha256(schemaShaRaw, 'schema fingerprint'),
      rowsSha256: requireSha256(rowsShaRaw, 'row fingerprint'),
    };
    table.tableFingerprintSha256 = tableFingerprintSha256(table);
    tables.push(table);
  }

  if (tables.length === 0) {
    throw new Error('Fingerprint report did not contain any public application tables');
  }
  tables.sort((left, right) => {
    const leftKey = `${left.schemaHex}:${left.tableHex}`;
    const rightKey = `${right.schemaHex}:${right.tableHex}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const requiredMetadata = [
    'source_snapshot_sha256',
    'database_identity_sha256',
    'database_encoding_hex',
    'database_collation_hex',
    'database_ctype_hex',
    'database_locale_provider',
    'database_collation_version_hex',
    'public_schema_sha256',
    'settings_verified',
    'access_share_locks_verified',
    'temp_file_limit_bytes',
    'max_public_tables',
    'max_rows_per_table',
    'max_total_rows',
    'public_object_count',
    'public_sequence_count',
    'application_identity_column_count',
    'application_sequence_default_count',
    'unsupported_public_object_count',
    'large_object_count',
  ];
  for (const field of requiredMetadata) {
    if (!metadata.has(field)) throw new Error(`Fingerprint report is missing metadata field ${field}`);
  }
  if (metadata.get('settings_verified') !== '1' || metadata.get('access_share_locks_verified') !== '1') {
    throw new Error('Fingerprint report did not verify its read-only snapshot settings and table locks');
  }

  const parseBoundedMetadataInteger = (field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = metadata.get(field);
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw ?? '')) {
      throw new Error(`Fingerprint report contains invalid ${field} metadata`);
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Fingerprint report contains out-of-range ${field} metadata`);
    }
    return value;
  };
  const tempFileLimitBytes = parseBoundedMetadataInteger('temp_file_limit_bytes', {
    minimum: MIN_TEMP_FILE_LIMIT_MB * 1024 * 1024,
    maximum: MAX_TEMP_FILE_LIMIT_MB * 1024 * 1024,
  });
  const maxPublicTables = parseBoundedMetadataInteger('max_public_tables', { minimum: 1, maximum: MAX_PUBLIC_TABLES });
  const maxRowsPerTable = parseBoundedMetadataInteger('max_rows_per_table', { minimum: 1, maximum: MAX_ROWS_PER_TABLE });
  const maxTotalRows = parseBoundedMetadataInteger('max_total_rows', { minimum: 1, maximum: MAX_TOTAL_ROWS });
  const publicObjectCount = parseBoundedMetadataInteger('public_object_count', { minimum: 1, maximum: 100_000 });
  const publicSequenceCount = parseBoundedMetadataInteger('public_sequence_count');
  const applicationIdentityColumnCount = parseBoundedMetadataInteger('application_identity_column_count');
  const applicationSequenceDefaultCount = parseBoundedMetadataInteger('application_sequence_default_count');
  const unsupportedPublicObjectCount = parseBoundedMetadataInteger('unsupported_public_object_count');
  const largeObjectCount = parseBoundedMetadataInteger('large_object_count');
  const databaseEncoding = decodeCanonicalUtf8Hex(
    metadata.get('database_encoding_hex'),
    'database encoding',
    { maximumBytes: 32 },
  );
  const databaseCollation = decodeCanonicalUtf8Hex(
    metadata.get('database_collation_hex'),
    'database collation',
    { maximumBytes: 128 },
  );
  const databaseCtype = decodeCanonicalUtf8Hex(
    metadata.get('database_ctype_hex'),
    'database ctype',
    { maximumBytes: 128 },
  );
  const databaseLocaleProviderCode = metadata.get('database_locale_provider');
  const databaseCollationVersion = decodeCanonicalUtf8Hex(
    metadata.get('database_collation_version_hex'),
    'database collation version',
    { allowEmpty: true, maximumBytes: 256 },
  );
  const databaseEnvironment = requireRestorableDatabaseEnvironment({
    encoding: databaseEncoding,
    collation: databaseCollation,
    ctype: databaseCtype,
    localeProvider: databaseLocaleProviderCode === 'c' ? 'libc' : databaseLocaleProviderCode,
    collationVersion: databaseCollationVersion || null,
  });
  const capacityFieldNames = [
    'source_database_size_bytes',
    'capacity_required_bytes',
    'capacity_preflight_verified',
  ];
  const capacityFieldsPresent = capacityFieldNames.filter((field) => metadata.has(field));
  if (capacityFieldsPresent.length !== 0 && capacityFieldsPresent.length !== capacityFieldNames.length) {
    throw new Error('Fingerprint report contains incomplete source capacity preflight evidence');
  }
  let capacityPreflight;
  if (capacityFieldsPresent.length === capacityFieldNames.length) {
    const sourceDatabaseSizeBytes = metadata.get('source_database_size_bytes');
    const requiredAvailableBytes = metadata.get('capacity_required_bytes');
    requireCanonicalNonnegativeDecimal(sourceDatabaseSizeBytes, 'sourceDatabaseSizeBytes');
    const requiredBytes = requireCanonicalNonnegativeDecimal(requiredAvailableBytes, 'requiredAvailableBytes');
    if (metadata.get('capacity_preflight_verified') !== '1') {
      throw new Error('Fingerprint report did not verify its source capacity preflight');
    }
    if (requiredAvailableBytes !== calculateCapacityRequirement(sourceDatabaseSizeBytes)) {
      throw new Error('Fingerprint report source capacity requirement does not match the locked factor-and-margin formula');
    }
    if (requiredBytes > BigInt(MAX_DUMP_BYTES)) {
      throw new Error('Fingerprint report source capacity requirement exceeds maxDumpBytes');
    }
    capacityPreflight = {
      method: CAPACITY_PREFLIGHT_METHOD,
      sourceDatabaseSizeBytes,
      safetyFactor: CAPACITY_SAFETY_FACTOR,
      safetyMarginBytes: String(CAPACITY_SAFETY_MARGIN_BYTES),
      requiredAvailableBytes,
      maximumDumpBytes: String(MAX_DUMP_BYTES),
      verified: true,
    };
  }
  if (tables.length > maxPublicTables) throw new Error('Fingerprint report exceeds the configured public-table bound');
  if (publicSequenceCount !== 0 || applicationIdentityColumnCount !== 0 || applicationSequenceDefaultCount !== 0) {
    throw new Error(SEQUENCE_STATE_EXCLUSION_REASON);
  }
  if (unsupportedPublicObjectCount !== 0) {
    throw new Error('Fingerprint report found unsupported objects in the public schema');
  }
  if (largeObjectCount !== 0) {
    throw new Error('PostgreSQL large objects are excluded and proof requires zero large objects');
  }
  for (const table of tables) {
    if (BigInt(table.rowCount) > BigInt(maxRowsPerTable)) {
      throw new Error(`Fingerprint report table ${table.schema}.${table.table} exceeds the configured row bound`);
    }
  }

  const tableMembershipSha256 = canonicalSha256('charitypilot-public-table-membership/v2', [
    ...tables.map((table) => [
      table.schemaHex,
      table.tableHex,
      table.relationKind,
      table.isPartition ? '1' : '0',
    ].join('|')),
  ]);
  const publicSchemaSha256 = requireSha256(metadata.get('public_schema_sha256'), 'public schema fingerprint');
  const databaseFingerprintSha256 = canonicalSha256('charitypilot-database-fingerprint/v2', [
    databaseEnvironment.encoding,
    databaseEnvironment.collation,
    databaseEnvironment.ctype,
    databaseEnvironment.localeProvider,
    databaseEnvironment.collationVersion ?? '',
    tableMembershipSha256,
    publicSchemaSha256,
    ...tables.map((table) => [
      table.schemaHex,
      table.tableHex,
      table.relationKind,
      table.isPartition ? '1' : '0',
      table.rowCount,
      table.schemaSha256,
      table.rowsSha256,
      table.tableFingerprintSha256,
    ].join('|')),
  ]);
  const totalRows = tables.reduce((total, table) => total + BigInt(table.rowCount), 0n).toString();
  if (BigInt(totalRows) > BigInt(maxTotalRows)) {
    throw new Error('Fingerprint report exceeds the configured aggregate row bound');
  }

  return {
    snapshotSha256: requireSha256(metadata.get('source_snapshot_sha256'), 'source snapshot fingerprint'),
    databaseIdentitySha256: requireSha256(metadata.get('database_identity_sha256'), 'database identity fingerprint'),
    publicSchemaSha256,
    tableMembershipSha256,
    databaseFingerprintSha256,
    databaseEnvironment,
    tableCount: tables.length,
    totalRows,
    workloadSafety: {
      tempFileLimitBytes: String(tempFileLimitBytes),
      maxPublicTables,
      maxRowsPerTable,
      maxTotalRows,
      maxFingerprintReportBytes: MAX_FINGERPRINT_REPORT_BYTES,
    },
    schemaCoverage: {
      publicObjectCount,
      unsupportedPublicObjectCount,
      publicSequenceCount,
      applicationIdentityColumnCount,
      applicationSequenceDefaultCount,
      largeObjectCount,
    },
    ...(capacityPreflight ? { capacityPreflight } : {}),
    tables: tables.map(({ schemaHex, tableHex, ...table }) => table),
  };
}

export function compareDatabaseFingerprints(source, restored) {
  const mismatches = [];
  if (JSON.stringify(source.databaseEnvironment) !== JSON.stringify(restored.databaseEnvironment)) {
    mismatches.push('database encoding/collation environment');
  }
  if (source.tableMembershipSha256 !== restored.tableMembershipSha256) mismatches.push('public table membership');
  if (source.publicSchemaSha256 !== restored.publicSchemaSha256) mismatches.push('public schema');
  if (source.tableCount !== restored.tableCount) mismatches.push('table count');
  if (source.totalRows !== restored.totalRows) mismatches.push('total row count');
  if (source.databaseFingerprintSha256 !== restored.databaseFingerprintSha256) mismatches.push('database fingerprint');
  if (JSON.stringify(source.schemaCoverage) !== JSON.stringify(restored.schemaCoverage)) mismatches.push('schema coverage');
  if (JSON.stringify(source.workloadSafety) !== JSON.stringify(restored.workloadSafety)) mismatches.push('workload safety bounds');

  const tableKey = (table) => JSON.stringify([table.schema, table.table]);
  const tableName = (table) => `${table.schema}.${table.table}`;
  const sourceTables = new Map(source.tables.map((table) => [tableKey(table), table]));
  const restoredTables = new Map(restored.tables.map((table) => [tableKey(table), table]));
  for (const [key, table] of sourceTables) {
    const name = tableName(table);
    const candidate = restoredTables.get(key);
    if (!candidate) {
      mismatches.push(`missing table ${name}`);
      continue;
    }
    if (table.relationKind !== candidate.relationKind || table.isPartition !== candidate.isPartition) {
      mismatches.push(`relation kind ${name}`);
    }
    if (table.rowCount !== candidate.rowCount) mismatches.push(`row count ${name}`);
    if (table.schemaSha256 !== candidate.schemaSha256) mismatches.push(`schema ${name}`);
    if (table.rowsSha256 !== candidate.rowsSha256) mismatches.push(`rows ${name}`);
    if (table.tableFingerprintSha256 !== candidate.tableFingerprintSha256) mismatches.push(`table fingerprint ${name}`);
  }
  for (const [key, table] of restoredTables) {
    if (!sourceTables.has(key)) mismatches.push(`unexpected table ${tableName(table)}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Isolated restore fingerprint mismatch: ${mismatches.join(', ')}`);
  }
  return {
    databaseEnvironmentMatched: true,
    tableMembershipMatched: true,
    schemaMatched: true,
    rowCountsMatched: true,
    rowFingerprintsMatched: true,
    databaseFingerprintMatched: true,
    tablesCompared: source.tableCount,
    mismatchCount: 0,
  };
}

export function createSourceDumpBindingSha256({
  recoverySetId,
  sourceDatabaseIdentitySha256,
  helperImplementationSourceSha256,
  helperImplementationCommitSha,
  dumpSha256,
  dumpBytes,
  dumpDescriptorSha256,
  sourceDatabaseFingerprintSha256,
  sourceFingerprintReportSha256,
}) {
  return sha256Text([
    'charitypilot-source-dump-binding/v2',
    requireRecoverySetId(recoverySetId),
    requireSha256(sourceDatabaseIdentitySha256, 'source database identity'),
    requireSha256(helperImplementationSourceSha256, 'helper implementation source SHA-256'),
    /^[a-f0-9]{40}$/.test(helperImplementationCommitSha ?? '')
      ? helperImplementationCommitSha
      : 'unavailable',
    requireSha256(dumpSha256, 'dump SHA-256'),
    String(dumpBytes),
    requireSha256(dumpDescriptorSha256, 'dump descriptor SHA-256'),
    requireSha256(sourceDatabaseFingerprintSha256, 'source database fingerprint'),
    requireSha256(sourceFingerprintReportSha256, 'source fingerprint report'),
  ].join('\n'));
}

const SNAPSHOT_HOLDER_SCRIPT = String.raw`
set -eu
umask 077
case "$CHARITYPILOT_TEMP_FILE_LIMIT_KB" in ''|*[!0-9]*) echo 'Invalid temp-file safety limit.' >&2; exit 69 ;; esac
export PGOPTIONS="-c temp_file_limit=$CHARITYPILOT_TEMP_FILE_LIMIT_KB -c statement_timeout=30min -c lock_timeout=30s -c idle_in_transaction_session_timeout=44min"
holder_sql=$(mktemp)
cleanup_holder_sql() { rm -f "$holder_sql"; }
trap cleanup_holder_sql EXIT HUP INT TERM
cat > "$holder_sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'iso_8601';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '44min';
SELECT (
  current_setting('transaction_read_only') = 'on'
  AND current_setting('transaction_isolation') = 'repeatable read'
  AND current_setting('row_security') = 'off'
  AND current_setting('search_path') = 'pg_catalog'
  AND pg_catalog.pg_size_bytes(current_setting('temp_file_limit')) = :'temp_file_limit_bytes'::bigint
) AS settings_verified \gset
\if :settings_verified
\else
  \warn 'Required read-only snapshot settings were not applied.'
  DO $charitypilot$ BEGIN RAISE EXCEPTION 'Required read-only snapshot settings were not applied.'; END $charitypilot$;
\endif
SELECT format('LOCK TABLE ONLY %I.%I IN ACCESS SHARE MODE;', n.nspname, c.relname)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", c.oid
\gexec
SELECT (count(*) > 0) AS public_tables_present
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm')
\gset
\if :public_tables_present
\else
  \warn 'No public application tables were available to fingerprint.'
  DO $charitypilot$ BEGIN RAISE EXCEPTION 'No public application tables were available to fingerprint.'; END $charitypilot$;
\endif
SELECT pg_catalog.pg_export_snapshot() AS exported_snapshot \gset
\setenv CHARITYPILOT_EXPORTED_SNAPSHOT :exported_snapshot
\setenv CHARITYPILOT_SETTINGS_VERIFIED 1
\setenv CHARITYPILOT_ACCESS_SHARE_LOCKS_VERIFIED 1
\! sh -eu -c "$CHARITYPILOT_SNAPSHOT_ACTION"
\if :SHELL_ERROR
  \warn 'Snapshot-bound dump or fingerprint action failed.'
  DO $charitypilot$ BEGIN RAISE EXCEPTION 'Snapshot-bound dump or fingerprint action failed.'; END $charitypilot$;
\endif
COMMIT;
SQL
psql --no-psqlrc --set=temp_file_limit_bytes="$CHARITYPILOT_TEMP_FILE_LIMIT_BYTES" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$holder_sql"
`;

const IDENTITY_SNAPSHOT_HOLDER_SCRIPT = String.raw`
set -eu
umask 077
case "$CHARITYPILOT_TEMP_FILE_LIMIT_KB" in ''|*[!0-9]*) echo 'Invalid temp-file safety limit.' >&2; exit 69 ;; esac
export PGOPTIONS="-c temp_file_limit=$CHARITYPILOT_TEMP_FILE_LIMIT_KB -c statement_timeout=2min -c lock_timeout=15s -c idle_in_transaction_session_timeout=3min"
holder_sql=$(mktemp)
cleanup_holder_sql() { rm -f "$holder_sql"; }
trap cleanup_holder_sql EXIT HUP INT TERM
cat > "$holder_sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'iso_8601';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL statement_timeout = '2min';
SET LOCAL lock_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '3min';
SELECT (
  current_setting('transaction_read_only') = 'on'
  AND current_setting('transaction_isolation') = 'repeatable read'
  AND current_setting('row_security') = 'off'
  AND current_setting('search_path') = 'pg_catalog'
  AND pg_catalog.pg_size_bytes(current_setting('temp_file_limit')) = :'temp_file_limit_bytes'::bigint
) AS settings_verified \gset
\if :settings_verified
\else
  \warn 'Required read-only source identity settings were not applied.'
  DO $charitypilot$ BEGIN RAISE EXCEPTION 'Required read-only source identity settings were not applied.'; END $charitypilot$;
\endif
SELECT pg_catalog.pg_export_snapshot() AS exported_snapshot \gset
\setenv CHARITYPILOT_EXPORTED_SNAPSHOT :exported_snapshot
\! sh -eu -c "$CHARITYPILOT_SNAPSHOT_ACTION"
\if :SHELL_ERROR
  \warn 'Source identity capture action failed.'
  DO $charitypilot$ BEGIN RAISE EXCEPTION 'Source identity capture action failed.'; END $charitypilot$;
\endif
COMMIT;
SQL
psql --no-psqlrc --set=temp_file_limit_bytes="$CHARITYPILOT_TEMP_FILE_LIMIT_BYTES" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$holder_sql"
`;

const IDENTITY_ACTION_SCRIPT = String.raw`
set -eu
umask 077
snapshot="$CHARITYPILOT_EXPORTED_SNAPSHOT"
if ! printf '%s' "$snapshot" | grep -Eq '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]+$'; then
  echo 'Exported snapshot identifier failed strict validation.' >&2
  exit 74
fi
if ! printf '%s' "$CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
  echo 'Source endpoint identity digest failed strict validation.' >&2
  exit 74
fi
work_dir=$(mktemp -d)
cleanup_identity() { rm -rf "$work_dir"; }
trap cleanup_identity EXIT HUP INT TERM
identity_sql="$work_dir/identity.sql"
cat > "$identity_sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'iso_8601';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL statement_timeout = '90s';
SELECT pg_catalog.octet_length(bytes)::text || ':' || pg_catalog.encode(bytes, 'hex')
FROM (SELECT pg_catalog.convert_to(pg_catalog.jsonb_build_array(
  pg_catalog.current_setting('server_version_num'),
  pg_catalog.current_database(),
  current_user,
  databases.oid::text,
  databases.encoding::text,
  databases.datcollate,
  databases.datctype,
  coalesce(pg_catalog.inet_server_addr()::text, 'local-socket'),
  coalesce(pg_catalog.inet_server_port()::text, 'local-socket')
)::text, 'UTF8') AS bytes
FROM pg_catalog.pg_database databases
WHERE databases.datname = pg_catalog.current_database()) framed;
COMMIT;
SQL
stream_dir=$(mktemp -d)
fifo="$stream_dir/stream"
digest_file="$stream_dir/digest"
mkfifo "$fifo"
sha256sum "$fifo" > "$digest_file" &
hash_pid=$!
if (
  identity_domain='charitypilot-source-server-metadata/v1'
  identity_domain_bytes=$(printf '%s' "$identity_domain" | wc -c | tr -d ' ')
  printf 'charitypilot-sha256-frame/v2\n%s:%s\n' "$identity_domain_bytes" "$identity_domain"
  psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$identity_sql"
) > "$fifo"; then
  wait "$hash_pid"
else
  status=$?
  rm -f "$fifo"
  wait "$hash_pid" 2>/dev/null || true
  exit "$status"
fi
server_identity_sha=$(cut -d ' ' -f 1 "$digest_file")
rm -rf "$stream_dir"
database_identity_sha=$(printf 'charitypilot-source-database-identity/v1\n%s\n%s\n' "$CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256" "$server_identity_sha" | sha256sum | cut -d ' ' -f 1)
if [ -n "$CHARITYPILOT_RAW_REPORT_PATH" ]; then
  case "$CHARITYPILOT_RAW_REPORT_PATH" in /proof/*) ;; *) echo 'Unsafe identity output path.' >&2; exit 75 ;; esac
  printf 'identity|%s\n' "$database_identity_sha" > "$CHARITYPILOT_RAW_REPORT_PATH"
else
  printf 'identity|%s\n' "$database_identity_sha"
fi
`;

const DATABASE_FINGERPRINT_ACTION_SCRIPT = String.raw`
set -eu
umask 077
for value in "$CHARITYPILOT_TEMP_FILE_LIMIT_KB" "$CHARITYPILOT_TEMP_FILE_LIMIT_BYTES" "$CHARITYPILOT_MAX_PUBLIC_TABLES" "$CHARITYPILOT_MAX_ROWS_PER_TABLE" "$CHARITYPILOT_MAX_TOTAL_ROWS" "$CHARITYPILOT_MAX_FINGERPRINT_REPORT_BYTES" "$CHARITYPILOT_MAX_DUMP_BYTES" "$CHARITYPILOT_CAPACITY_SAFETY_FACTOR" "$CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES"; do
  case "$value" in ''|*[!0-9]*) echo 'Invalid fingerprint workload safety bound.' >&2; exit 69 ;; esac
done
snapshot="$CHARITYPILOT_EXPORTED_SNAPSHOT"
if ! printf '%s' "$snapshot" | grep -Eq '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]+$'; then
  echo 'Exported snapshot identifier failed strict validation.' >&2
  exit 74
fi
if ! printf '%s' "$CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
  echo 'Database endpoint identity digest failed strict validation.' >&2
  exit 74
fi
case "$CHARITYPILOT_RAW_REPORT_PATH" in /proof/*) ;; *) echo 'Unsafe fingerprint output path.' >&2; exit 75 ;; esac
work_dir=$(mktemp -d)
cleanup_fingerprint() { rm -rf "$work_dir"; }
trap cleanup_fingerprint EXIT HUP INT TERM

cat > "$work_dir/table-list.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '5min';
SELECT pg_catalog.encode(pg_catalog.convert_to(n.nspname, 'UTF8'), 'hex') || '|' ||
       pg_catalog.encode(pg_catalog.convert_to(c.relname, 'UTF8'), 'hex') || '|' ||
       c.relkind::text || '|' || CASE WHEN c.relispartition THEN '1' ELSE '0' END || '|' ||
       CASE WHEN pg_catalog.has_table_privilege(c.oid, 'SELECT') THEN '1' ELSE '0' END
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", c.oid;
COMMIT;
SQL

cat > "$work_dir/count.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '30min';
SELECT pg_catalog.format('SELECT count(*) FROM ONLY %I.%I;',
  pg_catalog.convert_from(pg_catalog.decode(:'schema_hex', 'hex'), 'UTF8'),
  pg_catalog.convert_from(pg_catalog.decode(:'table_hex', 'hex'), 'UTF8')) \gexec
COMMIT;
SQL

cat > "$work_dir/rows.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'iso_8601';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL statement_timeout = '30min';
SELECT pg_catalog.format(
  'COPY (SELECT pg_catalog.octet_length(framed.bytes)::text || '':'' || pg_catalog.encode(framed.bytes, ''hex'') FROM (SELECT pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, ''UTF8'') AS bytes FROM ONLY %I.%I AS t) framed ORDER BY framed.bytes) TO STDOUT;',
  pg_catalog.convert_from(pg_catalog.decode(:'schema_hex', 'hex'), 'UTF8'),
  pg_catalog.convert_from(pg_catalog.decode(:'table_hex', 'hex'), 'UTF8')) \gexec
COMMIT;
SQL

cat > "$work_dir/table-schema.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '10min';
WITH target AS (
  SELECT c.oid, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
         c.relispartition, c.relpartbound, c.relreplident, c.relispopulated,
         c.reloptions, c.relam, c.reltablespace, n.nspname, c.relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE pg_catalog.encode(pg_catalog.convert_to(n.nspname, 'UTF8'), 'hex') = :'schema_hex'
    AND pg_catalog.encode(pg_catalog.convert_to(c.relname, 'UTF8'), 'hex') = :'table_hex'
    AND c.relkind IN ('r', 'p', 'm')
), descriptors AS (
  SELECT pg_catalog.jsonb_build_array(
         'relation', target.relkind::text, target.relpersistence::text,
         target.relrowsecurity, target.relforcerowsecurity, target.relispartition,
         coalesce(pg_catalog.pg_get_partkeydef(target.oid), ''),
         coalesce(pg_catalog.pg_get_expr(target.relpartbound, target.oid, true), ''),
         target.relreplident::text, target.relispopulated,
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(target.reloptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce((SELECT access_methods.amname FROM pg_catalog.pg_am access_methods WHERE access_methods.oid = target.relam), ''),
         coalesce((SELECT tablespaces.spcname FROM pg_catalog.pg_tablespace tablespaces WHERE tablespaces.oid = target.reltablespace), ''),
         coalesce((
           SELECT pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_array(parent_names.nspname, parents.relname)
             ORDER BY parent_names.nspname COLLATE "C", parents.relname COLLATE "C"
           )
           FROM pg_catalog.pg_inherits inheritance
           JOIN pg_catalog.pg_class parents ON parents.oid = inheritance.inhparent
           JOIN pg_catalog.pg_namespace parent_names ON parent_names.oid = parents.relnamespace
           WHERE inheritance.inhrelid = target.oid
         ), '[]'::pg_catalog.jsonb)
       )::text AS descriptor
  FROM target
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'attribute', attributes.attnum, attributes.attname,
         pg_catalog.format_type(attributes.atttypid, attributes.atttypmod),
         attributes.attnotnull, attributes.attidentity, attributes.attgenerated,
         attributes.attisdropped, attributes.attstorage::text,
         attributes.attcompression::text, attributes.attstattarget,
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(attributes.attoptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(attributes.attfdwoptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce(pg_catalog.pg_get_expr(defaults.adbin, defaults.adrelid, true), ''),
         coalesce(collation_names.nspname, ''), coalesce(collations.collname, '')
       )::text
  FROM target
  JOIN pg_catalog.pg_attribute attributes ON attributes.attrelid = target.oid AND attributes.attnum > 0
  LEFT JOIN pg_catalog.pg_attrdef defaults ON defaults.adrelid = target.oid AND defaults.adnum = attributes.attnum
  LEFT JOIN pg_catalog.pg_collation collations ON collations.oid = attributes.attcollation
  LEFT JOIN pg_catalog.pg_namespace collation_names ON collation_names.oid = collations.collnamespace
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'constraint', constraints.conname, constraints.contype::text,
         constraints.condeferrable, constraints.condeferred, constraints.convalidated,
         constraints.connoinherit, constraints.conkey, constraints.confkey,
         pg_catalog.pg_get_constraintdef(constraints.oid, true)
       )::text
  FROM target
  JOIN pg_catalog.pg_constraint constraints ON constraints.conrelid = target.oid
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'index', indexes.relname, index_rows.indisunique, index_rows.indisprimary,
         index_rows.indisexclusion, index_rows.indimmediate, index_rows.indisvalid,
         index_rows.indisready, index_rows.indislive, index_rows.indisclustered,
         index_rows.indisreplident,
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(indexes.reloptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce(index_access_methods.amname, ''), coalesce(index_tablespaces.spcname, ''),
         pg_catalog.pg_get_indexdef(index_rows.indexrelid)
       )::text
  FROM target
  JOIN pg_catalog.pg_index index_rows ON index_rows.indrelid = target.oid
  JOIN pg_catalog.pg_class indexes ON indexes.oid = index_rows.indexrelid
  LEFT JOIN pg_catalog.pg_am index_access_methods ON index_access_methods.oid = indexes.relam
  LEFT JOIN pg_catalog.pg_tablespace index_tablespaces ON index_tablespaces.oid = indexes.reltablespace
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'trigger', triggers.tgname, triggers.tgenabled::text,
         pg_catalog.pg_get_triggerdef(triggers.oid, true)
       )::text
  FROM target
  JOIN pg_catalog.pg_trigger triggers ON triggers.tgrelid = target.oid AND NOT triggers.tgisinternal
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'policy', policies.polname, policies.polcmd::text, policies.polpermissive,
         coalesce((
           SELECT pg_catalog.jsonb_agg(
             CASE WHEN role_ids.oid = 0 THEN 'PUBLIC' ELSE coalesce(roles.rolname, '<UNKNOWN-ROLE-OID>') END
             ORDER BY CASE WHEN role_ids.oid = 0 THEN 'PUBLIC' ELSE coalesce(roles.rolname, '<UNKNOWN-ROLE-OID>') END COLLATE "C"
           )
           FROM pg_catalog.unnest(policies.polroles) AS role_ids(oid)
           LEFT JOIN pg_catalog.pg_roles roles ON roles.oid = role_ids.oid
         ), '[]'::pg_catalog.jsonb),
         coalesce(pg_catalog.pg_get_expr(policies.polqual, policies.polrelid, true), ''),
         coalesce(pg_catalog.pg_get_expr(policies.polwithcheck, policies.polrelid, true), '')
       )::text
  FROM target
  JOIN pg_catalog.pg_policy policies ON policies.polrelid = target.oid
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'owned-sequence', sequence_names.nspname, sequences.relname,
         sequence_data.seqtypid::pg_catalog.regtype::text,
         sequence_data.seqstart, sequence_data.seqincrement, sequence_data.seqmax,
         sequence_data.seqmin, sequence_data.seqcache, sequence_data.seqcycle,
         dependencies.refobjsubid
       )::text
  FROM target
  JOIN pg_catalog.pg_depend dependencies ON dependencies.refobjid = target.oid
    AND dependencies.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dependencies.deptype IN ('a', 'i')
  JOIN pg_catalog.pg_class sequences ON sequences.oid = dependencies.objid AND sequences.relkind = 'S'
  JOIN pg_catalog.pg_namespace sequence_names ON sequence_names.oid = sequences.relnamespace
  JOIN pg_catalog.pg_sequence sequence_data ON sequence_data.seqrelid = sequences.oid
)
SELECT pg_catalog.octet_length(bytes)::text || ':' || pg_catalog.encode(bytes, 'hex')
FROM (
  SELECT pg_catalog.convert_to(descriptor, 'UTF8') AS bytes
  FROM descriptors
  ORDER BY descriptor COLLATE "C"
) framed
ORDER BY bytes;
COMMIT;
SQL

cat > "$work_dir/public-schema.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '10min';
WITH descriptors AS (
  SELECT pg_catalog.jsonb_build_array(
         'relation', n.nspname, c.relname, c.relkind::text, c.relpersistence::text,
         c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
         coalesce(pg_catalog.pg_get_partkeydef(c.oid), ''),
         coalesce(pg_catalog.pg_get_expr(c.relpartbound, c.oid, true), ''),
         c.relreplident::text, c.relispopulated,
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(c.reloptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce(access_methods.amname, ''), coalesce(tablespaces.spcname, ''),
         coalesce((
           SELECT pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_array(parent_names.nspname, parents.relname)
             ORDER BY parent_names.nspname COLLATE "C", parents.relname COLLATE "C"
           )
           FROM pg_catalog.pg_inherits inheritance
           JOIN pg_catalog.pg_class parents ON parents.oid = inheritance.inhparent
           JOIN pg_catalog.pg_namespace parent_names ON parent_names.oid = parents.relnamespace
           WHERE inheritance.inhrelid = c.oid
         ), '[]'::pg_catalog.jsonb),
         CASE WHEN c.relkind IN ('v', 'm') THEN coalesce(pg_catalog.pg_get_viewdef(c.oid, true), '') ELSE '' END
       )::text AS descriptor
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_am access_methods ON access_methods.oid = c.relam
  LEFT JOIN pg_catalog.pg_tablespace tablespaces ON tablespaces.oid = c.reltablespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'sequence', n.nspname, c.relname, sequence_data.seqtypid::pg_catalog.regtype::text,
         sequence_data.seqstart, sequence_data.seqincrement, sequence_data.seqmax,
         sequence_data.seqmin, sequence_data.seqcache, sequence_data.seqcycle,
         coalesce(owner_names.nspname, ''), coalesce(owner_tables.relname, ''),
         coalesce(dependencies.refobjsubid, 0)
       )::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_sequence sequence_data ON sequence_data.seqrelid = c.oid
  LEFT JOIN pg_catalog.pg_depend dependencies ON dependencies.objid = c.oid
    AND dependencies.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dependencies.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND dependencies.deptype IN ('a', 'i')
  LEFT JOIN pg_catalog.pg_class owner_tables ON owner_tables.oid = dependencies.refobjid
  LEFT JOIN pg_catalog.pg_namespace owner_names ON owner_names.oid = owner_tables.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'type', n.nspname, types.typname, types.typtype::text, types.typcategory::text,
         types.typispreferred, types.typbyval, types.typdelim::text,
         types.typelem::pg_catalog.regtype::text, types.typarray::pg_catalog.regtype::text,
         types.typalign::text, types.typstorage::text, types.typnotnull,
         types.typbasetype::pg_catalog.regtype::text, types.typtypmod, types.typndims,
         types.typcollation::pg_catalog.regcollation::text,
         coalesce(types.typdefaultbin::text, ''), coalesce(types.typdefault, ''),
         coalesce(ranges.rngsubtype::pg_catalog.regtype::text, ''),
         coalesce(ranges.rngcollation::pg_catalog.regcollation::text, ''),
         coalesce(ranges.rngcanonical::pg_catalog.regprocedure::text, ''),
         coalesce(ranges.rngsubdiff::pg_catalog.regprocedure::text, '')
       )::text
  FROM pg_catalog.pg_type types
  JOIN pg_catalog.pg_namespace n ON n.oid = types.typnamespace
  LEFT JOIN pg_catalog.pg_range ranges ON ranges.rngtypid = types.oid
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class type_relations
      WHERE type_relations.reltype = types.oid AND type_relations.relkind IN ('r', 'p', 'v', 'm', 'S')
    )
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'enum-label', n.nspname, types.typname, enums.enumsortorder, enums.enumlabel
       )::text
  FROM pg_catalog.pg_type types
  JOIN pg_catalog.pg_namespace n ON n.oid = types.typnamespace
  JOIN pg_catalog.pg_enum enums ON enums.enumtypid = types.oid
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'composite-attribute', n.nspname, types.typname, attributes.attnum,
         attributes.attname, pg_catalog.format_type(attributes.atttypid, attributes.atttypmod),
         attributes.attnotnull, attributes.attisdropped,
         coalesce(collation_names.nspname, ''), coalesce(collations.collname, '')
       )::text
  FROM pg_catalog.pg_type types
  JOIN pg_catalog.pg_namespace n ON n.oid = types.typnamespace
  JOIN pg_catalog.pg_class composites ON composites.oid = types.typrelid AND composites.relkind = 'c'
  JOIN pg_catalog.pg_attribute attributes ON attributes.attrelid = composites.oid AND attributes.attnum > 0
  LEFT JOIN pg_catalog.pg_collation collations ON collations.oid = attributes.attcollation
  LEFT JOIN pg_catalog.pg_namespace collation_names ON collation_names.oid = collations.collnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'routine', n.nspname, routines.proname, routines.prokind::text,
         pg_catalog.pg_get_function_identity_arguments(routines.oid),
         pg_catalog.pg_get_function_arguments(routines.oid),
         pg_catalog.pg_get_function_result(routines.oid),
         languages.lanname, routines.prosrc, coalesce(routines.probin, ''),
         routines.prosecdef, routines.proleakproof, routines.proisstrict,
         routines.provolatile::text, routines.proparallel::text,
         routines.procost, routines.prorows,
         CASE WHEN routines.prosupport = 0 THEN '' ELSE routines.prosupport::pg_catalog.regprocedure::text END,
         coalesce(routines.proconfig, ARRAY[]::text[]),
         pg_catalog.pg_get_functiondef(routines.oid)
       )::text
  FROM pg_catalog.pg_proc routines
  JOIN pg_catalog.pg_namespace n ON n.oid = routines.pronamespace
  JOIN pg_catalog.pg_language languages ON languages.oid = routines.prolang
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'constraint', n.nspname, constraints.conname, constraints.contype::text,
         coalesce(relations.relname, ''), coalesce(types.typname, ''),
         constraints.condeferrable, constraints.condeferred, constraints.convalidated,
         constraints.connoinherit, pg_catalog.pg_get_constraintdef(constraints.oid, true)
       )::text
  FROM pg_catalog.pg_constraint constraints
  JOIN pg_catalog.pg_namespace n ON n.oid = constraints.connamespace
  LEFT JOIN pg_catalog.pg_class relations ON relations.oid = constraints.conrelid
  LEFT JOIN pg_catalog.pg_type types ON types.oid = constraints.contypid
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'index', n.nspname, indexes.relname, tables.relname,
         index_rows.indisunique, index_rows.indisprimary, index_rows.indisexclusion,
         index_rows.indimmediate, index_rows.indisvalid, index_rows.indisready,
         index_rows.indislive, index_rows.indisclustered, index_rows.indisreplident,
         coalesce((
           SELECT pg_catalog.jsonb_agg(options.option_value ORDER BY options.option_value COLLATE "C")
           FROM pg_catalog.unnest(indexes.reloptions) AS options(option_value)
         ), '[]'::pg_catalog.jsonb),
         coalesce(index_access_methods.amname, ''), coalesce(index_tablespaces.spcname, ''),
         pg_catalog.pg_get_indexdef(indexes.oid)
       )::text
  FROM pg_catalog.pg_index index_rows
  JOIN pg_catalog.pg_class indexes ON indexes.oid = index_rows.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = indexes.relnamespace
  JOIN pg_catalog.pg_class tables ON tables.oid = index_rows.indrelid
  LEFT JOIN pg_catalog.pg_am index_access_methods ON index_access_methods.oid = indexes.relam
  LEFT JOIN pg_catalog.pg_tablespace index_tablespaces ON index_tablespaces.oid = indexes.reltablespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'trigger', n.nspname, tables.relname, triggers.tgname,
         triggers.tgenabled::text, pg_catalog.pg_get_triggerdef(triggers.oid, true)
       )::text
  FROM pg_catalog.pg_trigger triggers
  JOIN pg_catalog.pg_class tables ON tables.oid = triggers.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = tables.relnamespace
  WHERE n.nspname = 'public' AND NOT triggers.tgisinternal
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'policy', n.nspname, tables.relname, policies.polname, policies.polcmd::text,
         policies.polpermissive,
         coalesce((
           SELECT pg_catalog.jsonb_agg(
             CASE WHEN role_ids.oid = 0 THEN 'PUBLIC' ELSE coalesce(roles.rolname, '<UNKNOWN-ROLE-OID>') END
             ORDER BY CASE WHEN role_ids.oid = 0 THEN 'PUBLIC' ELSE coalesce(roles.rolname, '<UNKNOWN-ROLE-OID>') END COLLATE "C"
           )
           FROM pg_catalog.unnest(policies.polroles) AS role_ids(oid)
           LEFT JOIN pg_catalog.pg_roles roles ON roles.oid = role_ids.oid
         ), '[]'::pg_catalog.jsonb),
         coalesce(pg_catalog.pg_get_expr(policies.polqual, policies.polrelid, true), ''),
         coalesce(pg_catalog.pg_get_expr(policies.polwithcheck, policies.polrelid, true), '')
       )::text
  FROM pg_catalog.pg_policy policies
  JOIN pg_catalog.pg_class tables ON tables.oid = policies.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = tables.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'extended-statistics', n.nspname, statistics.stxname,
         statistics.stxkind, statistics.stxkeys,
         pg_catalog.pg_get_statisticsobjdef(statistics.oid)
       )::text
  FROM pg_catalog.pg_statistic_ext statistics
  JOIN pg_catalog.pg_namespace n ON n.oid = statistics.stxnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT pg_catalog.jsonb_build_array(
         'rule', n.nspname, relations.relname, rules.rulename,
         rules.ev_enabled::text, pg_catalog.pg_get_ruledef(rules.oid, true)
       )::text
  FROM pg_catalog.pg_rewrite rules
  JOIN pg_catalog.pg_class relations ON relations.oid = rules.ev_class
  JOIN pg_catalog.pg_namespace n ON n.oid = relations.relnamespace
  WHERE n.nspname = 'public' AND rules.rulename <> '_RETURN'
)
SELECT pg_catalog.octet_length(bytes)::text || ':' || pg_catalog.encode(bytes, 'hex')
FROM (
  SELECT pg_catalog.convert_to(descriptor, 'UTF8') AS bytes
  FROM descriptors
  ORDER BY descriptor COLLATE "C"
) framed
ORDER BY bytes;
COMMIT;
SQL

cat > "$work_dir/schema-coverage.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '2min';
SELECT
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S')::text || '|' ||
  (SELECT count(*) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> '')::text || '|' ||
  (SELECT count(*) FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) LIKE '%nextval(%')::text || '|' ||
  (
    (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind NOT IN ('r', 'p', 'v', 'm', 'S', 'i', 'I', 'c')) +
    (SELECT count(*) FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid = o.opfnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_ts_config o JOIN pg_catalog.pg_namespace n ON n.oid = o.cfgnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_ts_dict o JOIN pg_catalog.pg_namespace n ON n.oid = o.dictnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_ts_parser o JOIN pg_catalog.pg_namespace n ON n.oid = o.prsnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_ts_template o JOIN pg_catalog.pg_namespace n ON n.oid = o.tmplnamespace WHERE n.nspname = 'public') +
    (SELECT count(*) FROM pg_catalog.pg_policy p
     CROSS JOIN LATERAL pg_catalog.unnest(p.polroles) AS role_ids(oid)
     LEFT JOIN pg_catalog.pg_roles roles ON roles.oid = role_ids.oid
     WHERE role_ids.oid <> 0 AND roles.oid IS NULL)
  )::text || '|' ||
  (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata)::text;
COMMIT;
SQL

cat > "$work_dir/identity.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '90s';
SELECT pg_catalog.octet_length(bytes)::text || ':' || pg_catalog.encode(bytes, 'hex')
FROM (SELECT pg_catalog.convert_to(pg_catalog.jsonb_build_array(
  pg_catalog.current_setting('server_version_num'), pg_catalog.current_database(), current_user,
  databases.oid::text, databases.encoding::text, databases.datcollate, databases.datctype,
  coalesce(pg_catalog.inet_server_addr()::text, 'local-socket'),
  coalesce(pg_catalog.inet_server_port()::text, 'local-socket')
)::text, 'UTF8') AS bytes
FROM pg_catalog.pg_database databases WHERE databases.datname = pg_catalog.current_database()) framed;
COMMIT;
SQL

cat > "$work_dir/database-environment.sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '90s';
SELECT
  pg_catalog.encode(pg_catalog.convert_to(pg_catalog.pg_encoding_to_char(databases.encoding), 'UTF8'), 'hex') || '|' ||
  pg_catalog.encode(pg_catalog.convert_to(databases.datcollate, 'UTF8'), 'hex') || '|' ||
  pg_catalog.encode(pg_catalog.convert_to(databases.datctype, 'UTF8'), 'hex') || '|' ||
  databases.datlocprovider::text || '|' ||
  pg_catalog.encode(pg_catalog.convert_to(coalesce(databases.datcollversion, ''), 'UTF8'), 'hex')
FROM pg_catalog.pg_database databases
WHERE databases.datname = pg_catalog.current_database();
COMMIT;
SQL

hash_query() {
  domain="$1"
  sql_file="$2"
  schema_hex=''
  table_hex=''
  if [ "$#" -ge 3 ]; then schema_hex="$3"; fi
  if [ "$#" -ge 4 ]; then table_hex="$4"; fi
  stream_dir=$(mktemp -d)
  fifo="$stream_dir/stream"
  digest_file="$stream_dir/digest"
  mkfifo "$fifo"
  sha256sum "$fifo" > "$digest_file" &
  hash_pid=$!
  if (
    domain_bytes=$(printf '%s' "$domain" | wc -c | tr -d ' ')
    printf 'charitypilot-sha256-frame/v2\n%s:%s\n' "$domain_bytes" "$domain"
    psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --set=schema_hex="$schema_hex" --set=table_hex="$table_hex" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$sql_file"
  ) > "$fifo"; then
    wait "$hash_pid"
  else
    status=$?
    rm -f "$fifo"
    wait "$hash_pid" 2>/dev/null || true
    rm -rf "$stream_dir"
    exit "$status"
  fi
  cut -d ' ' -f 1 "$digest_file"
  rm -rf "$stream_dir"
}

table_records=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$work_dir/table-list.sql")
if [ -z "$table_records" ]; then echo 'No public application tables were fingerprinted.' >&2; exit 76; fi
if [ "$(printf '%s' "$table_records" | wc -c)" -gt 8388608 ]; then echo 'Public table membership exceeds safety bound.' >&2; exit 76; fi
table_count=$(printf '%s\n' "$table_records" | wc -l | tr -d ' ')
if [ "$table_count" -gt "$CHARITYPILOT_MAX_PUBLIC_TABLES" ]; then echo "Public table count exceeds safety bound ($CHARITYPILOT_MAX_PUBLIC_TABLES)." >&2; exit 76; fi
schema_coverage=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$work_dir/schema-coverage.sql")
IFS='|' read -r public_sequence_count identity_column_count sequence_default_count unsupported_object_count large_object_count <<EOF
$schema_coverage
EOF
for value in "$public_sequence_count" "$identity_column_count" "$sequence_default_count" "$unsupported_object_count" "$large_object_count"; do
  case "$value" in ''|*[!0-9]*) echo 'Invalid public schema coverage count.' >&2; exit 76 ;; esac
done
if [ "$unsupported_object_count" -ne 0 ]; then echo 'Unsupported public schema object kind detected; extend the canonical descriptor before proving restore.' >&2; exit 76; fi
if [ "$large_object_count" -ne 0 ]; then echo 'PostgreSQL large objects are excluded; proof requires zero large objects.' >&2; exit 76; fi
if [ "$public_sequence_count" -ne 0 ] || [ "$identity_column_count" -ne 0 ] || [ "$sequence_default_count" -ne 0 ]; then
  echo 'PostgreSQL sequence values are non-MVCC; proof requires zero public sequences, identity columns, and nextval defaults.' >&2
  exit 76
fi
database_environment=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$work_dir/database-environment.sql")
IFS='|' read -r database_encoding_hex database_collation_hex database_ctype_hex database_locale_provider database_collation_version_hex database_environment_extra <<EOF
$database_environment
EOF
for value in "$database_encoding_hex" "$database_collation_hex" "$database_ctype_hex"; do
  if ! printf '%s' "$value" | grep -Eq '^([0-9a-f]{2})+$'; then echo 'Database encoding/collation metadata was not canonical UTF-8 hex.' >&2; exit 76; fi
done
if [ -n "$database_collation_version_hex" ] && ! printf '%s' "$database_collation_version_hex" | grep -Eq '^([0-9a-f]{2})+$'; then
  echo 'Database collation version was not canonical UTF-8 hex.' >&2
  exit 76
fi
if [ "$database_locale_provider" != 'c' ]; then
  echo 'Unsupported database locale provider; restore proof currently requires libc.' >&2
  exit 76
fi
if [ -n "$database_environment_extra" ]; then echo 'Database environment metadata contained unexpected fields.' >&2; exit 76; fi
snapshot_sha=$(printf 'charitypilot-exported-snapshot/v1\n%s\n' "$snapshot" | sha256sum | cut -d ' ' -f 1)
server_identity_sha=$(hash_query 'charitypilot-source-server-metadata/v1' "$work_dir/identity.sql")
database_identity_sha=$(printf 'charitypilot-source-database-identity/v1\n%s\n%s\n' "$CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256" "$server_identity_sha" | sha256sum | cut -d ' ' -f 1)
public_schema_sha=$(hash_query 'charitypilot-public-schema-descriptor/v2' "$work_dir/public-schema.sql")
public_object_count=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$work_dir/public-schema.sql" | wc -l | tr -d ' ')
if ! printf '%s' "$public_object_count" | grep -Eq '^[1-9][0-9]*$'; then echo 'Canonical public schema descriptor is empty.' >&2; exit 76; fi
raw_tmp="$CHARITYPILOT_RAW_REPORT_PATH.partial"
rm -f "$raw_tmp"
printf 'meta|source_snapshot_sha256|%s\n' "$snapshot_sha" > "$raw_tmp"
printf 'meta|database_identity_sha256|%s\n' "$database_identity_sha" >> "$raw_tmp"
printf 'meta|database_encoding_hex|%s\n' "$database_encoding_hex" >> "$raw_tmp"
printf 'meta|database_collation_hex|%s\n' "$database_collation_hex" >> "$raw_tmp"
printf 'meta|database_ctype_hex|%s\n' "$database_ctype_hex" >> "$raw_tmp"
printf 'meta|database_locale_provider|%s\n' "$database_locale_provider" >> "$raw_tmp"
printf 'meta|database_collation_version_hex|%s\n' "$database_collation_version_hex" >> "$raw_tmp"
printf 'meta|public_schema_sha256|%s\n' "$public_schema_sha" >> "$raw_tmp"
printf 'meta|settings_verified|%s\n' "$CHARITYPILOT_SETTINGS_VERIFIED" >> "$raw_tmp"
printf 'meta|access_share_locks_verified|%s\n' "$CHARITYPILOT_ACCESS_SHARE_LOCKS_VERIFIED" >> "$raw_tmp"
printf 'meta|temp_file_limit_bytes|%s\n' "$CHARITYPILOT_TEMP_FILE_LIMIT_BYTES" >> "$raw_tmp"
printf 'meta|max_public_tables|%s\n' "$CHARITYPILOT_MAX_PUBLIC_TABLES" >> "$raw_tmp"
printf 'meta|max_rows_per_table|%s\n' "$CHARITYPILOT_MAX_ROWS_PER_TABLE" >> "$raw_tmp"
printf 'meta|max_total_rows|%s\n' "$CHARITYPILOT_MAX_TOTAL_ROWS" >> "$raw_tmp"
printf 'meta|public_object_count|%s\n' "$public_object_count" >> "$raw_tmp"
printf 'meta|public_sequence_count|%s\n' "$public_sequence_count" >> "$raw_tmp"
printf 'meta|application_identity_column_count|%s\n' "$identity_column_count" >> "$raw_tmp"
printf 'meta|application_sequence_default_count|%s\n' "$sequence_default_count" >> "$raw_tmp"
printf 'meta|unsupported_public_object_count|%s\n' "$unsupported_object_count" >> "$raw_tmp"
printf 'meta|large_object_count|%s\n' "$large_object_count" >> "$raw_tmp"
if [ "$CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED" = '1' ]; then
  for value in "$CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES" "$CHARITYPILOT_CAPACITY_REQUIRED_BYTES"; do
    case "$value" in ''|*[!0-9]*) echo 'Invalid source capacity preflight evidence.' >&2; exit 78 ;; esac
  done
  printf 'meta|source_database_size_bytes|%s\n' "$CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES" >> "$raw_tmp"
  printf 'meta|capacity_required_bytes|%s\n' "$CHARITYPILOT_CAPACITY_REQUIRED_BYTES" >> "$raw_tmp"
  printf 'meta|capacity_preflight_verified|1\n' >> "$raw_tmp"
elif [ -n "$CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES$CHARITYPILOT_CAPACITY_REQUIRED_BYTES$CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED" ]; then
  echo 'Incomplete source capacity preflight evidence.' >&2
  exit 78
fi
total_rows=0
printf '%s\n' "$table_records" | while IFS='|' read -r schema_hex table_hex relation_kind partition_flag readable_flag; do
  if [ "$readable_flag" != '1' ]; then echo 'A public application table is not readable without row filtering.' >&2; exit 77; fi
  row_count=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$snapshot" --set=schema_hex="$schema_hex" --set=table_hex="$table_hex" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$work_dir/count.sql")
  if ! printf '%s' "$row_count" | grep -Eq '^(0|[1-9][0-9]*)$'; then echo 'Invalid table row count.' >&2; exit 78; fi
  if [ "$row_count" -gt "$CHARITYPILOT_MAX_ROWS_PER_TABLE" ]; then echo "A public table exceeds the per-table row safety bound ($CHARITYPILOT_MAX_ROWS_PER_TABLE)." >&2; exit 78; fi
  total_rows=$((total_rows + row_count))
  if [ "$total_rows" -gt "$CHARITYPILOT_MAX_TOTAL_ROWS" ]; then echo "Aggregate public row count exceeds safety bound ($CHARITYPILOT_MAX_TOTAL_ROWS)." >&2; exit 78; fi
  schema_sha=$(hash_query "charitypilot-table-schema/v2:$schema_hex:$table_hex" "$work_dir/table-schema.sql" "$schema_hex" "$table_hex")
  rows_sha=$(hash_query "charitypilot-table-rows/v2:$schema_hex:$table_hex" "$work_dir/rows.sql" "$schema_hex" "$table_hex")
  printf 'table|%s|%s|%s|%s|%s|%s|%s|%s\n' "$schema_hex" "$table_hex" "$relation_kind" "$partition_flag" "$readable_flag" "$row_count" "$schema_sha" "$rows_sha" >> "$raw_tmp"
  if [ "$(wc -c < "$raw_tmp")" -gt "$CHARITYPILOT_MAX_FINGERPRINT_REPORT_BYTES" ]; then echo 'Fingerprint report exceeds its configured byte bound.' >&2; exit 78; fi
done
mv "$raw_tmp" "$CHARITYPILOT_RAW_REPORT_PATH"
`;

const SOURCE_PROOF_ACTION_SCRIPT = String.raw`
set -eu
case "$CHARITYPILOT_DUMP_PATH" in /proof/*) ;; *) echo 'Unsafe dump output path.' >&2; exit 75 ;; esac
for value in "$CHARITYPILOT_MAX_DUMP_BYTES" "$CHARITYPILOT_CAPACITY_SAFETY_FACTOR" "$CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES"; do
  case "$value" in ''|*[!0-9]*) echo 'Invalid capacity preflight bound.' >&2; exit 75 ;; esac
done
if [ "$CHARITYPILOT_CAPACITY_SAFETY_FACTOR" -lt 1 ] || [ "$CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES" -gt "$CHARITYPILOT_MAX_DUMP_BYTES" ]; then
  echo 'Unsafe capacity preflight factor or margin.' >&2
  exit 75
fi
size_sql=$(mktemp)
cat > "$size_sql" <<'SQL'
\set ON_ERROR_STOP on
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '2min';
SELECT pg_catalog.pg_database_size(pg_catalog.current_database());
COMMIT;
SQL
source_database_size_bytes=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --set=snapshot="$CHARITYPILOT_EXPORTED_SNAPSHOT" --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --file "$size_sql" | tr -d '[:space:]')
rm -f "$size_sql"
case "$source_database_size_bytes" in ''|*[!0-9]*) echo 'Read-only source database size was not a canonical decimal integer.' >&2; exit 75 ;; esac
cap_threshold=$(( (CHARITYPILOT_MAX_DUMP_BYTES - CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES) / CHARITYPILOT_CAPACITY_SAFETY_FACTOR ))
if [ "$source_database_size_bytes" -gt "$cap_threshold" ]; then
  capacity_required_bytes="$CHARITYPILOT_MAX_DUMP_BYTES"
else
  capacity_required_bytes=$(( source_database_size_bytes * CHARITYPILOT_CAPACITY_SAFETY_FACTOR + CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES ))
fi
available_kb=$(df -Pk /proof | awk 'NR == 2 { print $4 }')
case "$available_kb" in ''|*[!0-9]*) echo 'Could not preflight proof output filesystem capacity.' >&2; exit 75 ;; esac
required_kb=$(( (capacity_required_bytes + 1023) / 1024 ))
if [ "$available_kb" -lt "$required_kb" ]; then echo 'Proof output filesystem does not have the source-size-aware required capacity.' >&2; exit 75; fi
export CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES="$source_database_size_bytes"
export CHARITYPILOT_CAPACITY_REQUIRED_BYTES="$capacity_required_bytes"
export CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED=1
file_limit_blocks=$(( (CHARITYPILOT_MAX_DUMP_BYTES + 511) / 512 ))
ulimit -f "$file_limit_blocks"
pg_dump --dbname "$CHARITYPILOT_PROOF_DATABASE_URL" --snapshot "$CHARITYPILOT_EXPORTED_SNAPSHOT" --format=custom --no-owner --no-privileges --no-blobs --lock-wait-timeout=30000 --file "$CHARITYPILOT_DUMP_PATH"
dump_bytes=$(wc -c < "$CHARITYPILOT_DUMP_PATH" | tr -d ' ')
if [ "$dump_bytes" -gt "$CHARITYPILOT_MAX_DUMP_BYTES" ]; then echo 'PostgreSQL dump exceeds maxDumpBytes.' >&2; exit 75; fi
` + DATABASE_FINGERPRINT_ACTION_SCRIPT;

function ensureDockerAvailable() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DOCKER_AVAILABILITY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: PROOF_STDIO_LIMIT_BYTES,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Docker is not available');
  }
}

function runCommand(
  command,
  args,
  {
    dryRun = false,
    env = process.env,
    timeout = DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer = PROOF_STDIO_LIMIT_BYTES,
    rejectStderr = false,
  } = {},
) {
  if (dryRun) {
    console.log(formatCommand(command, args));
    return '';
  }

  ensureDockerAvailable();
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer,
  });

  if (result.status !== 0) {
    const failure = result.error?.message || result.stderr || result.stdout || `${command} failed with exit code ${result.status}`;
    throw new Error(String(failure).slice(0, PROOF_STDIO_LIMIT_BYTES));
  }

  if (rejectStderr && result.stderr.trim()) {
    throw new Error(`Command emitted unexpected stderr: ${result.stderr.slice(0, PROOF_STDIO_LIMIT_BYTES)}`);
  }

  return result.stdout;
}

function proofContainerName(kind) {
  return `charitypilot-${kind}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function proofContainerLabelArgs(createdAtMs = Date.now()) {
  return [
    '--label', 'charitypilot.restore-proof=true',
    '--label', `charitypilot.proof-created-at-ms=${createdAtMs}`,
  ];
}

export function shouldScavengeProofContainer({ createdAtMs, running, nowMs = Date.now() }) {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Proof-container timestamps failed strict validation');
  }
  if (typeof running !== 'boolean') throw new Error('Proof-container running state failed strict validation');
  const ageMs = nowMs - createdAtMs;
  return ageMs > PROOF_CONTAINER_STALE_AFTER_MS;
}

function scavengeStaleProofContainers(dryRun) {
  const listArgs = [
    'ps', '-a', '--filter', 'label=charitypilot.restore-proof=true', '--format', '{{.ID}}',
  ];
  if (dryRun) {
    console.log(`${formatCommand('docker', listArgs)} # remove running or stopped crash residue only after ${PROOF_CONTAINER_STALE_AFTER_MS}ms`);
    return;
  }
  const ids = runCommand('docker', listArgs, { timeout: 60_000 })
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const id of ids) {
    if (!/^[a-f0-9]{12,64}$/i.test(id)) {
      throw new Error('Docker returned an invalid labelled proof-container identifier');
    }
    const inspection = runCommand('docker', [
      'inspect', '--format',
      '{{index .Config.Labels "charitypilot.proof-created-at-ms"}}|{{.State.Running}}|{{.Name}}',
      id,
    ], { timeout: 60_000 }).trim();
    const match = /^(\d{13})\|(true|false)\|\/?([A-Za-z0-9_.-]+)$/.exec(inspection);
    if (!match) throw new Error('Labelled proof-container metadata failed strict validation');
    const [, createdAtRaw, running, name] = match;
    if (shouldScavengeProofContainer({
      createdAtMs: Number.parseInt(createdAtRaw, 10),
      running: running === 'true',
    })) {
      removeProofContainerStrict(name, false);
    }
  }
}

function removeProofContainerStrict(containerName, dryRun) {
  if (dryRun) {
    console.log(formatCommand('docker', ['rm', '-f', '-v', containerName]));
    return;
  }
  const result = spawnSync('docker', ['rm', '-f', '-v', containerName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: PROOF_STDIO_LIMIT_BYTES,
  });
  if (result.status === 0) return;
  const failure = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (/No such container/i.test(failure)) return;
  throw new Error(`Strict proof-container cleanup failed for ${containerName}: ${failure.trim() || `exit ${result.status}`}`);
}

function runNamedProofContainer(containerName, args, { env, dryRun = false } = {}) {
  let primaryError;
  let stdout = '';
  try {
    stdout = runCommand('docker', args, {
      env,
      dryRun,
      timeout: PROOF_COMMAND_TIMEOUT_MS,
      maxBuffer: PROOF_STDIO_LIMIT_BYTES,
      rejectStderr: true,
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    removeProofContainerStrict(containerName, dryRun);
  } catch (cleanupError) {
    if (primaryError) {
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return stdout;
}

function proofToolsDockerArgs({
  containerName,
  databaseUrl,
  endpointIdentitySha256,
  actionScript,
  holderScript,
  dockerNetwork,
  outputDir,
  rawReportName = '',
  dumpName = '',
  tempFileLimitMb = DEFAULT_TEMP_FILE_LIMIT_MB,
}) {
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    ...proofContainerLabelArgs(),
    ...linuxDockerHostUserArgs(),
    ...(dockerNetwork ? ['--network', dockerNetwork] : []),
    '-e',
    'CHARITYPILOT_PROOF_DATABASE_URL',
    '-e',
    'CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256',
    '-e',
    'CHARITYPILOT_SNAPSHOT_ACTION',
    '-e',
    'CHARITYPILOT_TEMP_FILE_LIMIT_KB',
    '-e',
    'CHARITYPILOT_TEMP_FILE_LIMIT_BYTES',
    '-e',
    'CHARITYPILOT_MAX_PUBLIC_TABLES',
    '-e',
    'CHARITYPILOT_MAX_ROWS_PER_TABLE',
    '-e',
    'CHARITYPILOT_MAX_TOTAL_ROWS',
    '-e',
    'CHARITYPILOT_MAX_FINGERPRINT_REPORT_BYTES',
    '-e',
    'CHARITYPILOT_MAX_DUMP_BYTES',
    '-e',
    'CHARITYPILOT_CAPACITY_SAFETY_FACTOR',
    '-e',
    'CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES',
    '-e',
    'CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES',
    '-e',
    'CHARITYPILOT_CAPACITY_REQUIRED_BYTES',
    '-e',
    'CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED',
    '-e',
    'CHARITYPILOT_RAW_REPORT_PATH',
    ...(dumpName ? ['-e', 'CHARITYPILOT_DUMP_PATH'] : []),
    ...(outputDir ? ['-v', `${outputDir}:/proof`] : []),
    postgresToolsImage(),
    'sh',
    '-eu',
    '-c',
    holderScript,
  ];
  const env = {
    ...process.env,
    CHARITYPILOT_PROOF_DATABASE_URL: databaseUrl,
    CHARITYPILOT_SOURCE_ENDPOINT_IDENTITY_SHA256: endpointIdentitySha256,
    CHARITYPILOT_SNAPSHOT_ACTION: actionScript,
    CHARITYPILOT_TEMP_FILE_LIMIT_KB: String(tempFileLimitMb * 1024),
    CHARITYPILOT_TEMP_FILE_LIMIT_BYTES: String(tempFileLimitMb * 1024 * 1024),
    CHARITYPILOT_MAX_PUBLIC_TABLES: String(MAX_PUBLIC_TABLES),
    CHARITYPILOT_MAX_ROWS_PER_TABLE: String(MAX_ROWS_PER_TABLE),
    CHARITYPILOT_MAX_TOTAL_ROWS: String(MAX_TOTAL_ROWS),
    CHARITYPILOT_MAX_FINGERPRINT_REPORT_BYTES: String(MAX_FINGERPRINT_REPORT_BYTES),
    CHARITYPILOT_MAX_DUMP_BYTES: String(MAX_DUMP_BYTES),
    CHARITYPILOT_CAPACITY_SAFETY_FACTOR: String(CAPACITY_SAFETY_FACTOR),
    CHARITYPILOT_CAPACITY_SAFETY_MARGIN_BYTES: String(CAPACITY_SAFETY_MARGIN_BYTES),
    CHARITYPILOT_SOURCE_DATABASE_SIZE_BYTES: '',
    CHARITYPILOT_CAPACITY_REQUIRED_BYTES: '',
    CHARITYPILOT_CAPACITY_PREFLIGHT_VERIFIED: '',
    CHARITYPILOT_RAW_REPORT_PATH: rawReportName ? `/proof/${rawReportName}` : '',
    ...(dumpName ? { CHARITYPILOT_DUMP_PATH: `/proof/${dumpName}` } : {}),
  };
  return { args, env };
}

function parseIdentityCapture(stdout) {
  const line = stdout.trim();
  const match = /^identity\|([a-f0-9]{64})$/.exec(line);
  if (!match) {
    throw new Error(`Read-only source identity capture returned unexpected output: ${redactPostgresTranscript(line).slice(0, 512)}`);
  }
  return match[1];
}

function captureSourceIdentity({ databaseUrl, dockerNetwork, tempFileLimitMb, dryRun }) {
  const endpointIdentitySha256 = sourceEndpointIdentitySha256(databaseUrl);
  const containerName = proofContainerName('source-identity');
  const captureDir = dryRun ? undefined : mkdtempSync(join(tmpdir(), 'charitypilot-source-identity-'));
  const rawReportName = captureDir ? 'identity.txt' : '';
  try {
    const { args, env } = proofToolsDockerArgs({
      containerName,
      databaseUrl,
      endpointIdentitySha256,
      actionScript: IDENTITY_ACTION_SCRIPT,
      holderScript: IDENTITY_SNAPSHOT_HOLDER_SCRIPT,
      dockerNetwork,
      outputDir: captureDir,
      rawReportName,
      tempFileLimitMb,
    });
    const stdout = runNamedProofContainer(containerName, args, { env, dryRun });
    if (dryRun) return undefined;
    const identityPath = join(captureDir, rawReportName);
    if (stdout.trim()) throw new Error('Read-only source identity capture printed non-allowlisted output');
    if (!existsSync(identityPath) || !lstatSync(identityPath).isFile() || lstatSync(identityPath).isSymbolicLink()) {
      throw new Error('Read-only source identity capture did not create a regular digest artifact');
    }
    return parseIdentityCapture(readFileSync(identityPath, 'utf8'));
  } finally {
    if (captureDir) rmSync(captureDir, { recursive: true, force: true });
  }
}

function sourceIdentity(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const json = isEnabled(options, 'json');
  const databaseUrl = optionString(options, 'database-url') ?? process.env.DATABASE_URL;
  const dockerNetwork = validateDockerNetwork(optionString(options, 'docker-network'));
  const tempFileLimitMb = proofTempFileLimitMb(options);
  if (!databaseUrl) throw new Error('DATABASE_URL or --database-url is required for source-identity');
  validateProofSourceDatabaseUrl(databaseUrl);
  const helperImplementation = requireHelperImplementationBinding(captureHelperImplementationBinding());

  const sourceDatabaseIdentitySha256 = captureSourceIdentity({ databaseUrl, dockerNetwork, tempFileLimitMb, dryRun });
  assertHelperImplementationUnchanged(helperImplementation, 'during source identity capture');
  if (dryRun) {
    console.log('Source database identity dry run rendered; no identity was captured.');
    return;
  }

  if (json) {
    console.log(JSON.stringify({
      format: SOURCE_IDENTITY_FORMAT,
      ok: true,
      checksumAlgorithm: 'sha256',
      helperImplementation,
      toolsImageReference: DEFAULT_POSTGRES_IMAGE,
      toolsImageDigestSha256: APPROVED_POSTGRES_IMAGE_DIGEST_SHA256,
      sourceDatabaseIdentitySha256,
      sourceReadOnlyVerified: true,
      workloadSafety: {
        tempFileLimitBytes: String(tempFileLimitMb * 1024 * 1024),
        statementTimeoutMs: 120_000,
        lockTimeoutMs: 15_000,
        idleTransactionTimeoutMs: 180_000,
      },
      secretValuesPrinted: false,
      provenanceLimitation: SOURCE_IDENTITY_PROVENANCE_LIMITATION,
    }));
    return;
  }
  console.log('Source database identity captured read-only.');
  console.log(`Source database identity SHA-256: ${sourceDatabaseIdentitySha256}`);
  console.log(`Provenance limitation: ${SOURCE_IDENTITY_PROVENANCE_LIMITATION}`);
}

function captureDatabaseFingerprint({
  databaseUrl,
  endpointIdentitySha256,
  dockerNetwork,
  outputDir,
  rawReportName,
  dumpName,
  dryRun,
  kind,
  tempFileLimitMb,
}) {
  if (dryRun) {
    console.log(
      dumpName
        ? 'Read-only source action: pg_dump --snapshot <validated-exported-snapshot> plus canonical length/hex/JSON-framed SHA-256 for all supported public schema objects and every ordinary, partitioned, or materialized table; no row values are printed.'
        : 'Read-only fingerprint action: canonical length/hex/JSON-framed SHA-256 for all supported public schema objects and every ordinary, partitioned, or materialized table; no row values are printed.',
    );
    if (dumpName) {
      console.log(
        `Dump capacity preflight: read-only pg_database_size(current_database()), requiredAvailableBytes=min(maxDumpBytes, sourceDatabaseSizeBytes*${CAPACITY_SAFETY_FACTOR}+${CAPACITY_SAFETY_MARGIN_BYTES}), df -Pk /proof; ulimit -f and post-dump hard cap remain maxDumpBytes=${MAX_DUMP_BYTES}; --no-blobs.`,
      );
    }
  }
  const containerName = proofContainerName(kind);
  const { args, env } = proofToolsDockerArgs({
    containerName,
    databaseUrl,
    endpointIdentitySha256,
    actionScript: dumpName ? SOURCE_PROOF_ACTION_SCRIPT : DATABASE_FINGERPRINT_ACTION_SCRIPT,
    holderScript: SNAPSHOT_HOLDER_SCRIPT,
    dockerNetwork,
    outputDir,
    rawReportName,
    dumpName,
    tempFileLimitMb,
  });
  runNamedProofContainer(containerName, args, { env, dryRun });
}

const DUMP_DESCRIPTOR_SCRIPT = String.raw`
set -eu
umask 077
case "$CHARITYPILOT_DUMP_FILE" in /*|*/*) echo 'Unsafe dump descriptor file name.' >&2; exit 75 ;; esac
work_dir=$(mktemp -d)
cleanup_descriptor() { rm -rf "$work_dir"; }
trap cleanup_descriptor EXIT HUP INT TERM
pg_restore --list "/backup/$CHARITYPILOT_DUMP_FILE" > "$work_dir/list"
LC_ALL=C awk 'substr($0, 1, 1) != ";" && NF > 0 { print }' "$work_dir/list" | LC_ALL=C sort > "$work_dir/normalized"
entry_count=$(wc -l < "$work_dir/normalized" | tr -d ' ')
if ! printf '%s' "$entry_count" | grep -Eq '^[1-9][0-9]*$'; then echo 'Dump descriptor is empty.' >&2; exit 79; fi
descriptor_sha=$(printf 'charitypilot-pg-restore-descriptor/v1\n' | cat - "$work_dir/normalized" | sha256sum | cut -d ' ' -f 1)
printf 'descriptor|%s|%s\n' "$descriptor_sha" "$entry_count"
`;

function inspectDumpDescriptor(dumpPath, dryRun) {
  const dumpDir = dirname(dumpPath);
  const dumpName = basename(dumpPath);
  const containerName = proofContainerName('dump-descriptor');
  const env = { ...process.env, CHARITYPILOT_DUMP_FILE: dumpName };
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    ...proofContainerLabelArgs(),
    '--network',
    'none',
    ...linuxDockerHostUserArgs(),
    '-e',
    'CHARITYPILOT_DUMP_FILE',
    '-v',
    `${dumpDir}:/backup:ro`,
    postgresToolsImage(),
    'sh',
    '-eu',
    '-c',
    DUMP_DESCRIPTOR_SCRIPT,
  ];
  const stdout = runNamedProofContainer(containerName, args, { env, dryRun });
  if (dryRun) return undefined;
  const match = /^descriptor\|([a-f0-9]{64})\|([1-9][0-9]*)$/.exec(stdout.trim());
  if (!match) throw new Error('pg_restore descriptor inspection returned unexpected output');
  return { sha256: match[1], entryCount: Number.parseInt(match[2], 10) };
}

function waitForProofRestoreDatabase(containerName, dryRun, databaseName = RESTORE_BOOTSTRAP_DATABASE_NAME) {
  const args = [
    'exec',
    containerName,
    'pg_isready',
    '-h',
    '127.0.0.1',
    '-U',
    RESTORE_DATABASE_USER,
    '-d',
    databaseName,
  ];
  if (dryRun) {
    console.log(`until ${formatCommand('docker', args)}; do sleep 1; done`);
    return;
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: PROOF_STDIO_LIMIT_BYTES,
    });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error('Timed out waiting for isolated restore proof database');
}

function restoreProofDatabaseUrl(password) {
  return `postgresql://${RESTORE_DATABASE_USER}:${encodeURIComponent(password)}@127.0.0.1:5432/${RESTORE_DATABASE_NAME}`;
}

function startProofRestoreContainer(containerName, recoverySetId, password, dryRun) {
  const createdAtMs = Date.now();
  const env = {
    ...process.env,
    CHARITYPILOT_RESTORE_POSTGRES_USER: RESTORE_DATABASE_USER,
    CHARITYPILOT_RESTORE_POSTGRES_PASSWORD: password,
    CHARITYPILOT_RESTORE_POSTGRES_DB: RESTORE_BOOTSTRAP_DATABASE_NAME,
  };
  const args = [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--label',
    'charitypilot.restore-proof=true',
    '--label',
    `charitypilot.recovery-set-sha256=${sha256Text(recoverySetId)}`,
    '--label',
    `charitypilot.proof-created-at-ms=${createdAtMs}`,
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=4g',
    '-e',
    'POSTGRES_USER=CHARITYPILOT_RESTORE_POSTGRES_USER',
    '-e',
    'POSTGRES_PASSWORD=CHARITYPILOT_RESTORE_POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=CHARITYPILOT_RESTORE_POSTGRES_DB',
    postgresToolsImage(),
  ];
  const dockerArgs = args.flatMap((value) => {
    if (value === 'POSTGRES_USER=CHARITYPILOT_RESTORE_POSTGRES_USER') return ['POSTGRES_USER'];
    if (value === 'POSTGRES_PASSWORD=CHARITYPILOT_RESTORE_POSTGRES_PASSWORD') return ['POSTGRES_PASSWORD'];
    if (value === 'POSTGRES_DB=CHARITYPILOT_RESTORE_POSTGRES_DB') return ['POSTGRES_DB'];
    return [value];
  });
  runCommand('docker', dockerArgs, {
    dryRun,
    timeout: 120_000,
    env: {
      ...env,
      POSTGRES_USER: env.CHARITYPILOT_RESTORE_POSTGRES_USER,
      POSTGRES_PASSWORD: env.CHARITYPILOT_RESTORE_POSTGRES_PASSWORD,
      POSTGRES_DB: env.CHARITYPILOT_RESTORE_POSTGRES_DB,
    },
  });
}

function createProofRestoreDatabase(containerName, databaseEnvironment, password, dryRun) {
  const displayEnvironment = databaseEnvironment ?? {
    encoding: '<source-database-encoding>',
    collation: '<source-database-collation>',
    ctype: '<source-database-ctype>',
    localeProvider: 'libc',
    collationVersion: null,
  };
  const validated = dryRun ? displayEnvironment : requireRestorableDatabaseEnvironment(databaseEnvironment);
  const args = [
    'exec',
    '-e',
    'PGPASSWORD',
    containerName,
    'createdb',
    '--host',
    '127.0.0.1',
    '--username',
    RESTORE_DATABASE_USER,
    '--owner',
    RESTORE_DATABASE_USER,
    '--template',
    'template0',
    '--encoding',
    validated.encoding,
    '--locale-provider',
    validated.localeProvider,
    '--lc-collate',
    validated.collation,
    '--lc-ctype',
    validated.ctype,
    RESTORE_DATABASE_NAME,
  ];
  runCommand('docker', args, {
    dryRun,
    timeout: 120_000,
    env: { ...process.env, PGPASSWORD: password },
  });
}

function restoreDumpIntoProofContainer(containerName, dumpPath, password, dryRun) {
  const dumpDir = dirname(dumpPath);
  const dumpName = basename(dumpPath);
  const env = { ...process.env, CHARITYPILOT_RESTORE_DATABASE_URL: restoreProofDatabaseUrl(password) };
  const loaderContainerName = proofContainerName('restore-loader');
  const args = [
    'run',
    '--rm',
    '--name',
    loaderContainerName,
    ...proofContainerLabelArgs(),
    '--network',
    `container:${containerName}`,
    '-v',
    `${dumpDir}:/backup:ro`,
    '-e',
    'CHARITYPILOT_RESTORE_DATABASE_URL',
    postgresToolsImage(),
    'sh',
    '-eu',
    '-c',
    'pg_restore --dbname "$CHARITYPILOT_RESTORE_DATABASE_URL" --exit-on-error --single-transaction --no-owner --no-privileges "/backup/$CHARITYPILOT_DUMP_FILE"',
  ];
  env.CHARITYPILOT_DUMP_FILE = dumpName;
  args.splice(args.indexOf(postgresToolsImage()), 0, '-e', 'CHARITYPILOT_DUMP_FILE');
  runNamedProofContainer(loaderContainerName, args, { dryRun, env });
}

function fingerprintReportForJson(fingerprint, { includeIdentity = false } = {}) {
  const canonical = {
    databaseEnvironment: { ...fingerprint.databaseEnvironment },
    publicSchemaSha256: fingerprint.publicSchemaSha256,
    tableMembershipSha256: fingerprint.tableMembershipSha256,
    databaseFingerprintSha256: fingerprint.databaseFingerprintSha256,
    tableCount: fingerprint.tableCount,
    totalRows: fingerprint.totalRows,
    workloadSafety: fingerprint.workloadSafety,
    schemaCoverage: fingerprint.schemaCoverage,
    tables: fingerprint.tables,
  };
  return {
    ...(includeIdentity ? { databaseIdentitySha256: fingerprint.databaseIdentitySha256 } : {}),
    fingerprintReportSha256: sha256Text(safeJsonStringify(canonical)),
    ...canonical,
  };
}

function buildSchemaCertificationScope(largeObjectCount) {
  if (largeObjectCount !== 0) throw new Error('Schema certification scope requires zero PostgreSQL large objects');
  return {
    certifiedSchemas: ['public'],
    certifiedDataClasses: [...CERTIFIED_DATA_CLASSES],
    certifiedObjectClasses: [...CERTIFIED_OBJECT_CLASSES],
    publicSchemaOnly: true,
    nonPublicSchemasIncluded: false,
    largeObjectsIncluded: false,
    largeObjectCount,
    extensionMembershipIncluded: false,
    commentsIncluded: false,
    securityLabelsIncluded: false,
    databaseLevelObjectsIncluded: false,
    exclusions: SCHEMA_CERTIFICATION_EXCLUSIONS.map((entry) => ({ ...entry })),
  };
}

export function buildRestoreProofReport({
  recoverySetId,
  capturedAt,
  expectedSourceDatabaseIdentitySha256,
  outputFile,
  dumpSha256Before,
  dumpBytesBefore,
  dumpDescriptorBefore,
  dumpSha256After,
  dumpBytesAfter,
  dumpDescriptorAfter,
  source,
  restored,
  comparison,
  helperImplementation = captureHelperImplementationBinding(),
}) {
  if (source.databaseIdentitySha256 !== expectedSourceDatabaseIdentitySha256) {
    throw new Error('Source identity binding must match before a restore proof report can be built');
  }
  if (!source.capacityPreflight?.verified) {
    throw new Error('Source fingerprint must include verified source-size-aware capacity preflight evidence');
  }
  if (restored.capacityPreflight !== undefined) {
    throw new Error('Restored fingerprint must not claim source output capacity preflight evidence');
  }
  if (JSON.stringify(source.databaseEnvironment) !== JSON.stringify(restored.databaseEnvironment)) {
    throw new Error('Source and restored database encoding/collation environments must match');
  }
  const sourceForReport = fingerprintReportForJson(source);
  const restoredForReport = fingerprintReportForJson(restored, { includeIdentity: true });
  const validatedHelperImplementation = requireHelperImplementationBinding(helperImplementation);
  const sourceBindingSha256 = createSourceDumpBindingSha256({
    recoverySetId,
    sourceDatabaseIdentitySha256: expectedSourceDatabaseIdentitySha256,
    helperImplementationSourceSha256: validatedHelperImplementation.sourceSha256,
    helperImplementationCommitSha: validatedHelperImplementation.commitSha,
    dumpSha256: dumpSha256Before,
    dumpBytes: dumpBytesBefore,
    dumpDescriptorSha256: dumpDescriptorBefore.sha256,
    sourceDatabaseFingerprintSha256: source.databaseFingerprintSha256,
    sourceFingerprintReportSha256: sourceForReport.fingerprintReportSha256,
  });
  return {
    format: RESTORE_PROOF_FORMAT,
    ok: true,
    checksumAlgorithm: 'sha256',
    helperImplementation: { ...validatedHelperImplementation },
    toolsImageReference: DEFAULT_POSTGRES_IMAGE,
    toolsImageDigestSha256: APPROVED_POSTGRES_IMAGE_DIGEST_SHA256,
    recoverySetId,
    capturedAt,
    sourceDatabaseIdentitySha256: source.databaseIdentitySha256,
    expectedSourceDatabaseIdentitySha256,
    sourceIdentityBindingMatched: true,
    sourceReadOnlyVerified: true,
    snapshot: {
      isolationLevel: 'repeatable read',
      readOnly: true,
      rowSecurityOff: true,
      accessShareLocks: true,
      exported: true,
      snapshotIdSha256: source.snapshotSha256,
    },
    dump: {
      fileName: outputFile,
      sha256: dumpSha256Before,
      bytes: String(dumpBytesBefore),
      descriptorSha256: dumpDescriptorBefore.sha256,
      descriptorEntryCount: dumpDescriptorBefore.entryCount,
      rehashAfterRestoreSha256: dumpSha256After,
      bytesAfterRestore: String(dumpBytesAfter),
      descriptorAfterRestoreSha256: dumpDescriptorAfter.sha256,
      unchangedDuringProof: true,
      sourceBindingSha256,
      capacityPreflight: { ...source.capacityPreflight },
    },
    source: sourceForReport,
    restored: restoredForReport,
    restoreTarget: {
      type: 'isolated-disposable-postgresql',
      identitySha256: restored.databaseIdentitySha256,
      databaseEnvironment: { ...restored.databaseEnvironment },
      initializedFromSourceDatabaseEnvironment: true,
      databaseEnvironmentPreserved: true,
      networkPublished: false,
      hostVolumeForDatabase: false,
      ephemeralData: true,
      productionOverwritten: false,
      cleanupVerified: true,
    },
    comparison,
    schemaCertificationScope: buildSchemaCertificationScope(source.schemaCoverage.largeObjectCount),
    sequenceStateIncluded: false,
    sequenceDefinitionAndOwnershipBound: true,
    publicSequenceCount: source.schemaCoverage.publicSequenceCount,
    applicationIdentityColumnCount: source.schemaCoverage.applicationIdentityColumnCount,
    applicationSequenceDefaultCount: source.schemaCoverage.applicationSequenceDefaultCount,
    sequenceStateExclusionReason: SEQUENCE_STATE_EXCLUSION_REASON,
    ownershipIncluded: false,
    ownershipExclusionReason: OWNERSHIP_EXCLUSION_REASON,
    aclPrivilegesIncluded: false,
    aclPrivilegesExclusionReason: ACL_EXCLUSION_REASON,
    workloadSafety: {
      ...source.workloadSafety,
      maxDumpBytes: String(MAX_DUMP_BYTES),
      statementTimeoutMs: 1_800_000,
      lockTimeoutMs: 30_000,
      idleTransactionTimeoutMs: 2_640_000,
    },
    provenanceLimitation: RESTORE_PROOF_PROVENANCE_LIMITATION,
    secretValuesPrinted: false,
  };
}

function installExclusiveProofOutputs(stagedDump, finalDump, stagedReport, finalReport) {
  let dumpInstalled = false;
  let reportInstalled = false;
  try {
    linkSync(stagedDump, finalDump);
    dumpInstalled = true;
    linkSync(stagedReport, finalReport);
    reportInstalled = true;
    rmSync(stagedDump, { force: true });
    rmSync(stagedReport, { force: true });
  } catch (error) {
    if (reportInstalled) rmSync(finalReport, { force: true });
    if (dumpInstalled) rmSync(finalDump, { force: true });
    throw error;
  }
}

async function proveRestore(options) {
  const dryRun = isEnabled(options, 'dry-run');
  if (isEnabled(options, 'overwrite')) {
    throw new Error('--overwrite is not supported for prove-restore; recovery evidence outputs must be unique and immutable');
  }
  const databaseUrl = optionString(options, 'database-url') ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or --database-url is required for prove-restore');
  validateProofSourceDatabaseUrl(databaseUrl);
  const helperImplementation = requireHelperImplementationBinding(captureHelperImplementationBinding());
  const recoverySetId = requireRecoverySetId(optionString(options, 'recovery-set-id'));
  const expectedSourceDatabaseIdentitySha256 = requireSha256(
    optionString(options, 'expected-source-database-identity-sha256'),
    '--expected-source-database-identity-sha256',
  );
  const dockerNetwork = validateDockerNetwork(optionString(options, 'docker-network'));
  const tempFileLimitMb = proofTempFileLimitMb(options);
  const outputDir = requireProofOutputDirectory(options, { dryRun });
  const outputDirIdentity = protectedDirectoryIdentity(outputDir);
  const outputFile = requireSafeFileName(optionString(options, 'output-file') ?? timestampedBackupFileName());
  const reportFile = requireSafeFileName(
    optionString(options, 'report-file') ?? `${outputFile}.restore-proof.json`,
  );
  if (outputFile === reportFile) throw new Error('--output-file and --report-file must be different names');

  const finalDumpPath = join(outputDir, outputFile);
  const finalReportPath = join(outputDir, reportFile);
  if (!dryRun) {
    preflightOutputFilesystemCapacity(outputDir, CAPACITY_SAFETY_MARGIN_BYTES);
    ensureReplaceableProofPath(finalDumpPath, false);
    ensureReplaceableProofPath(finalReportPath, false);
  }

  const stagedDumpName = temporaryProofFileName(outputFile, 'capture');
  const sourceRawName = temporaryProofFileName(reportFile, 'source-fingerprint');
  const restoredRawName = temporaryProofFileName(reportFile, 'restored-fingerprint');
  const stagedReportName = temporaryProofFileName(reportFile, 'report');
  const stagedDumpPath = join(outputDir, stagedDumpName);
  const sourceRawPath = join(outputDir, sourceRawName);
  const restoredRawPath = join(outputDir, restoredRawName);
  const stagedReportPath = join(outputDir, stagedReportName);
  const sourceEndpointSha256 = sourceEndpointIdentitySha256(databaseUrl);
  const restoreContainerName = proofContainerName('isolated-restore');
  const restorePassword = randomBytes(32).toString('base64url');
  const restoreEndpointSha256 = sha256Text([
    'charitypilot-isolated-restore-endpoint/v1',
    restoreContainerName,
    RESTORE_DATABASE_NAME,
    RESTORE_DATABASE_USER,
  ].join('\n'));

  let restoreStarted = false;
  let proofSucceeded = false;
  let outputsInstalled = false;
  let dumpHandle;
  let sourceHandle;
  let restoredHandle;
  let reportHandle;
  scavengeStaleProofContainers(dryRun);
  try {
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'before source capture');
    captureDatabaseFingerprint({
      databaseUrl,
      endpointIdentitySha256: sourceEndpointSha256,
      dockerNetwork,
      outputDir,
      rawReportName: sourceRawName,
      dumpName: stagedDumpName,
      dryRun,
      kind: 'source-snapshot',
      tempFileLimitMb,
    });
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'after source capture');

    if (dryRun) {
      inspectDumpDescriptor(stagedDumpPath, true);
      startProofRestoreContainer(restoreContainerName, recoverySetId, restorePassword, true);
      waitForProofRestoreDatabase(restoreContainerName, true);
      createProofRestoreDatabase(restoreContainerName, undefined, restorePassword, true);
      restoreDumpIntoProofContainer(restoreContainerName, stagedDumpPath, restorePassword, true);
      captureDatabaseFingerprint({
        databaseUrl: restoreProofDatabaseUrl(restorePassword),
        endpointIdentitySha256: restoreEndpointSha256,
        dockerNetwork: `container:${restoreContainerName}`,
        outputDir,
        rawReportName: restoredRawName,
        dryRun: true,
        kind: 'restored-snapshot',
        tempFileLimitMb,
      });
      inspectDumpDescriptor(stagedDumpPath, true);
      removeProofContainerStrict(restoreContainerName, true);
      console.log('Production-safe database restore proof dry run rendered; no evidence was captured.');
      return;
    }

    for (const path of [stagedDumpPath, sourceRawPath]) {
      const artifactExists = existsSync(path);
      const artifactStatus = artifactExists ? lstatSync(path) : undefined;
      if (!artifactStatus?.isFile() || artifactStatus.isSymbolicLink()) {
        throw new Error(
          `Source snapshot capture did not create regular protected proof artifact ${basename(path)} ` +
          `(exists=${artifactExists}, regular=${artifactStatus?.isFile() ?? false}, symlink=${artifactStatus?.isSymbolicLink() ?? false})`,
        );
      }
      protectOwnerOnly(path);
    }
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'before opening captured artifacts');
    sourceHandle = openProtectedRegularFile(sourceRawPath, 'source fingerprint report');
    dumpHandle = openProtectedRegularFile(stagedDumpPath, 'captured PostgreSQL dump');
    const source = parseDatabaseFingerprintReport(
      readProtectedFile(sourceHandle, MAX_FINGERPRINT_REPORT_BYTES, 'source fingerprint parsing'),
    );
    if (source.databaseIdentitySha256 !== expectedSourceDatabaseIdentitySha256) {
      throw new Error('Read-only source database identity does not match the independently supplied SHA-256 binding');
    }
    const dumpStatusBefore = assertProtectedFileUnchanged(dumpHandle, 'before initial hash');
    if (dumpStatusBefore.size <= 0n) throw new Error('Captured PostgreSQL dump is empty');
    if (dumpStatusBefore.size > BigInt(MAX_DUMP_BYTES)) throw new Error('Captured PostgreSQL dump exceeds maxDumpBytes');
    const dumpSha256Before = sha256ProtectedFile(dumpHandle, 'initial dump hash');
    assertProtectedFileUnchanged(dumpHandle, 'before initial descriptor inspection');
    const dumpDescriptorBefore = inspectDumpDescriptor(stagedDumpPath, false);
    assertProtectedFileUnchanged(dumpHandle, 'after initial descriptor inspection');

    restoreStarted = true;
    startProofRestoreContainer(restoreContainerName, recoverySetId, restorePassword, false);
    waitForProofRestoreDatabase(restoreContainerName, false);
    createProofRestoreDatabase(restoreContainerName, source.databaseEnvironment, restorePassword, false);
    assertProtectedFileUnchanged(dumpHandle, 'before isolated restore');
    restoreDumpIntoProofContainer(restoreContainerName, stagedDumpPath, restorePassword, false);
    assertProtectedFileUnchanged(dumpHandle, 'after isolated restore');
    captureDatabaseFingerprint({
      databaseUrl: restoreProofDatabaseUrl(restorePassword),
      endpointIdentitySha256: restoreEndpointSha256,
      dockerNetwork: `container:${restoreContainerName}`,
      outputDir,
      rawReportName: restoredRawName,
      dryRun: false,
      kind: 'restored-snapshot',
      tempFileLimitMb,
    });
    if (!existsSync(restoredRawPath) || !lstatSync(restoredRawPath).isFile() || lstatSync(restoredRawPath).isSymbolicLink()) {
      throw new Error('Isolated restore did not create a regular fingerprint report');
    }
    protectOwnerOnly(restoredRawPath);
    restoredHandle = openProtectedRegularFile(restoredRawPath, 'restored fingerprint report');
    const restored = parseDatabaseFingerprintReport(
      readProtectedFile(restoredHandle, MAX_FINGERPRINT_REPORT_BYTES, 'restored fingerprint parsing'),
    );
    if (restored.databaseIdentitySha256 === source.databaseIdentitySha256) {
      throw new Error('Isolated restore target identity was not distinct from the source identity');
    }
    const comparison = compareDatabaseFingerprints(source, restored);

    const dumpStatusAfter = assertProtectedFileUnchanged(dumpHandle, 'before final hash');
    const dumpSha256After = sha256ProtectedFile(dumpHandle, 'final dump hash');
    assertProtectedFileUnchanged(dumpHandle, 'before final descriptor inspection');
    const dumpDescriptorAfter = inspectDumpDescriptor(stagedDumpPath, false);
    assertProtectedFileUnchanged(dumpHandle, 'after final descriptor inspection');
    if (
      dumpStatusAfter.size !== dumpStatusBefore.size ||
      dumpSha256After !== dumpSha256Before ||
      dumpDescriptorAfter.sha256 !== dumpDescriptorBefore.sha256 ||
      dumpDescriptorAfter.entryCount !== dumpDescriptorBefore.entryCount
    ) {
      throw new Error('PostgreSQL dump changed between source capture and isolated restore verification');
    }

    removeProofContainerStrict(restoreContainerName, false);
    restoreStarted = false;
    assertHelperImplementationUnchanged(helperImplementation, 'during restore proof execution');

    const report = buildRestoreProofReport({
      recoverySetId,
      capturedAt: new Date().toISOString(),
      expectedSourceDatabaseIdentitySha256,
      outputFile,
      dumpSha256Before,
      dumpBytesBefore: dumpStatusBefore.size.toString(),
      dumpDescriptorBefore,
      dumpSha256After,
      dumpBytesAfter: dumpStatusAfter.size.toString(),
      dumpDescriptorAfter,
      source,
      restored,
      comparison,
      helperImplementation,
    });
    const reportBytes = safeJsonStringify(report);
    if (Buffer.byteLength(reportBytes, 'utf8') > 16 * 1024 * 1024) {
      throw new Error('Restore proof report exceeds the 16 MiB safety bound');
    }
    const reportWriteFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    const reportWriteFd = openSync(stagedReportPath, reportWriteFlags, 0o600);
    try {
      writeFileSync(reportWriteFd, reportBytes, { encoding: 'utf8' });
      fsyncSync(reportWriteFd);
    } finally {
      closeSync(reportWriteFd);
    }
    protectOwnerOnly(stagedReportPath);
    protectOwnerOnly(stagedDumpPath);
    reportHandle = openProtectedRegularFile(stagedReportPath, 'restore proof report');
    assertProtectedFileUnchanged(dumpHandle, 'before proof publication');
    assertProtectedFileUnchanged(reportHandle, 'before proof publication');
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'before proof publication');
    ensureReplaceableProofPath(finalDumpPath, false);
    ensureReplaceableProofPath(finalReportPath, false);
    installExclusiveProofOutputs(stagedDumpPath, finalDumpPath, stagedReportPath, finalReportPath);
    outputsInstalled = true;
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'after proof publication');
    const finalDumpHandle = openProtectedRegularFile(finalDumpPath, 'installed PostgreSQL dump');
    const finalReportHandle = openProtectedRegularFile(finalReportPath, 'installed restore proof report');
    let proofReportSha256;
    try {
      if (
        !sameUnderlyingFile(dumpHandle.identity, finalDumpHandle.identity) ||
        !sameUnderlyingFile(reportHandle.identity, finalReportHandle.identity)
      ) {
        throw new Error('Hard-link publication did not preserve the held proof artifact identities');
      }
      const installedDumpSha256 = sha256ProtectedFile(finalDumpHandle, 'independent installed dump verification');
      const installedReportBytes = readProtectedFile(
        finalReportHandle,
        MAX_FINGERPRINT_REPORT_BYTES,
        'independent installed report verification',
      );
      const installedReportSha256 = sha256ProtectedFile(finalReportHandle, 'independent installed report hash');
      if (installedDumpSha256 !== dumpSha256Before || installedReportBytes !== reportBytes) {
        throw new Error('Installed restore proof artifacts do not match their held staged descriptors');
      }
      proofReportSha256 = installedReportSha256;
    } finally {
      closeProtectedFile(finalDumpHandle);
      closeProtectedFile(finalReportHandle);
    }
    proofSucceeded = true;
    console.log('Production-safe database restore proof passed: source and isolated restore fingerprints match.');
    console.log(`Proof report SHA-256: ${proofReportSha256}`);
    console.log(`Proof report file: ${reportFile}`);
  } finally {
    let cleanupError;
    if (restoreStarted) {
      try {
        removeProofContainerStrict(restoreContainerName, false);
      } catch (error) {
        cleanupError = error;
      }
    }
    closeProtectedFile(sourceHandle);
    closeProtectedFile(restoredHandle);
    closeProtectedFile(reportHandle);
    closeProtectedFile(dumpHandle);
    assertProtectedDirectoryUnchanged(outputDir, outputDirIdentity, 'before proof cleanup');
    for (const path of [sourceRawPath, restoredRawPath]) rmSync(path, { force: true });
    if (!proofSucceeded) {
      rmSync(stagedDumpPath, { force: true });
      rmSync(stagedReportPath, { force: true });
      if (outputsInstalled) {
        rmSync(finalDumpPath, { force: true });
        rmSync(finalReportPath, { force: true });
      }
    }
    if (cleanupError) throw cleanupError;
  }
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
      const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let childClosed = false;
      let outputClosed = false;
      let exitCode = null;
      let settled = false;
      let streamedBytes = 0;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`${command} timed out after ${PROOF_COMMAND_TIMEOUT_MS}ms`));
      }, PROOF_COMMAND_TIMEOUT_MS);
      timeout.unref?.();

      const maybeResolve = () => {
        if (settled || !childClosed || !outputClosed) return;
        settled = true;
        clearTimeout(timeout);
        if (exitCode === 0) {
          resolvePromise();
        } else {
          reject(new Error(`${command} failed with exit code ${exitCode}`));
        }
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(error);
      };

      child.stdout.on('data', (chunk) => {
        if (settled) return;
        try {
          streamedBytes = nextDumpByteCount(streamedBytes, chunk.length);
        } catch (error) {
          child.stdout.destroy();
          output.destroy();
          fail(error);
          return;
        }
        if (!output.write(chunk)) child.stdout.pause();
      });
      output.on('drain', () => child.stdout.resume());
      child.stdout.on('end', () => output.end());
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
    protectOwnerOnly(outputPath);
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

function runUrlBackup(containerName, args, env, outputPath, dryRun) {
  if (dryRun) {
    runNamedProofContainer(containerName, args, { dryRun, env });
    return;
  }

  const tempPath = join(dirname(outputPath), env.CHARITYPILOT_BACKUP_FILE);
  try {
    runNamedProofContainer(containerName, args, { dryRun, env });
    const tempStatus = lstatSync(tempPath, { bigint: true });
    if (!tempStatus.isFile() || tempStatus.isSymbolicLink() || tempStatus.size > BigInt(MAX_DUMP_BYTES)) {
      throw new Error('URL PostgreSQL backup is not a regular file within maxDumpBytes');
    }
    moveBackupIntoPlace(tempPath, outputPath);
    protectOwnerOnly(outputPath);
  } catch (error) {
    cleanupTemporaryBackup(tempPath);
    throw error;
  }
}

function cleanupRestoreContainer(containerName, dryRun) {
  removeProofContainerStrict(containerName, dryRun);
}

function runStartRestoreContainer(args, env, dryRun) {
  runCommand('docker', args, { dryRun, env, timeout: 120_000 });
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

function validateProofSourceDatabaseUrl(databaseUrl) {
  validateDatabaseUrl(databaseUrl);
  const parsed = new URL(databaseUrl);
  if (parsed.hash) throw new Error('Proof/source database URL fragments are not allowed');
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const userName = decodeURIComponent(parsed.username);
  if (
    !parsed.hostname || !userName || !databaseName || databaseName.includes('/') ||
    /[,\s]/.test(parsed.hostname) || /[\u0000-\u001f\u007f]/.test(databaseName + userName)
  ) {
    throw new Error('Proof/source database URL must identify exactly one host, database, and user');
  }
  const localDisposable = isLocalDatabaseUrl(databaseUrl);
  const loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (loopbackHost && !localDisposable) {
    throw new Error('Loopback proof/source URLs must use the exact disposable database contract without parameters');
  }
  const allowedParameters = new Set([
    'application_name',
    'channel_binding',
    'connect_timeout',
    'keepalives',
    'keepalives_count',
    'keepalives_idle',
    'keepalives_interval',
    'sslmode',
    'sslrootcert',
    'target_session_attrs',
    'tcp_user_timeout',
  ]);
  const seen = new Set();
  for (const [name, value] of parsed.searchParams) {
    const normalized = name.toLowerCase();
    if (name !== normalized) throw new Error('Proof/source database URL parameters must use canonical lowercase names');
    if (seen.has(normalized)) throw new Error(`Proof/source database URL repeats parameter ${normalized}`);
    seen.add(normalized);
    if (!allowedParameters.has(normalized)) {
      throw new Error(`Proof/source database URL parameter ${normalized} is not allowlisted`);
    }
    if (localDisposable) {
      throw new Error('Disposable loopback proof/source URLs must not carry connection parameters');
    }
    if (normalized === 'sslmode' && value !== 'verify-full') {
      throw new Error('Remote proof/source database URL must use sslmode=verify-full');
    }
    if (normalized === 'sslrootcert' && value !== 'system') {
      throw new Error('Remote proof/source database URL sslrootcert must be system');
    }
    if (normalized === 'channel_binding' && value !== 'require') {
      throw new Error('Remote proof/source database URL channel_binding must be require when supplied');
    }
    if (normalized === 'target_session_attrs' && value !== 'read-only') {
      throw new Error('Remote proof/source database URL target_session_attrs must be read-only when supplied');
    }
    if (normalized === 'keepalives' && !['0', '1'].includes(value)) {
      throw new Error('Remote proof/source database URL keepalives must be 0 or 1');
    }
    if ([
      'connect_timeout', 'keepalives_count', 'keepalives_idle',
      'keepalives_interval', 'tcp_user_timeout',
    ].includes(normalized) && !/^(?:[1-9][0-9]{0,5}|0)$/.test(value)) {
      throw new Error(`Remote proof/source database URL ${normalized} must be a bounded canonical integer`);
    }
    if (normalized === 'application_name' && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)) {
      throw new Error('Remote proof/source database URL application_name is invalid');
    }
  }
  if (
    !localDisposable && (
      parsed.searchParams.get('sslmode') !== 'verify-full' ||
      parsed.searchParams.get('sslrootcert') !== 'system'
    )
  ) {
    throw new Error('Remote proof/source database URL must authenticate TLS with sslmode=verify-full and sslrootcert=system');
  }
  return parsed;
}

function validateDockerNetwork(value) {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('--docker-network contains unsupported characters');
  }
  return value;
}

function isLocalDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  const explicitlyDisposableName = /^(?:charitypilot[-_])?(?:ci|test|e2e|disposable)(?:[-_][a-z0-9_-]+)?$/i.test(databaseName);
  return localHost && explicitlyDisposableName && parsed.searchParams.size === 0;
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
          'PROCESSED',
          '0',
          sentinel.documentStorageDeletionRecoveryId,
          sentinel.documentStorageDeletionRecoveryNonce,
          'REQUEUE_UNCHANGED',
        ].join('|'),
        [
          sentinel.documentStorageDeletionRecoveryId,
          sentinel.documentStorageDeletionRecoveryNonce,
          sentinel.documentStorageDeletionId,
          sentinel.organisationId,
          'TENANT_USER',
          sentinel.userId,
          sentinel.storageRecoveryReason,
          'REQUEUE_UNCHANGED',
          '5',
          'MAX_ATTEMPTS_EXHAUSTED',
          sentinel.storagePath,
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
  "id", "email", "name", "passwordHash", "role", "organisationId", "lifecycleStatus", "emailVerified", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.userId)},
  ${sqlLiteral(sentinel.userEmail)},
  ${sqlLiteral(sentinel.userName)},
  ${sqlLiteral('$2a$10$restoreSentinelHashForBackupGate')},
  'OWNER'::"UserRole",
  ${sqlLiteral(sentinel.organisationId)},
  'ACTIVE'::"UserLifecycleStatus",
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
  "lifecycleStatus" = EXCLUDED."lifecycleStatus",
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
  "id", "organisationId", "storagePath", "state", "attempts", "lastError",
  "lastAttemptAt", "nextAttemptAt", "claimedAt", "deadLetteredAt", "terminalReason",
  "processedAt", "createdAt", "updatedAt"
) VALUES (
  ${sqlLiteral(sentinel.documentStorageDeletionId)},
  ${sqlLiteral(sentinel.organisationId)},
  ${sqlLiteral(sentinel.storagePath)},
  'DEAD_LETTER'::"DocumentStorageDeletionState",
  5,
  'restore sentinel last error',
  ${fixedTimestamp},
  NULL,
  NULL,
  ${fixedTimestamp},
  'MAX_ATTEMPTS_EXHAUSTED'::"DocumentStorageDeletionTerminalReason",
  NULL,
  ${fixedTimestamp},
  ${fixedTimestamp}
)
ON CONFLICT ("id") DO NOTHING;

UPDATE "DocumentStorageDeletion"
SET
  "state" = 'DEAD_LETTER'::"DocumentStorageDeletionState",
  "attempts" = 5,
  "lastError" = 'restore sentinel last error',
  "lastAttemptAt" = ${fixedTimestamp},
  "nextAttemptAt" = NULL,
  "claimedAt" = NULL,
  "deadLetteredAt" = ${fixedTimestamp},
  "terminalReason" = 'MAX_ATTEMPTS_EXHAUSTED'::"DocumentStorageDeletionTerminalReason",
  "alertClaimToken" = NULL,
  "alertClaimedAt" = NULL,
  "alertedAt" = NULL,
  "processedAt" = NULL,
  "updatedAt" = ${fixedTimestamp}
WHERE "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)}
  AND "state" = 'PENDING'
  AND "lastRecoveryId" IS NULL;

INSERT INTO "DocumentStorageDeletionRecovery" (
  "id", "recoveryNonce", "deletionId", "organisationId", "actorType", "actorUserId",
  "operatorIdentity", "reason", "disposition", "previousAttempts", "previousTerminalReason",
  "previousStoragePath", "correctedStoragePath", "createdAt"
) SELECT
  ${sqlLiteral(sentinel.documentStorageDeletionRecoveryId)},
  ${sqlLiteral(sentinel.documentStorageDeletionRecoveryNonce)},
  ${sqlLiteral(sentinel.documentStorageDeletionId)},
  ${sqlLiteral(sentinel.organisationId)},
  'TENANT_USER'::"DocumentStorageDeletionRecoveryActorType",
  ${sqlLiteral(sentinel.userId)},
  NULL,
  ${sqlLiteral(sentinel.storageRecoveryReason)},
  'REQUEUE_UNCHANGED'::"DocumentStorageDeletionRecoveryDisposition",
  5,
  'MAX_ATTEMPTS_EXHAUSTED'::"DocumentStorageDeletionTerminalReason",
  ${sqlLiteral(sentinel.storagePath)},
  NULL,
  ${fixedTimestamp}
WHERE NOT EXISTS (
  SELECT 1
  FROM "DocumentStorageDeletionRecovery"
  WHERE "id" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryId)}
    AND "recoveryNonce" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryNonce)}
)
ON CONFLICT ("recoveryNonce") DO NOTHING;

UPDATE "DocumentStorageDeletion"
SET
  "state" = 'PENDING'::"DocumentStorageDeletionState",
  "attempts" = 0,
  "lastError" = NULL,
  "lastAttemptAt" = NULL,
  "nextAttemptAt" = ${fixedTimestamp},
  "claimedAt" = NULL,
  "deadLetteredAt" = NULL,
  "terminalReason" = NULL,
  "processedAt" = NULL,
  "lastRecoveryId" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryId)},
  "lastRecoveryNonce" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryNonce)},
  "lastRecoveryDisposition" = 'REQUEUE_UNCHANGED'::"DocumentStorageDeletionRecoveryDisposition",
  "lastRecoveredAt" = ${fixedTimestamp},
  "updatedAt" = ${fixedTimestamp}
WHERE "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)}
  AND "state" = 'DEAD_LETTER';

UPDATE "DocumentStorageDeletion"
SET
  "state" = 'PROCESSED'::"DocumentStorageDeletionState",
  "nextAttemptAt" = NULL,
  "claimedAt" = NULL,
  "deadLetteredAt" = NULL,
  "terminalReason" = NULL,
  "processedAt" = ${fixedTimestamp},
  "updatedAt" = ${fixedTimestamp}
WHERE "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)}
  AND "state" = 'PENDING';

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
  const sqlContainerName = proofContainerName('restore-sentinel-seed');
  const args = [
    'run',
    '--rm',
    '--name',
    sqlContainerName,
    ...(dockerNetwork ? ['--network', dockerNetwork] : []),
    '-e',
    'CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_SENTINEL_SQL',
    postgresToolsImage(),
    'sh',
    '-lc',
    'psql --dbname "$CHARITYPILOT_RESTORE_SENTINEL_DATABASE_URL" -v ON_ERROR_STOP=1 -c "$CHARITYPILOT_RESTORE_SENTINEL_SQL"',
  ];

  if (dryRun) {
    console.log(query);
  }
  runNamedProofContainer(sqlContainerName, args, { dryRun, env });
}

function seedRestoreSentinel(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const databaseUrl = optionString(options, 'database-url') ?? process.env.DATABASE_URL;
  const dockerNetwork = validateDockerNetwork(optionString(options, 'docker-network'));

  if (!databaseUrl) {
    throw new Error('DATABASE_URL or --database-url is required for seed-restore-sentinel');
  }
  validateDatabaseUrl(databaseUrl);
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(
      'Refusing to seed restore sentinel unless the URL names a confirmed local CI/test/e2e/disposable database with no URI routing options.',
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
    const outputDirectoryExisted = existsSync(outputDir);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    protectDirectoryOwnerOnly(outputDir, { newlyCreated: !outputDirectoryExisted });
    preflightOutputFilesystemCapacity(outputDir);
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
    const dockerNetwork = validateDockerNetwork(optionString(options, 'docker-network'));
    const backupContainerName = proofContainerName('url-backup');
    const env = {
      ...process.env,
      CHARITYPILOT_BACKUP_DATABASE_URL: target.databaseUrl,
      CHARITYPILOT_BACKUP_FILE: tempOutputFile,
      CHARITYPILOT_MAX_DUMP_BYTES: String(MAX_DUMP_BYTES),
    };
    const args = [
      'run',
      '--rm',
      '--name',
      backupContainerName,
      ...linuxDockerHostUserArgs(),
      ...(dockerNetwork ? ['--network', dockerNetwork] : []),
      '-e',
      'CHARITYPILOT_BACKUP_DATABASE_URL',
      '-e',
      'CHARITYPILOT_BACKUP_FILE',
      '-e',
      'CHARITYPILOT_MAX_DUMP_BYTES',
      '-v',
      `${outputDir}:/backup`,
      postgresToolsImage(),
      'sh',
      '-lc',
      'umask 077; available_kb=$(df -Pk /backup | awk \'NR == 2 { print $4 }\'); required_kb=$(( (CHARITYPILOT_MAX_DUMP_BYTES + 1023) / 1024 )); [ "$available_kb" -ge "$required_kb" ]; ulimit -f $(( (CHARITYPILOT_MAX_DUMP_BYTES + 511) / 512 )); pg_dump --dbname "$CHARITYPILOT_BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges --file "/backup/$CHARITYPILOT_BACKUP_FILE"; [ "$(wc -c < "/backup/$CHARITYPILOT_BACKUP_FILE")" -le "$CHARITYPILOT_MAX_DUMP_BYTES" ]',
    ];

    runUrlBackup(backupContainerName, args, env, outputPath, dryRun);
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
  const status = lstatSync(absoluteDumpFile);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Dump path is not a file: ${absoluteDumpFile}`);
  }

  return absoluteDumpFile;
}

function restoreContainerName() {
  return `charitypilot-restore-verify-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function restoreDatabaseUrl(password) {
  return `postgresql://${RESTORE_DATABASE_USER}:${encodeURIComponent(password)}@127.0.0.1:5432/${RESTORE_DATABASE_NAME}`;
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
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: PROOF_STDIO_LIMIT_BYTES,
    });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  throw new Error('Timed out waiting for restore verification database to become ready');
}

function verifyRestoredSchema(containerName, password, dryRun) {
  const criticalTableList = CRITICAL_RESTORE_TABLES
    .map((table) => `'${table.replaceAll("'", "''")}'`)
    .join(', ');
  const query = `select table_name from information_schema.tables where table_schema='public' and table_name in (${criticalTableList}) order by table_name;`;
  if (dryRun) console.log(query);
  const queryContainerName = proofContainerName('restore-schema-check');
  const args = [
    'run',
    '--rm',
    '--name',
    queryContainerName,
    ...proofContainerLabelArgs(),
    '--network',
    `container:${containerName}`,
    '-e',
    'CHARITYPILOT_RESTORE_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_QUERY',
    postgresToolsImage(),
    'sh', '-eu', '-c',
    'psql --no-psqlrc --dbname "$CHARITYPILOT_RESTORE_DATABASE_URL" -tAc "$CHARITYPILOT_RESTORE_QUERY"',
  ];

  const stdout = runNamedProofContainer(queryContainerName, args, {
    dryRun,
    env: {
      ...process.env,
      CHARITYPILOT_RESTORE_DATABASE_URL: restoreDatabaseUrl(password),
      CHARITYPILOT_RESTORE_QUERY: query,
    },
  });
  if (dryRun) return;

  const restoredTables = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missingTables = CRITICAL_RESTORE_TABLES.filter((table) => !restoredTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Restore verification is missing critical table(s): ${missingTables.join(', ')}`);
  }

  console.log(`Restore verification found critical tables: ${CRITICAL_RESTORE_TABLES.join(', ')}`);
}

function verifyRestoredReferenceData(containerName, password, dryRun) {
  const query = [
    'select',
    '(select count(*) from "GovernancePrinciple") as principles,',
    '(select count(*) from "GovernanceStandard") as standards,',
    '(select count(*) from "GovernanceStandard" where "isCore" = true) as core_standards,',
    '(select count(*) from "GovernanceStandard" where "isAdditional" = true) as additional_standards,',
    `(select md5(string_agg("number"::text || '|' || "title" || '|' || "description" || '|' || "sortOrder"::text, E'\\n' order by "sortOrder")) from "GovernancePrinciple") as principle_signature,`,
    `(select md5(string_agg(principles."number"::text || '|' || standards."code" || '|' || standards."title" || '|' || standards."isCore"::text || '|' || standards."isAdditional"::text || '|' || standards."sortOrder"::text, E'\\n' order by standards."sortOrder")) from "GovernanceStandard" standards join "GovernancePrinciple" principles on principles."id" = standards."principleId") as standard_signature;`,
  ].join(' ');
  if (dryRun) console.log(query);
  const queryContainerName = proofContainerName('restore-reference-check');
  const args = [
    'run',
    '--rm',
    '--name',
    queryContainerName,
    ...proofContainerLabelArgs(),
    '--network',
    `container:${containerName}`,
    '-e',
    'CHARITYPILOT_RESTORE_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_QUERY',
    postgresToolsImage(),
    'sh', '-eu', '-c',
    'psql --no-psqlrc --dbname "$CHARITYPILOT_RESTORE_DATABASE_URL" -tAc "$CHARITYPILOT_RESTORE_QUERY"',
  ];

  const stdout = runNamedProofContainer(queryContainerName, args, {
    dryRun,
    env: {
      ...process.env,
      CHARITYPILOT_RESTORE_DATABASE_URL: restoreDatabaseUrl(password),
      CHARITYPILOT_RESTORE_QUERY: query,
    },
  });
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

function verifyRestoredOperationalSentinel(containerName, password, dryRun) {
  const sentinel = RESTORE_OPERATIONAL_SENTINEL;
  const query = [
    'select',
    `(select count(*) from "Organisation" where "id" = ${sqlLiteral(sentinel.organisationId)}) as organisations,`,
    `(select count(*) from "User" where "id" = ${sqlLiteral(sentinel.userId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as users,`,
    `(select count(*) from "Document" where "id" = ${sqlLiteral(sentinel.documentId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as documents,`,
    `(select count(*) from "ComplianceRecord" where "id" = ${sqlLiteral(sentinel.complianceRecordId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as compliance_records,`,
    `(select count(*) from "DocumentStorageDeletion" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as document_storage_deletions,`,
    `(select count(*) from "DocumentStorageDeletionRecovery" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryId)} and "deletionId" = ${sqlLiteral(sentinel.documentStorageDeletionId)} and "organisationId" = ${sqlLiteral(sentinel.organisationId)}) as document_storage_deletion_recoveries,`,
    `(select count(*) from "StripeWebhookEvent" where "id" = ${sqlLiteral(sentinel.stripeWebhookEventId)}) as stripe_webhook_events,`,
    `(select md5(concat_ws(E'\\n',`,
    `  coalesce((select concat_ws('|', "id", "name", "contactEmail", "website") from "Organisation" where "id" = ${sqlLiteral(sentinel.organisationId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "email", "name", "role"::text, "organisationId", "emailVerified"::text) from "User" where "id" = ${sqlLiteral(sentinel.userId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "name", "category"::text, "fileUrl", "fileSize"::text, "mimeType", "uploadedById") from "Document" where "id" = ${sqlLiteral(sentinel.documentId)}), ''),`,
    `  coalesce((select concat_ws('|', records."id", records."reportingYear"::text, records."status"::text, standards."code", records."organisationId") from "ComplianceRecord" records join "GovernanceStandard" standards on standards."id" = records."standardId" where records."id" = ${sqlLiteral(sentinel.complianceRecordId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "organisationId", "storagePath", "state"::text, "attempts"::text, "lastRecoveryId", "lastRecoveryNonce", "lastRecoveryDisposition"::text) from "DocumentStorageDeletion" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "recoveryNonce", "deletionId", "organisationId", "actorType"::text, "actorUserId", "reason", "disposition"::text, "previousAttempts"::text, "previousTerminalReason"::text, "previousStoragePath") from "DocumentStorageDeletionRecovery" where "id" = ${sqlLiteral(sentinel.documentStorageDeletionRecoveryId)}), ''),`,
    `  coalesce((select concat_ws('|', "id", "type") from "StripeWebhookEvent" where "id" = ${sqlLiteral(sentinel.stripeWebhookEventId)}), '')`,
    `))) as operational_signature;`,
  ].join(' ');
  if (dryRun) console.log(query);
  const queryContainerName = proofContainerName('restore-sentinel-check');
  const args = [
    'run',
    '--rm',
    '--name',
    queryContainerName,
    ...proofContainerLabelArgs(),
    '--network',
    `container:${containerName}`,
    '-e',
    'CHARITYPILOT_RESTORE_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_QUERY',
    postgresToolsImage(),
    'sh', '-eu', '-c',
    'psql --no-psqlrc --dbname "$CHARITYPILOT_RESTORE_DATABASE_URL" -tAc "$CHARITYPILOT_RESTORE_QUERY"',
  ];

  const stdout = runNamedProofContainer(queryContainerName, args, {
    dryRun,
    env: {
      ...process.env,
      CHARITYPILOT_RESTORE_DATABASE_URL: restoreDatabaseUrl(password),
      CHARITYPILOT_RESTORE_QUERY: query,
    },
  });
  if (dryRun) return;

  const [
    organisations,
    users,
    documents,
    complianceRecords,
    documentStorageDeletions,
    documentStorageDeletionRecoveries,
    stripeWebhookEvents,
    operationalSignature,
  ] = stdout
    .trim()
    .split('|');

  const expectedCounts = [organisations, users, documents, complianceRecords, documentStorageDeletions, documentStorageDeletionRecoveries, stripeWebhookEvents]
    .map((value) => Number.parseInt(value, 10));
  const expectedSignature = restoreOperationalSentinelSignature();
  if (expectedCounts.some((count) => count !== 1) || operationalSignature !== expectedSignature) {
    throw new Error(
      'Restore verification found invalid operational sentinel data: ' +
        `organisations=${organisations}, users=${users}, documents=${documents}, ` +
        `complianceRecords=${complianceRecords}, documentStorageDeletions=${documentStorageDeletions}, ` +
        `documentStorageDeletionRecoveries=${documentStorageDeletionRecoveries}, ` +
        `stripeWebhookEvents=${stripeWebhookEvents}, operationalSignature=${operationalSignature}`,
    );
  }

  console.log('Restore verification found operational sentinel data across organisation, user, document, compliance, storage deletion, deletion recovery, and webhook tables');
}

function verifyRestore(options) {
  const dryRun = isEnabled(options, 'dry-run');
  const expectOperationalSentinel = isEnabled(options, 'expect-operational-sentinel');
  const dumpFile = requireDumpFile(options);
  const dumpDir = dirname(dumpFile);
  const dumpName = basename(dumpFile);
  const containerName = restoreContainerName();
  const restorePassword = randomBytes(32).toString('base64url');
  const startEnv = {
    ...process.env,
    POSTGRES_USER: RESTORE_DATABASE_USER,
    POSTGRES_PASSWORD: restorePassword,
    POSTGRES_DB: RESTORE_DATABASE_NAME,
  };
  const startArgs = [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    ...proofContainerLabelArgs(),
    '--network',
    'none',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=4g',
    '-e',
    'POSTGRES_USER',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB',
    postgresToolsImage(),
  ];
  const restoreEnv = {
    ...process.env,
    CHARITYPILOT_RESTORE_DATABASE_URL: restoreDatabaseUrl(restorePassword),
    CHARITYPILOT_RESTORE_DUMP_FILE: dumpName,
  };
  const restoreLoaderContainerName = proofContainerName('restore-verify-loader');
  const restoreArgs = [
    'run',
    '--rm',
    '--name',
    restoreLoaderContainerName,
    ...proofContainerLabelArgs(),
    '--network',
    `container:${containerName}`,
    '-v',
    `${dumpDir}:/backup:ro`,
    '-e',
    'CHARITYPILOT_RESTORE_DATABASE_URL',
    '-e',
    'CHARITYPILOT_RESTORE_DUMP_FILE',
    postgresToolsImage(),
    'sh', '-eu', '-c',
    'pg_restore --dbname "$CHARITYPILOT_RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-privileges "/backup/$CHARITYPILOT_RESTORE_DUMP_FILE"',
  ];

  let containerStarted = false;

  try {
    containerStarted = runStartRestoreContainer(startArgs, startEnv, dryRun);
    waitForRestoreDatabase(containerName, dryRun);
    runNamedProofContainer(restoreLoaderContainerName, restoreArgs, { dryRun, env: restoreEnv });
    verifyRestoredSchema(containerName, restorePassword, dryRun);
    verifyRestoredReferenceData(containerName, restorePassword, dryRun);
    if (expectOperationalSentinel) {
      verifyRestoredOperationalSentinel(containerName, restorePassword, dryRun);
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
  const nextEnv = { ...env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, nextEnv);

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

function isUsageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /^(Unknown command|Unknown option --|Unexpected argument|Missing value for --|Empty value for --|Duplicate option --|--[^ ]+ does not accept a value|--allow-remote-sentinel has been removed)/.test(message);
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

      if (command === 'source-identity') {
        sourceIdentity(options);
        return;
      }

      if (command === 'prove-restore') {
        await proveRestore(options);
        return;
      }

      throw new Error(`Unknown command: ${command}`);
    });

    return result(0, output.stdout, output.stderr);
  } catch (error) {
    console.error(redactPostgresTranscript(error instanceof Error ? error.message : String(error)));
    console.error(usage().trim());
    return result(isUsageError(error) ? 2 : 1, output.stdout, output.stderr);
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
