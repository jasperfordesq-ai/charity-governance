#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPostgresBackupFromArgs as defaultRunPostgresBackupFromArgs } from './postgres-backup.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const DEFAULT_DUMP_FILE = 'production-check.dump';
const DEFAULT_REPORT_FILE = 'production-check.restore-proof.json';
const MAX_PRODUCTION_ENV_BYTES = 1024 * 1024;
const MAX_PROOF_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_DUMP_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_HELPER_TRANSCRIPT_BYTES = 8 * 1024;
const MAX_HELPER_IMPLEMENTATION_BYTES = 1024 * 1024;
const APPROVED_POSTGRES_TOOLS_IMAGE_REFERENCE =
  'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const APPROVED_POSTGRES_TOOLS_IMAGE_DIGEST_SHA256 =
  '5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const ALLOWED_LIBPQ_QUERY_OPTIONS = new Set([
  'application_name', 'channel_binding', 'connect_timeout', 'gssencmode',
  'keepalives', 'keepalives_count', 'keepalives_idle', 'keepalives_interval',
  'requirepeer', 'sslcert', 'sslcrl', 'sslcrldir', 'sslkey', 'sslmode',
  'sslrootcert', 'target_session_attrs', 'tcp_user_timeout',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const RESTORE_PROOF_MARKER =
  'Production-safe database restore proof passed: source and isolated restore fingerprints match.';
const RESTORE_PROOF_SHA256_PREFIX = 'Proof report SHA-256: ';
const SOURCE_IDENTITY_FORMAT = 'charitypilot-postgres-source-identity/v2';
const RESTORE_PROOF_FORMAT = 'charitypilot-postgres-restore-proof/v2';
const HELPER_IMPLEMENTATION_FORMAT = 'charitypilot-postgres-proof-helper/v1';
const HELPER_IMPLEMENTATION_REPOSITORY_URL = 'https://github.com/jasperfordesq-ai/charity-governance';
const HELPER_IMPLEMENTATION_SOURCE_PATH = 'scripts/postgres-backup.mjs';
const RESTORE_PROOF_PROVENANCE_LIMITATION =
  'This proof verifies a read-only source snapshot against one isolated restore. PostgreSQL ownership and ACL privileges are intentionally excluded by --no-owner and --no-privileges, sequence runtime state is excluded, and provider retention, immutable external custody, document-object recovery, and operator approval remain separate evidence.';
const SEQUENCE_STATE_EXCLUSION_REASON =
  'PostgreSQL sequence values are non-MVCC and cannot be bound to the exported snapshot; this proof therefore fails unless the public schema has zero sequences, identity columns, and nextval defaults.';
const OWNERSHIP_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-owner, so PostgreSQL object ownership is outside this proof.';
const ACL_EXCLUSION_REASON =
  'The custom-format dump is captured and restored with --no-privileges, so PostgreSQL ACL grants and default privileges are outside this proof.';
const MIN_TEMP_FILE_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_TEMP_FILE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PUBLIC_TABLES = 5_000;
const MAX_ROWS_PER_TABLE = 25_000_000;
const MAX_TOTAL_ROWS = 100_000_000;
const PROOF_STATEMENT_TIMEOUT_MS = 1_800_000;
const PROOF_LOCK_TIMEOUT_MS = 30_000;
const PROOF_IDLE_TRANSACTION_TIMEOUT_MS = 2_640_000;
const CAPACITY_PREFLIGHT_METHOD = 'pg-database-size-factor-margin/v1';
const CAPACITY_SAFETY_FACTOR = 2;
const CAPACITY_SAFETY_MARGIN_BYTES = 1024 * 1024 * 1024;
const SOURCE_IDENTITY_WORKLOAD_SAFETY = Object.freeze({
  tempFileLimitBytes: '1073741824',
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 15_000,
  idleTransactionTimeoutMs: 180_000,
});
const SCHEMA_CERTIFICATION_SCOPE = Object.freeze({
  certifiedSchemas: ['public'],
  certifiedDataClasses: [
    'ordinary-table-rows',
    'partitioned-table-own-rows',
    'materialized-view-rows',
  ],
  certifiedObjectClasses: [
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
  ],
  publicSchemaOnly: true,
  nonPublicSchemasIncluded: false,
  largeObjectsIncluded: false,
  largeObjectCount: 0,
  extensionMembershipIncluded: false,
  commentsIncluded: false,
  securityLabelsIncluded: false,
  databaseLevelObjectsIncluded: false,
  exclusions: [
    { scope: 'non-public-schemas', reason: 'Only objects in the public schema are fingerprinted and compared.' },
    { scope: 'large-objects', reason: 'PostgreSQL large objects are excluded and proof fails unless the source and restore contain zero large objects.' },
    { scope: 'extension-membership', reason: 'Extension installation and membership metadata are excluded; supported extension-owned objects in public are fingerprinted by object definition.' },
    { scope: 'comments-and-security-labels', reason: 'Comments and security labels are not recovery-critical application integrity data and are excluded.' },
    { scope: 'database-level-objects', reason: 'Roles, tablespaces, database settings, foreign-data wrappers and servers, publications, subscriptions, and event triggers are excluded.' },
  ],
});
const SOURCE_IDENTITY_PROVENANCE_LIMITATION =
  'The identity digest proves consistency with the supplied source endpoint and read-only server metadata; independent immutable capture and operator control remain external evidence.';
const SOURCE_IDENTITY_PROVENANCE_LINE =
  `Provenance limitation: ${SOURCE_IDENTITY_PROVENANCE_LIMITATION}`;

function usage() {
  return [
    'Usage:',
    '  node scripts/check-production-database.mjs --production-env-file <path> --expected-release-commit-sha <sha> --recovery-set-id <id> --expected-source-database-identity-sha256 <sha256> --backup-output-dir <absolute-protected-path> [--keep-backup] [--json]',
    '  node scripts/check-production-database.mjs --production-env-file <path> --expected-release-commit-sha <sha> --capture-source-identity [--json]',
    '',
    'The removed --expect-operational-sentinel option is rejected because production must not be written.',
    '',
  ].join('\n');
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    productionEnvFile: '.env.production',
    backupOutputDir: null,
    keepBackup: false,
    json: false,
    captureSourceIdentity: false,
    recoverySetId: null,
    expectedSourceDatabaseIdentitySha256: null,
    expectedReleaseCommitSha: null,
  };

  const valueOptions = new Map([
    ['--production-env-file', 'productionEnvFile'],
    ['--backup-output-dir', 'backupOutputDir'],
    ['--recovery-set-id', 'recoverySetId'],
    ['--expected-source-database-identity-sha256', 'expectedSourceDatabaseIdentitySha256'],
    ['--expected-release-commit-sha', 'expectedReleaseCommitSha'],
  ]);
  const seenOptions = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expect-operational-sentinel' || arg.startsWith('--expect-operational-sentinel=')) {
      throw new Error('--expect-operational-sentinel was removed because production sentinel writes are unsafe');
    }
    if (arg === '--keep-backup') {
      if (seenOptions.has('--keep-backup')) throw new Error('--keep-backup must not be repeated');
      seenOptions.add('--keep-backup');
      options.keepBackup = true;
      continue;
    }
    if (arg === '--json') {
      if (seenOptions.has('--json')) throw new Error('--json must not be repeated');
      seenOptions.add('--json');
      options.json = true;
      continue;
    }
    if (arg === '--capture-source-identity') {
      if (seenOptions.has('--capture-source-identity')) throw new Error('--capture-source-identity must not be repeated');
      seenOptions.add('--capture-source-identity');
      options.captureSourceIdentity = true;
      continue;
    }

    let matched = false;
    for (const [flag, key] of valueOptions) {
      if (arg === flag) {
        if (seenOptions.has(flag)) throw new Error(`${flag} must not be repeated`);
        seenOptions.add(flag);
        options[key] = readRequiredValue(argv, index, flag);
        index += 1;
        matched = true;
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        if (seenOptions.has(flag)) throw new Error(`${flag} must not be repeated`);
        seenOptions.add(flag);
        const value = arg.slice(flag.length + 1);
        if (!value) throw new Error(`${flag} requires a value`);
        options[key] = value;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    throw new Error('Unknown argument');
  }

  if (options.captureSourceIdentity) {
    const incompatible = [
      options.recoverySetId && '--recovery-set-id',
      options.expectedSourceDatabaseIdentitySha256 && '--expected-source-database-identity-sha256',
      options.backupOutputDir && '--backup-output-dir',
      options.keepBackup && '--keep-backup',
    ].filter(Boolean);
    if (incompatible.length > 0) {
      throw new Error(`--capture-source-identity cannot be combined with ${incompatible.join(', ')}`);
    }
    if (!options.expectedReleaseCommitSha) throw new Error('--expected-release-commit-sha is required');
    if (!/^[a-f0-9]{40}$/.test(options.expectedReleaseCommitSha)) {
      throw new Error('--expected-release-commit-sha must be a lowercase 40-character git commit SHA');
    }
    return options;
  }

  if (!options.expectedReleaseCommitSha) throw new Error('--expected-release-commit-sha is required');
  if (!/^[a-f0-9]{40}$/.test(options.expectedReleaseCommitSha)) {
    throw new Error('--expected-release-commit-sha must be a lowercase 40-character git commit SHA');
  }

  if (!options.recoverySetId) throw new Error('--recovery-set-id is required');
  if (!IDENTIFIER_PATTERN.test(options.recoverySetId)) {
    throw new Error('--recovery-set-id must be a bounded operational identifier');
  }
  if (!options.expectedSourceDatabaseIdentitySha256) {
    throw new Error('--expected-source-database-identity-sha256 is required');
  }
  if (!SHA256_PATTERN.test(options.expectedSourceDatabaseIdentitySha256)) {
    throw new Error('--expected-source-database-identity-sha256 must be a lowercase SHA-256 digest');
  }
  if (options.keepBackup && !options.backupOutputDir) {
    throw new Error('--keep-backup requires --backup-output-dir so retained artifacts have an explicit destination');
  }
  if (!options.backupOutputDir) {
    throw new Error('--backup-output-dir is required for prove-restore');
  }
  if (!isAbsolute(options.backupOutputDir)) {
    throw new Error('--backup-output-dir must be an absolute protected path');
  }

  return options;
}

function parseEnvFile(path) {
  const { text } = readStableUtf8File(path, 'production env file', MAX_PRODUCTION_ENV_BYTES);
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (Object.hasOwn(values, key)) throw new Error('production env file contains a duplicate key');
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
  return typeof value === 'string' && value.trim().length > 0 &&
    !/REPLACE_ME|change-me|your_|your-|project_ref|TODO|TBD|placeholder/i.test(value);
}

function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocalDatabaseHost(hostname) {
  const normalized = normaliseHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0' ||
    normalized === '::1' || normalized === 'host.docker.internal' || normalized.endsWith('.localhost');
}

function isReservedDocumentationHostname(hostname) {
  const normalized = normaliseHostname(hostname);
  return normalized === 'example.com' || normalized === 'example.net' || normalized === 'example.org' ||
    normalized.endsWith('.example') || normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') || normalized.endsWith('.example.org') ||
    normalized.endsWith('.test') || normalized.endsWith('.invalid');
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
    if (isLocalDatabaseHost(url.hostname)) issues.push('DATABASE_URL must not point at localhost in production');
    if (isReservedDocumentationHostname(url.hostname)) {
      issues.push('DATABASE_URL must not use a reserved documentation hostname');
    }
    if (url.hash) {
      issues.push('DATABASE_URL must not contain a URL fragment');
    }
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const userName = decodeURIComponent(url.username);
    if (!url.hostname || !databaseName || !userName || databaseName.includes('/') || /[,\s]/.test(url.hostname)) {
      issues.push('DATABASE_URL must identify exactly one authority host');
    }
    const seenOptions = new Set();
    for (const [rawName] of url.searchParams) {
      const name = rawName.toLowerCase();
      if (rawName !== name || seenOptions.has(name)) {
        issues.push('DATABASE_URL must not repeat or ambiguously case connection options');
      }
      seenOptions.add(name);
      if (!ALLOWED_LIBPQ_QUERY_OPTIONS.has(name)) {
        issues.push('DATABASE_URL contains an unsupported or routing-sensitive connection option');
      }
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

function proofDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', 'system');
  url.searchParams.set('target_session_attrs', 'read-write');
  return url.toString();
}

function absolutePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function isPathWithinRoot(candidatePath, rootPath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function prospectiveCanonicalPath(path) {
  let existingAncestor = resolve(path);
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(canonicalPath(existingAncestor), ...missingSegments);
}

function assertProtectedProofDirectory(path, { repoRoot, osTempRoots }) {
  if (!isAbsolute(path)) throw new Error('proof artifact directory must be absolute');
  const resolvedPath = resolve(path);
  const forbiddenRoots = [repoRoot, ...osTempRoots].map(canonicalPath);
  if (forbiddenRoots.some((root) =>
    isPathWithinRoot(resolvedPath, root) || isPathWithinRoot(root, resolvedPath))) {
    throw new Error('proof artifact directory must be outside the repository and operating-system temporary storage');
  }
}

function assertOwnerOnlyDirectory(status, { platform, getuid }) {
  if (platform === 'win32') return;
  if ((status.mode & 0o777) !== 0o700) {
    throw new Error('proof artifact directory is not owner-only mode 0700');
  }
  if (typeof getuid === 'function' && status.uid !== getuid()) {
    throw new Error('proof artifact directory is not owned by the current user');
  }
}

function helperEnvironment(databaseUrl, sourceEnv = process.env) {
  const allowedNames = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  ];
  return {
    ...Object.fromEntries(
      allowedNames
        .filter((name) => typeof sourceEnv[name] === 'string' && sourceEnv[name].length > 0)
        .map((name) => [name, sourceEnv[name]]),
    ),
    DATABASE_URL: databaseUrl,
    CHARITYPILOT_POSTGRES_TOOLS_IMAGE: APPROVED_POSTGRES_TOOLS_IMAGE_REFERENCE,
  };
}

function helperFailed(label, commandResult) {
  const status = Number.isSafeInteger(commandResult?.status) && commandResult.status >= 0 && commandResult.status <= 255
    ? ` (exit status ${commandResult.status})`
    : '';
  return result(1, '', `Production database check failed: ${label}${status}. Helper diagnostics were suppressed.\n`);
}

function exactLines(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_HELPER_TRANSCRIPT_BYTES) return [];
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function openStableRegularFile(filePath, label, maxBytes) {
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symbolic file`);
  if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maxBytes) {
    throw new Error(`${label} exceeds its safe byte bound`);
  }
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !sameFile(before, opened)) {
    closeSync(descriptor);
    throw new Error(`${label} changed before it could be read`);
  }
  return { descriptor, opened };
}

function finishStableRead(filePath, descriptor, opened, label) {
  const afterDescriptor = fstatSync(descriptor);
  closeSync(descriptor);
  const afterPath = lstatSync(filePath);
  if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath) || afterPath.isSymbolicLink()) {
    throw new Error(`${label} changed while it was read`);
  }
}

function readStableUtf8File(filePath, label, maxBytes) {
  const { descriptor, opened } = openStableRegularFile(filePath, label, maxBytes);
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`${label} ended before its declared size`);
      offset += count;
    }
    finishStableRead(filePath, descriptor, opened, label);
    try {
      return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      throw new Error(`${label} must contain valid UTF-8`);
    }
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The stable-read success path already closed the descriptor.
    }
    throw error;
  }
}

function readStableProofReport(reportPath) {
  const { bytes, text } = readStableUtf8File(reportPath, 'proof report', MAX_PROOF_REPORT_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('proof report must contain one valid JSON value');
  }
  if (!isPlainObject(parsed)) throw new Error('proof report root must be an object');
  return { parsed, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function normaliseCanonicalRepositoryUrl(value) {
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

function boundedGitResult(repoRoot, args, { binary = false, run = spawnSync } = {}) {
  const commandResult = run('git', ['-C', repoRoot, ...args], {
    encoding: binary ? null : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_HELPER_IMPLEMENTATION_BYTES,
    windowsHide: true,
  });
  if (commandResult?.status !== 0 || commandResult?.error) return null;
  return commandResult.stdout;
}

export function captureExpectedHelperImplementationBinding({
  repoRoot = defaultRepoRoot,
  sourceFile = join(repoRoot, HELPER_IMPLEMENTATION_SOURCE_PATH),
  runGit = spawnSync,
} = {}) {
  const { bytes } = readStableUtf8File(
    sourceFile,
    'PostgreSQL proof helper implementation',
    MAX_HELPER_IMPLEMENTATION_BYTES,
  );
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const commitRaw = boundedGitResult(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { run: runGit });
  const commitSha = typeof commitRaw === 'string' && /^[a-f0-9]{40}\r?\n$/i.test(commitRaw)
    ? commitRaw.trim().toLowerCase()
    : null;
  const committedBytes = commitSha
    ? boundedGitResult(repoRoot, ['show', `${commitSha}:${HELPER_IMPLEMENTATION_SOURCE_PATH}`], {
      binary: true,
      run: runGit,
    })
    : null;
  const commitSourceSha256 = Buffer.isBuffer(committedBytes) && committedBytes.length > 0
    ? createHash('sha256').update(committedBytes).digest('hex')
    : null;
  const originRaw = boundedGitResult(repoRoot, ['remote', 'get-url', 'origin'], { run: runGit });
  return {
    format: HELPER_IMPLEMENTATION_FORMAT,
    repositoryUrl: HELPER_IMPLEMENTATION_REPOSITORY_URL,
    commitSha,
    sourcePath: HELPER_IMPLEMENTATION_SOURCE_PATH,
    sourceSha256,
    commitSourceSha256,
    sourceMatchesCommit: commitSourceSha256 !== null && commitSourceSha256 === sourceSha256,
    canonicalRepositoryMatched: typeof originRaw === 'string' &&
      normaliseCanonicalRepositoryUrl(originRaw) === HELPER_IMPLEMENTATION_REPOSITORY_URL,
  };
}

function validateExpectedHelperImplementation(value, expectedReleaseCommitSha) {
  return hasExactOrderedKeys(value, [
    'format', 'repositoryUrl', 'commitSha', 'sourcePath', 'sourceSha256',
    'commitSourceSha256', 'sourceMatchesCommit', 'canonicalRepositoryMatched',
  ]) && value.format === HELPER_IMPLEMENTATION_FORMAT &&
    value.repositoryUrl === HELPER_IMPLEMENTATION_REPOSITORY_URL &&
    value.commitSha === expectedReleaseCommitSha &&
    value.sourcePath === HELPER_IMPLEMENTATION_SOURCE_PATH &&
    isSha256(value.sourceSha256) && isSha256(value.commitSourceSha256) &&
    value.sourceSha256 === value.commitSourceSha256 && value.sourceMatchesCommit === true &&
    value.canonicalRepositoryMatched === true;
}

function hashStableDump(dumpPath) {
  const { descriptor, opened } = openStableRegularFile(dumpPath, 'database dump', MAX_DUMP_BYTES);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (count <= 0) throw new Error('database dump ended before its declared size');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    finishStableRead(dumpPath, descriptor, opened, 'database dump');
    return { sha256: hash.digest('hex'), bytes: opened.size };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The stable-read success path already closed the descriptor.
    }
    throw error;
  }
}

function hasExactKeys(value, expectedKeys) {
  return isPlainObject(value) && Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function hasExactOrderedKeys(value, expectedKeys) {
  return hasExactKeys(value, expectedKeys) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expectedKeys);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isDecimalString(value, maximumDigits = 24) {
  return typeof value === 'string' && value.length <= maximumDigits && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isBoundedText(value, maximum = 1000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalSha256(domain, values) {
  return sha256Text(JSON.stringify({ domain, values: values.map((value) => String(value)) }));
}

function canonicalTable(table) {
  return {
    schema: table.schema,
    table: table.table,
    relationKind: table.relationKind,
    isPartition: table.isPartition,
    rowCount: table.rowCount,
    schemaSha256: table.schemaSha256,
    rowsSha256: table.rowsSha256,
    tableFingerprintSha256: table.tableFingerprintSha256,
  };
}

function calculatedTableFingerprintSha256(table) {
  return canonicalSha256('charitypilot-table-fingerprint/v2', [
    Buffer.from(table.schema, 'utf8').toString('hex'),
    Buffer.from(table.table, 'utf8').toString('hex'),
    table.relationKind,
    table.isPartition ? 'partition' : 'not-partition',
    table.rowCount,
    table.schemaSha256,
    table.rowsSha256,
  ]);
}

function validateWorkloadSafety(value, { includeProofBounds = false } = {}) {
  const keys = [
    'tempFileLimitBytes', 'maxPublicTables', 'maxRowsPerTable', 'maxTotalRows',
    'maxFingerprintReportBytes',
    ...(includeProofBounds
      ? ['maxDumpBytes', 'statementTimeoutMs', 'lockTimeoutMs', 'idleTransactionTimeoutMs']
      : []),
  ];
  if (!hasExactKeys(value, keys) || !isDecimalString(value.tempFileLimitBytes, 10)) return false;
  const tempFileLimitBytes = BigInt(value.tempFileLimitBytes);
  if (tempFileLimitBytes < BigInt(MIN_TEMP_FILE_LIMIT_BYTES) ||
    tempFileLimitBytes > BigInt(MAX_TEMP_FILE_LIMIT_BYTES) ||
    value.maxPublicTables !== MAX_PUBLIC_TABLES ||
    value.maxRowsPerTable !== MAX_ROWS_PER_TABLE ||
    value.maxTotalRows !== MAX_TOTAL_ROWS ||
    value.maxFingerprintReportBytes !== MAX_PROOF_REPORT_BYTES) return false;
  return !includeProofBounds || (
    value.maxDumpBytes === String(MAX_DUMP_BYTES) &&
    value.statementTimeoutMs === PROOF_STATEMENT_TIMEOUT_MS &&
    value.lockTimeoutMs === PROOF_LOCK_TIMEOUT_MS &&
    value.idleTransactionTimeoutMs === PROOF_IDLE_TRANSACTION_TIMEOUT_MS
  );
}

function validateCapacityPreflight(value) {
  if (!hasExactKeys(value, [
    'method', 'sourceDatabaseSizeBytes', 'safetyFactor', 'safetyMarginBytes',
    'requiredAvailableBytes', 'maximumDumpBytes', 'verified',
  ]) || value.method !== CAPACITY_PREFLIGHT_METHOD ||
    !isDecimalString(value.sourceDatabaseSizeBytes) ||
    value.safetyFactor !== CAPACITY_SAFETY_FACTOR ||
    value.safetyMarginBytes !== String(CAPACITY_SAFETY_MARGIN_BYTES) ||
    !isDecimalString(value.requiredAvailableBytes) ||
    value.maximumDumpBytes !== String(MAX_DUMP_BYTES) || value.verified !== true) return false;
  const sourceDatabaseSizeBytes = BigInt(value.sourceDatabaseSizeBytes);
  const calculatedRequiredBytes =
    sourceDatabaseSizeBytes * BigInt(CAPACITY_SAFETY_FACTOR) + BigInt(CAPACITY_SAFETY_MARGIN_BYTES);
  const expectedRequiredBytes = calculatedRequiredBytes > BigInt(MAX_DUMP_BYTES)
    ? BigInt(MAX_DUMP_BYTES)
    : calculatedRequiredBytes;
  return value.requiredAvailableBytes === expectedRequiredBytes.toString();
}

function validateDatabaseEnvironment(value) {
  if (!hasExactKeys(value, ['encoding', 'collation', 'ctype', 'localeProvider', 'collationVersion'])) {
    return false;
  }
  if (!/^[A-Z0-9_]{1,32}$/.test(value.encoding ?? '') || value.localeProvider !== 'libc') {
    return false;
  }
  for (const locale of [value.collation, value.ctype]) {
    if (typeof locale !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(locale)) {
      return false;
    }
  }
  return value.collationVersion === null || (
    typeof value.collationVersion === 'string' &&
    value.collationVersion.length > 0 &&
    Buffer.byteLength(value.collationVersion, 'utf8') <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value.collationVersion)
  );
}

function validateSchemaCoverage(value, tableCount) {
  if (!hasExactKeys(value, [
    'publicObjectCount', 'unsupportedPublicObjectCount', 'publicSequenceCount',
    'applicationIdentityColumnCount', 'applicationSequenceDefaultCount', 'largeObjectCount',
  ])) return false;
  return Number.isSafeInteger(value.publicObjectCount) && value.publicObjectCount >= tableCount &&
    value.publicObjectCount <= 100_000 && value.unsupportedPublicObjectCount === 0 &&
    value.publicSequenceCount === 0 && value.applicationIdentityColumnCount === 0 &&
    value.applicationSequenceDefaultCount === 0 && value.largeObjectCount === 0;
}

function validateTableEntry(table) {
  if (!hasExactKeys(table, [
    'schema', 'table', 'relationKind', 'isPartition', 'rowCount', 'schemaSha256',
    'rowsSha256', 'tableFingerprintSha256',
  ])) return false;
  return isBoundedText(table.schema, 128) && isBoundedText(table.table, 128) &&
    (table.relationKind === 'r' || table.relationKind === 'p' || table.relationKind === 'm') &&
    typeof table.isPartition === 'boolean' && isDecimalString(table.rowCount, 20) &&
    isSha256(table.schemaSha256) && isSha256(table.rowsSha256) &&
    isSha256(table.tableFingerprintSha256);
}

function validateFingerprint(value, { restored = false } = {}) {
  const keys = [
    'fingerprintReportSha256', 'publicSchemaSha256', 'tableMembershipSha256',
    'databaseFingerprintSha256', 'databaseEnvironment', 'tableCount', 'totalRows', 'workloadSafety',
    'schemaCoverage', 'tables',
    ...(restored ? ['databaseIdentitySha256'] : []),
  ];
  if (!hasExactKeys(value, keys)) return false;
  if (!isSha256(value.fingerprintReportSha256) || !isSha256(value.publicSchemaSha256) ||
    !isSha256(value.tableMembershipSha256) || !isSha256(value.databaseFingerprintSha256) ||
    (restored && !isSha256(value.databaseIdentitySha256)) ||
    !validateDatabaseEnvironment(value.databaseEnvironment) ||
    !Number.isSafeInteger(value.tableCount) || value.tableCount <= 0 || value.tableCount > MAX_PUBLIC_TABLES ||
    !isDecimalString(value.totalRows) || !Array.isArray(value.tables) ||
    value.tables.length !== value.tableCount || !value.tables.every(validateTableEntry)) return false;
  if (!validateWorkloadSafety(value.workloadSafety) ||
    !validateSchemaCoverage(value.schemaCoverage, value.tableCount)) return false;

  const tableNames = new Set();
  let totalRows = 0n;
  for (const table of value.tables) {
    const key = `${table.schema}\u0000${table.table}`;
    if (tableNames.has(key)) return false;
    tableNames.add(key);
    if (table.tableFingerprintSha256 !== calculatedTableFingerprintSha256(table)) return false;
    if (BigInt(table.rowCount) > BigInt(value.workloadSafety.maxRowsPerTable)) return false;
    totalRows += BigInt(table.rowCount);
  }
  if (totalRows.toString() !== value.totalRows ||
    totalRows > BigInt(value.workloadSafety.maxTotalRows)) return false;

  const tableMembershipSha256 = canonicalSha256(
    'charitypilot-public-table-membership/v2',
    value.tables.map((table) => [
      Buffer.from(table.schema, 'utf8').toString('hex'),
      Buffer.from(table.table, 'utf8').toString('hex'),
      table.relationKind,
      table.isPartition ? '1' : '0',
    ].join('|')),
  );
  if (value.tableMembershipSha256 !== tableMembershipSha256) return false;

  const databaseFingerprintSha256 = canonicalSha256('charitypilot-database-fingerprint/v2', [
    value.databaseEnvironment.encoding,
    value.databaseEnvironment.collation,
    value.databaseEnvironment.ctype,
    value.databaseEnvironment.localeProvider,
    value.databaseEnvironment.collationVersion ?? '',
    tableMembershipSha256,
    value.publicSchemaSha256,
    ...value.tables.map((table) => [
      Buffer.from(table.schema, 'utf8').toString('hex'),
      Buffer.from(table.table, 'utf8').toString('hex'),
      table.relationKind,
      table.isPartition ? '1' : '0',
      table.rowCount,
      table.schemaSha256,
      table.rowsSha256,
      table.tableFingerprintSha256,
    ].join('|')),
  ]);
  if (value.databaseFingerprintSha256 !== databaseFingerprintSha256) return false;

  const fingerprintReportSha256 = sha256Text(`${JSON.stringify({
    databaseEnvironment: value.databaseEnvironment,
    publicSchemaSha256: value.publicSchemaSha256,
    tableMembershipSha256,
    databaseFingerprintSha256,
    tableCount: value.tableCount,
    totalRows: value.totalRows,
    workloadSafety: value.workloadSafety,
    schemaCoverage: value.schemaCoverage,
    tables: value.tables.map(canonicalTable),
  }, null, 2)}\n`);
  return value.fingerprintReportSha256 === fingerprintReportSha256;
}

function validateRestoreProofReport(proof, options, dumpEvidence, helperWindow, expectedHelperImplementation) {
  const topLevelKeys = [
    'format', 'ok', 'checksumAlgorithm', 'helperImplementation',
    'toolsImageReference', 'toolsImageDigestSha256',
    'recoverySetId', 'capturedAt',
    'sourceDatabaseIdentitySha256', 'expectedSourceDatabaseIdentitySha256',
    'sourceIdentityBindingMatched', 'sourceReadOnlyVerified', 'snapshot', 'dump',
    'source', 'restored', 'restoreTarget', 'comparison', 'schemaCertificationScope',
    'sequenceStateIncluded',
    'sequenceDefinitionAndOwnershipBound', 'publicSequenceCount',
    'applicationIdentityColumnCount', 'applicationSequenceDefaultCount',
    'sequenceStateExclusionReason', 'ownershipIncluded', 'ownershipExclusionReason',
    'aclPrivilegesIncluded', 'aclPrivilegesExclusionReason', 'workloadSafety',
    'provenanceLimitation', 'secretValuesPrinted',
  ];
  if (!hasExactOrderedKeys(proof, topLevelKeys)) return null;
  if (proof.format !== RESTORE_PROOF_FORMAT || proof.ok !== true || proof.checksumAlgorithm !== 'sha256' ||
    !validateExpectedHelperImplementation(proof.helperImplementation, options.expectedReleaseCommitSha) ||
    JSON.stringify(proof.helperImplementation) !== JSON.stringify(expectedHelperImplementation) ||
    proof.toolsImageReference !== APPROVED_POSTGRES_TOOLS_IMAGE_REFERENCE ||
    proof.toolsImageDigestSha256 !== APPROVED_POSTGRES_TOOLS_IMAGE_DIGEST_SHA256 ||
    proof.recoverySetId !== options.recoverySetId ||
    proof.sourceDatabaseIdentitySha256 !== options.expectedSourceDatabaseIdentitySha256 ||
    proof.expectedSourceDatabaseIdentitySha256 !== options.expectedSourceDatabaseIdentitySha256 ||
    proof.sourceIdentityBindingMatched !== true || proof.sourceReadOnlyVerified !== true ||
    proof.sequenceStateIncluded !== false || proof.sequenceDefinitionAndOwnershipBound !== true ||
    proof.publicSequenceCount !== 0 || proof.applicationIdentityColumnCount !== 0 ||
    proof.applicationSequenceDefaultCount !== 0 ||
    proof.sequenceStateExclusionReason !== SEQUENCE_STATE_EXCLUSION_REASON ||
    proof.ownershipIncluded !== false || proof.ownershipExclusionReason !== OWNERSHIP_EXCLUSION_REASON ||
    proof.aclPrivilegesIncluded !== false || proof.aclPrivilegesExclusionReason !== ACL_EXCLUSION_REASON ||
    !validateWorkloadSafety(proof.workloadSafety, { includeProofBounds: true }) ||
    JSON.stringify(proof.schemaCertificationScope) !== JSON.stringify(SCHEMA_CERTIFICATION_SCOPE) ||
    proof.provenanceLimitation !== RESTORE_PROOF_PROVENANCE_LIMITATION ||
    proof.secretValuesPrinted !== false) return null;

  if (typeof proof.capturedAt !== 'string') return null;
  const capturedAt = new Date(proof.capturedAt);
  if (!Number.isSafeInteger(helperWindow?.startedAtMs) ||
    !Number.isSafeInteger(helperWindow?.completedAtMs) ||
    helperWindow.completedAtMs < helperWindow.startedAtMs ||
    !Number.isFinite(capturedAt.getTime()) || capturedAt.toISOString() !== proof.capturedAt ||
    capturedAt.getTime() < helperWindow.startedAtMs ||
    capturedAt.getTime() > helperWindow.completedAtMs) return null;

  if (!hasExactKeys(proof.snapshot, [
    'isolationLevel', 'readOnly', 'rowSecurityOff', 'accessShareLocks', 'exported', 'snapshotIdSha256',
  ]) || proof.snapshot.isolationLevel !== 'repeatable read' || proof.snapshot.readOnly !== true ||
    proof.snapshot.rowSecurityOff !== true || proof.snapshot.accessShareLocks !== true ||
    proof.snapshot.exported !== true || !isSha256(proof.snapshot.snapshotIdSha256)) return null;

  if (!hasExactKeys(proof.dump, [
    'fileName', 'sha256', 'bytes', 'descriptorSha256', 'descriptorEntryCount',
    'rehashAfterRestoreSha256', 'bytesAfterRestore', 'descriptorAfterRestoreSha256',
    'unchangedDuringProof', 'sourceBindingSha256', 'capacityPreflight',
  ]) || proof.dump.fileName !== DEFAULT_DUMP_FILE || proof.dump.sha256 !== dumpEvidence.sha256 ||
    proof.dump.bytes !== String(dumpEvidence.bytes) || !isSha256(proof.dump.descriptorSha256) ||
    !Number.isSafeInteger(proof.dump.descriptorEntryCount) || proof.dump.descriptorEntryCount <= 0 ||
    proof.dump.descriptorEntryCount > 1_000_000 ||
    proof.dump.rehashAfterRestoreSha256 !== proof.dump.sha256 ||
    proof.dump.bytesAfterRestore !== proof.dump.bytes ||
    proof.dump.descriptorAfterRestoreSha256 !== proof.dump.descriptorSha256 ||
    proof.dump.unchangedDuringProof !== true || !isSha256(proof.dump.sourceBindingSha256) ||
    !validateCapacityPreflight(proof.dump.capacityPreflight)) return null;

  if (!validateFingerprint(proof.source) || !validateFingerprint(proof.restored, { restored: true })) return null;
  if (proof.publicSequenceCount !== proof.source.schemaCoverage.publicSequenceCount ||
    proof.applicationIdentityColumnCount !== proof.source.schemaCoverage.applicationIdentityColumnCount ||
    proof.applicationSequenceDefaultCount !== proof.source.schemaCoverage.applicationSequenceDefaultCount ||
    JSON.stringify(proof.workloadSafety) !== JSON.stringify({
      ...proof.source.workloadSafety,
      maxDumpBytes: String(MAX_DUMP_BYTES),
      statementTimeoutMs: PROOF_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: PROOF_LOCK_TIMEOUT_MS,
      idleTransactionTimeoutMs: PROOF_IDLE_TRANSACTION_TIMEOUT_MS,
    })) return null;
  const calculatedSourceBindingSha256 = sha256Text([
    'charitypilot-source-dump-binding/v2',
    options.recoverySetId,
    options.expectedSourceDatabaseIdentitySha256,
    proof.helperImplementation.sourceSha256,
    proof.helperImplementation.commitSha,
    proof.dump.sha256,
    proof.dump.bytes,
    proof.dump.descriptorSha256,
    proof.source.databaseFingerprintSha256,
    proof.source.fingerprintReportSha256,
  ].join('\n'));
  if (proof.dump.sourceBindingSha256 !== calculatedSourceBindingSha256) return null;
  const sourceComparable = {
    databaseEnvironment: proof.source.databaseEnvironment,
    publicSchemaSha256: proof.source.publicSchemaSha256,
    tableMembershipSha256: proof.source.tableMembershipSha256,
    databaseFingerprintSha256: proof.source.databaseFingerprintSha256,
    tableCount: proof.source.tableCount,
    totalRows: proof.source.totalRows,
    workloadSafety: proof.source.workloadSafety,
    schemaCoverage: proof.source.schemaCoverage,
    tables: proof.source.tables,
  };
  const restoredComparable = {
    databaseEnvironment: proof.restored.databaseEnvironment,
    publicSchemaSha256: proof.restored.publicSchemaSha256,
    tableMembershipSha256: proof.restored.tableMembershipSha256,
    databaseFingerprintSha256: proof.restored.databaseFingerprintSha256,
    tableCount: proof.restored.tableCount,
    totalRows: proof.restored.totalRows,
    workloadSafety: proof.restored.workloadSafety,
    schemaCoverage: proof.restored.schemaCoverage,
    tables: proof.restored.tables,
  };
  if (JSON.stringify(sourceComparable) !== JSON.stringify(restoredComparable)) return null;

  if (!hasExactKeys(proof.restoreTarget, [
    'type', 'identitySha256', 'databaseEnvironment', 'initializedFromSourceDatabaseEnvironment',
    'databaseEnvironmentPreserved', 'networkPublished', 'hostVolumeForDatabase', 'ephemeralData',
    'productionOverwritten', 'cleanupVerified',
  ]) || proof.restoreTarget.type !== 'isolated-disposable-postgresql' ||
    !isSha256(proof.restoreTarget.identitySha256) ||
    proof.restoreTarget.identitySha256 !== proof.restored.databaseIdentitySha256 ||
    proof.restoreTarget.identitySha256 === proof.sourceDatabaseIdentitySha256 ||
    !validateDatabaseEnvironment(proof.restoreTarget.databaseEnvironment) ||
    JSON.stringify(proof.restoreTarget.databaseEnvironment) !== JSON.stringify(proof.source.databaseEnvironment) ||
    proof.restoreTarget.initializedFromSourceDatabaseEnvironment !== true ||
    proof.restoreTarget.databaseEnvironmentPreserved !== true ||
    proof.restoreTarget.networkPublished !== false || proof.restoreTarget.hostVolumeForDatabase !== false ||
    proof.restoreTarget.ephemeralData !== true || proof.restoreTarget.productionOverwritten !== false ||
    proof.restoreTarget.cleanupVerified !== true) return null;

  if (!hasExactKeys(proof.comparison, [
    'databaseEnvironmentMatched', 'tableMembershipMatched', 'schemaMatched', 'rowCountsMatched', 'rowFingerprintsMatched',
    'databaseFingerprintMatched', 'tablesCompared', 'mismatchCount',
  ]) || proof.comparison.databaseEnvironmentMatched !== true ||
    proof.comparison.tableMembershipMatched !== true || proof.comparison.schemaMatched !== true ||
    proof.comparison.rowCountsMatched !== true || proof.comparison.rowFingerprintsMatched !== true ||
    proof.comparison.databaseFingerprintMatched !== true ||
    proof.comparison.tablesCompared !== proof.source.tableCount || proof.comparison.mismatchCount !== 0) return null;

  return {
    capturedAt: proof.capturedAt,
    helperImplementation: proof.helperImplementation,
    toolsImageReference: proof.toolsImageReference,
    toolsImageDigestSha256: proof.toolsImageDigestSha256,
    sourceIdentityBindingMatched: proof.sourceIdentityBindingMatched,
    databaseDumpSha256: proof.dump.sha256,
    databaseDumpBytes: proof.dump.bytes,
    capacityPreflight: proof.dump.capacityPreflight,
    dumpDescriptorSha256: proof.dump.descriptorSha256,
    dumpSourceBindingSha256: proof.dump.sourceBindingSha256,
    sourceDatabaseFingerprintSha256: proof.source.databaseFingerprintSha256,
    restoredDatabaseFingerprintSha256: proof.restored.databaseFingerprintSha256,
    sourceDatabaseEnvironment: proof.source.databaseEnvironment,
    restoredDatabaseEnvironment: proof.restored.databaseEnvironment,
    restoreTargetDatabaseEnvironment: proof.restoreTarget.databaseEnvironment,
    restoreInitializedFromSourceDatabaseEnvironment: proof.restoreTarget.initializedFromSourceDatabaseEnvironment,
    databaseEnvironmentPreserved: proof.restoreTarget.databaseEnvironmentPreserved,
    databaseEnvironmentMatched: proof.comparison.databaseEnvironmentMatched,
    publicSchemaSha256: proof.source.publicSchemaSha256,
    tableMembershipSha256: proof.source.tableMembershipSha256,
    snapshotIdSha256: proof.snapshot.snapshotIdSha256,
    isolatedRestoreDatabaseIdentitySha256: proof.restored.databaseIdentitySha256,
    tablesCompared: proof.comparison.tablesCompared,
    mismatchCount: proof.comparison.mismatchCount,
    sequenceStateIncluded: proof.sequenceStateIncluded,
    sequenceDefinitionAndOwnershipBound: proof.sequenceDefinitionAndOwnershipBound,
    publicSequenceCount: proof.publicSequenceCount,
    applicationIdentityColumnCount: proof.applicationIdentityColumnCount,
    applicationSequenceDefaultCount: proof.applicationSequenceDefaultCount,
    sequenceStateExclusionReason: proof.sequenceStateExclusionReason,
    ownershipIncluded: proof.ownershipIncluded,
    ownershipExclusionReason: proof.ownershipExclusionReason,
    aclPrivilegesIncluded: proof.aclPrivilegesIncluded,
    aclPrivilegesExclusionReason: proof.aclPrivilegesExclusionReason,
    workloadSafety: proof.workloadSafety,
    schemaCoverage: proof.source.schemaCoverage,
    schemaCertificationScope: proof.schemaCertificationScope,
  };
}

function parseSourceIdentity(stdout, expectedHelperImplementation, expectedReleaseCommitSha) {
  const lines = exactLines(stdout);
  if (lines.length !== 1) return null;
  let payload;
  try {
    payload = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!hasExactOrderedKeys(payload, [
    'format', 'ok', 'checksumAlgorithm', 'helperImplementation',
    'toolsImageReference', 'toolsImageDigestSha256',
    'sourceDatabaseIdentitySha256', 'sourceReadOnlyVerified', 'workloadSafety',
    'secretValuesPrinted', 'provenanceLimitation',
  ]) || payload.format !== SOURCE_IDENTITY_FORMAT || payload.ok !== true || payload.checksumAlgorithm !== 'sha256' ||
    !validateExpectedHelperImplementation(payload.helperImplementation, expectedReleaseCommitSha) ||
    JSON.stringify(payload.helperImplementation) !== JSON.stringify(expectedHelperImplementation) ||
    payload.toolsImageReference !== APPROVED_POSTGRES_TOOLS_IMAGE_REFERENCE ||
    payload.toolsImageDigestSha256 !== APPROVED_POSTGRES_TOOLS_IMAGE_DIGEST_SHA256 ||
    !isSha256(payload.sourceDatabaseIdentitySha256) || payload.sourceReadOnlyVerified !== true ||
    JSON.stringify(payload.workloadSafety) !== JSON.stringify(SOURCE_IDENTITY_WORKLOAD_SAFETY) ||
    payload.secretValuesPrinted !== false ||
    payload.provenanceLimitation !== SOURCE_IDENTITY_PROVENANCE_LIMITATION) return null;
  return payload;
}

function parseHelperProofReportSha256(stdout) {
  const digestLines = exactLines(stdout).filter((line) => line.startsWith(RESTORE_PROOF_SHA256_PREFIX));
  if (digestLines.length !== 1) return null;
  const digest = digestLines[0].slice(RESTORE_PROOF_SHA256_PREFIX.length);
  return SHA256_PATTERN.test(digest) ? digest : null;
}

function sourceIdentitySuccess(options, helperPayload) {
  const payload = {
    format: SOURCE_IDENTITY_FORMAT,
    ok: true,
    mode: 'capture-source-identity',
    checksumAlgorithm: 'sha256',
    expectedReleaseCommitSha: options.expectedReleaseCommitSha,
    helperImplementation: helperPayload.helperImplementation,
    toolsImageReference: APPROVED_POSTGRES_TOOLS_IMAGE_REFERENCE,
    toolsImageDigestSha256: APPROVED_POSTGRES_TOOLS_IMAGE_DIGEST_SHA256,
    sourceDatabaseIdentitySha256: helperPayload.sourceDatabaseIdentitySha256,
    sourceReadOnlyVerified: true,
    sourceTlsServerAuthenticationVerified: true,
    restoreProofVerified: false,
    productionWritten: false,
    secretValuesPrinted: false,
    provenanceLimitation: SOURCE_IDENTITY_PROVENANCE_LIMITATION,
  };
  if (options.json) return result(0, `${JSON.stringify(payload)}\n`, '');
  return result(0, [
    'Production source database identity capture passed: a read-only SHA-256 source identity was captured; production was not written.',
    `Release commit SHA: ${options.expectedReleaseCommitSha}`,
    `Helper implementation source SHA-256: ${helperPayload.helperImplementation.sourceSha256}`,
    `Source database identity SHA-256: ${helperPayload.sourceDatabaseIdentitySha256}`,
    'Source TLS server authentication verified: true.',
    'This capture does not prove restore recovery.',
    SOURCE_IDENTITY_PROVENANCE_LINE,
    '',
  ].join('\n'), '');
}

function restoreProofSuccess(options, evidence, proofReportSha256) {
  const payload = {
    format: RESTORE_PROOF_FORMAT,
    ok: true,
    mode: 'prove-restore',
    proof: 'snapshot-bound-read-only-source-restored-sha256-reconciliation',
    checksumAlgorithm: 'sha256',
    expectedReleaseCommitSha: options.expectedReleaseCommitSha,
    helperImplementation: evidence.helperImplementation,
    toolsImageReference: evidence.toolsImageReference,
    toolsImageDigestSha256: evidence.toolsImageDigestSha256,
    snapshotBound: true,
    sourceReadOnlyVerified: true,
    sourceTlsServerAuthenticationVerified: true,
    sourceAndIsolatedRestoreFingerprintsMatch: true,
    productionWritten: false,
    recoverySetId: options.recoverySetId,
    capturedAt: evidence.capturedAt,
    expectedSourceDatabaseIdentitySha256: options.expectedSourceDatabaseIdentitySha256,
    sourceDatabaseIdentitySha256: options.expectedSourceDatabaseIdentitySha256,
    sourceIdentityBindingMatched: evidence.sourceIdentityBindingMatched,
    databaseDumpSha256: evidence.databaseDumpSha256,
    databaseDumpBytes: evidence.databaseDumpBytes,
    capacityPreflight: evidence.capacityPreflight,
    dumpDescriptorSha256: evidence.dumpDescriptorSha256,
    dumpSourceBindingSha256: evidence.dumpSourceBindingSha256,
    proofReportSha256,
    sourceDatabaseFingerprintSha256: evidence.sourceDatabaseFingerprintSha256,
    restoredDatabaseFingerprintSha256: evidence.restoredDatabaseFingerprintSha256,
    sourceDatabaseEnvironment: evidence.sourceDatabaseEnvironment,
    restoredDatabaseEnvironment: evidence.restoredDatabaseEnvironment,
    restoreTargetDatabaseEnvironment: evidence.restoreTargetDatabaseEnvironment,
    restoreInitializedFromSourceDatabaseEnvironment: evidence.restoreInitializedFromSourceDatabaseEnvironment,
    databaseEnvironmentPreserved: evidence.databaseEnvironmentPreserved,
    databaseEnvironmentMatched: evidence.databaseEnvironmentMatched,
    publicSchemaSha256: evidence.publicSchemaSha256,
    tableMembershipSha256: evidence.tableMembershipSha256,
    snapshotIdSha256: evidence.snapshotIdSha256,
    isolatedRestoreDatabaseIdentitySha256: evidence.isolatedRestoreDatabaseIdentitySha256,
    tablesCompared: evidence.tablesCompared,
    mismatchCount: evidence.mismatchCount,
    sequenceStateIncluded: evidence.sequenceStateIncluded,
    sequenceDefinitionAndOwnershipBound: evidence.sequenceDefinitionAndOwnershipBound,
    publicSequenceCount: evidence.publicSequenceCount,
    applicationIdentityColumnCount: evidence.applicationIdentityColumnCount,
    applicationSequenceDefaultCount: evidence.applicationSequenceDefaultCount,
    sequenceStateExclusionReason: evidence.sequenceStateExclusionReason,
    ownershipIncluded: evidence.ownershipIncluded,
    ownershipExclusionReason: evidence.ownershipExclusionReason,
    aclPrivilegesIncluded: evidence.aclPrivilegesIncluded,
    aclPrivilegesExclusionReason: evidence.aclPrivilegesExclusionReason,
    workloadSafety: evidence.workloadSafety,
    schemaCoverage: evidence.schemaCoverage,
    schemaCertificationScope: evidence.schemaCertificationScope,
    backupArtifactsRetained: options.keepBackup,
    secretValuesPrinted: false,
    provenanceLimitation: RESTORE_PROOF_PROVENANCE_LIMITATION,
  };
  if (options.json) return result(0, `${JSON.stringify(payload)}\n`, '');
  return result(0, [
    'Production database restore proof passed: snapshot-bound read-only source/restored SHA-256 reconciliation passed; production was not written.',
    `Release commit SHA: ${options.expectedReleaseCommitSha}`,
    `Helper implementation source SHA-256: ${evidence.helperImplementation.sourceSha256}`,
    'Source TLS server authentication verified: true.',
    `Recovery set ID: ${options.recoverySetId}`,
    `Expected source database identity SHA-256: ${options.expectedSourceDatabaseIdentitySha256}`,
    `Actual source database identity SHA-256: ${options.expectedSourceDatabaseIdentitySha256}`,
    `Proof captured at: ${evidence.capturedAt}`,
    `Database dump SHA-256: ${evidence.databaseDumpSha256}`,
    `Proof report SHA-256: ${proofReportSha256}`,
    `Source database fingerprint SHA-256: ${evidence.sourceDatabaseFingerprintSha256}`,
    `Restored database fingerprint SHA-256: ${evidence.restoredDatabaseFingerprintSha256}`,
    `Database environment preserved: ${evidence.databaseEnvironmentMatched}; encoding: ${evidence.sourceDatabaseEnvironment.encoding}; collation: ${evidence.sourceDatabaseEnvironment.collation}; ctype: ${evidence.sourceDatabaseEnvironment.ctype}; locale provider: ${evidence.sourceDatabaseEnvironment.localeProvider}.`,
    `Public schema SHA-256: ${evidence.publicSchemaSha256}`,
    `Tables compared: ${evidence.tablesCompared}; mismatch count: ${evidence.mismatchCount}`,
    `Sequence coverage: current values excluded; public sequences: ${evidence.publicSequenceCount}; identity columns: ${evidence.applicationIdentityColumnCount}; nextval defaults: ${evidence.applicationSequenceDefaultCount}.`,
    `Ownership included: ${evidence.ownershipIncluded}; ACL privileges included: ${evidence.aclPrivilegesIncluded}.`,
    `Provenance limitation: ${RESTORE_PROOF_PROVENANCE_LIMITATION}`,
    options.keepBackup
      ? 'Proof artifacts were retained in the caller-selected output directory.'
      : 'Temporary proof artifacts were deleted.',
    '',
  ].join('\n'), '');
}

export async function runProductionDatabaseCheckFromArgs(
  args = process.argv.slice(2),
  {
    runPostgresBackupFromArgs = defaultRunPostgresBackupFromArgs,
    repoRoot = defaultRepoRoot,
    osTempRoots = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])],
    platform = process.platform,
    getuid = process.getuid,
    now = Date.now,
    captureHelperImplementationBinding = null,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error instanceof Error ? error.message : 'Invalid arguments'}\n`);
  }

  let env;
  try {
    env = parseEnvFile(resolve(process.cwd(), options.productionEnvFile));
  } catch {
    return result(1, '', 'Production database check failed: the production env file could not be read.\n');
  }

  const issues = databaseUrlIssues(env.DATABASE_URL);
  if (issues.length > 0) {
    return result(1, '', `Production database check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}\n`);
  }

  const helperEnv = helperEnvironment(proofDatabaseUrl(env.DATABASE_URL));
  const captureImplementation = captureHelperImplementationBinding ??
    (() => captureExpectedHelperImplementationBinding({ repoRoot }));
  if (options.captureSourceIdentity) {
    let helperImplementationBefore;
    try {
      helperImplementationBefore = captureImplementation();
      if (!validateExpectedHelperImplementation(helperImplementationBefore, options.expectedReleaseCommitSha)) {
        throw new Error('unapproved helper implementation');
      }
    } catch {
      return result(1, '', 'Production database check failed: the approved helper implementation could not be bound to the expected release commit.\n');
    }
    let helperResult;
    let helperThrew = false;
    try {
      helperResult = await runPostgresBackupFromArgs(['source-identity', '--json'], helperEnv);
    } catch {
      helperThrew = true;
    }
    try {
      const helperImplementationAfter = captureImplementation();
      if (!validateExpectedHelperImplementation(helperImplementationAfter, options.expectedReleaseCommitSha) ||
        JSON.stringify(helperImplementationAfter) !== JSON.stringify(helperImplementationBefore)) {
        throw new Error('helper implementation drift');
      }
    } catch {
      return result(1, '', 'Production database check failed: the helper implementation changed or lost its release binding during source identity capture.\n');
    }
    if (helperThrew) {
      return result(1, '', 'Production database check failed: source identity capture helper threw an error. Helper diagnostics were suppressed.\n');
    }
    if (helperResult?.status !== 0) return helperFailed('source identity capture helper failed', helperResult);
    if (helperResult.stderr !== '') {
      return result(1, '', 'Production database check failed: source identity helper emitted an unsafe success transcript. Helper diagnostics were suppressed.\n');
    }
    const identityEvidence = parseSourceIdentity(
      helperResult.stdout,
      helperImplementationBefore,
      options.expectedReleaseCommitSha,
    );
    if (!identityEvidence) {
      return result(1, '', 'Production database check failed: source identity helper did not emit the required allowlisted JSON identity evidence. Helper diagnostics were suppressed.\n');
    }
    return sourceIdentitySuccess(options, identityEvidence);
  }

  let backupDir;
  let directoryExisted;
  let removeWholeDirectory;
  let dumpPath;
  let reportPath;
  try {
    backupDir = absolutePath(options.backupOutputDir);
    if (existsSync(backupDir) && lstatSync(backupDir).isSymbolicLink()) {
      throw new Error('unsafe proof artifact directory');
    }
    backupDir = prospectiveCanonicalPath(backupDir);
    assertProtectedProofDirectory(backupDir, { repoRoot, osTempRoots });
    directoryExisted = existsSync(backupDir);
    if (directoryExisted) {
      const directoryStatus = lstatSync(backupDir);
      if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
        throw new Error('unsafe proof artifact directory');
      }
      assertOwnerOnlyDirectory(directoryStatus, { platform, getuid });
    }
    removeWholeDirectory = !directoryExisted;
    dumpPath = join(backupDir, DEFAULT_DUMP_FILE);
    reportPath = join(backupDir, DEFAULT_REPORT_FILE);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (!directoryExisted) {
      try {
        chmodSync(backupDir, 0o700);
      } catch (error) {
        if (platform !== 'win32') throw error;
      }
    }
    backupDir = realpathSync(backupDir);
    assertProtectedProofDirectory(backupDir, { repoRoot, osTempRoots });
    const preparedStatus = lstatSync(backupDir);
    if (!preparedStatus.isDirectory() || preparedStatus.isSymbolicLink()) {
      throw new Error('unsafe proof artifact directory');
    }
    assertOwnerOnlyDirectory(preparedStatus, { platform, getuid });
    dumpPath = join(backupDir, DEFAULT_DUMP_FILE);
    reportPath = join(backupDir, DEFAULT_REPORT_FILE);
  } catch {
    return result(1, '', 'Production database check failed: the proof artifact directory could not be prepared.\n');
  }

  if (existsSync(dumpPath) || existsSync(reportPath)) {
    return result(1, '', 'Production database check failed: proof artifact names already exist in the selected output directory.\n');
  }

  try {
    const helperArgs = [
      'prove-restore',
      `--recovery-set-id=${options.recoverySetId}`,
      `--expected-source-database-identity-sha256=${options.expectedSourceDatabaseIdentitySha256}`,
      `--output-dir=${backupDir}`,
      `--output-file=${DEFAULT_DUMP_FILE}`,
      `--report-file=${DEFAULT_REPORT_FILE}`,
    ];
    let helperImplementationBefore;
    try {
      helperImplementationBefore = captureImplementation();
      if (!validateExpectedHelperImplementation(helperImplementationBefore, options.expectedReleaseCommitSha)) {
        throw new Error('unapproved helper implementation');
      }
    } catch {
      return result(1, '', 'Production database check failed: the approved helper implementation could not be bound to the expected release commit.\n');
    }
    let helperResult;
    let helperStartedAtMs;
    let helperCompletedAtMs;
    let helperThrew = false;
    try {
      helperStartedAtMs = now();
      helperResult = await runPostgresBackupFromArgs(helperArgs, helperEnv);
    } catch {
      helperThrew = true;
    } finally {
      helperCompletedAtMs = now();
    }
    try {
      const helperImplementationAfter = captureImplementation();
      if (!validateExpectedHelperImplementation(helperImplementationAfter, options.expectedReleaseCommitSha) ||
        JSON.stringify(helperImplementationAfter) !== JSON.stringify(helperImplementationBefore)) {
        throw new Error('helper implementation drift');
      }
    } catch {
      return result(1, '', 'Production database check failed: the helper implementation changed or lost its release binding during restore proof execution.\n');
    }
    if (helperThrew) {
      return result(1, '', 'Production database check failed: database restore proof helper threw an error. Helper diagnostics were suppressed.\n');
    }
    if (helperResult?.status !== 0) return helperFailed('database restore proof helper failed', helperResult);
    const helperLines = exactLines(helperResult.stdout);
    if (helperResult.stderr !== '') {
      return result(1, '', 'Production database check failed: database restore proof helper emitted an unsafe success transcript. Helper diagnostics were suppressed.\n');
    }
    if (helperLines.length !== 3 || helperLines[0] !== RESTORE_PROOF_MARKER) {
      return result(1, '', 'Production database check failed: database restore proof helper did not emit the required safe success marker. Helper diagnostics were suppressed.\n');
    }
    if (helperLines[2] !== `Proof report file: ${DEFAULT_REPORT_FILE}`) {
      return result(1, '', 'Production database check failed: database restore proof helper did not identify the expected proof report. Helper diagnostics were suppressed.\n');
    }

    try {
      const dumpEvidence = hashStableDump(dumpPath);
      const reportEvidence = readStableProofReport(reportPath);
      const helperProofReportSha256 = parseHelperProofReportSha256(helperResult.stdout);
      if (!helperProofReportSha256 || helperProofReportSha256 !== reportEvidence.sha256) {
        throw new Error('proof report digest mismatch');
      }
      const validatedEvidence = validateRestoreProofReport(reportEvidence.parsed, options, dumpEvidence, {
        startedAtMs: helperStartedAtMs,
        completedAtMs: helperCompletedAtMs,
      }, helperImplementationBefore);
      if (!validatedEvidence) throw new Error('invalid proof report');
      return restoreProofSuccess(options, validatedEvidence, reportEvidence.sha256);
    } catch {
      return result(1, '', 'Production database check failed: database restore proof evidence was missing, malformed, unstable, or inconsistent. Helper diagnostics were suppressed.\n');
    }
  } finally {
    if (!options.keepBackup) {
      try {
        if (!removeWholeDirectory) {
          rmSync(dumpPath, { force: true });
          rmSync(reportPath, { force: true });
        } else {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        return result(1, '', 'Production database check failed: temporary proof artifacts could not be deleted.\n');
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkResult = await runProductionDatabaseCheckFromArgs();
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  process.exit(checkResult.status);
}
