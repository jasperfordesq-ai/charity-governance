#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanupPersonalServerRecoveryStaging,
  encryptPersonalServerArtifact,
  hmacPersonalServerRecoveryManifest,
  inspectPersonalServerDocumentArchive,
  loadPersonalServerEncryptionKey,
  personalServerRecoveryFormats,
  verifyPersonalServerRecoverySet,
} from './personal-server-recovery.mjs';
import { validateTailscalePrivateAccess } from './personal-server-certify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const ENV_FILE_NAME = '.env.personal-server';
const LOCATION_POINTER_FILE_NAME = 'personal-server-location.json';
const COMPOSE_FILE_NAME = 'compose.personal-server.yml';
const PROJECT_NAME = 'charitypilot-personal-server';
const DATABASE_VOLUME = 'charitypilot-personal-server-db';
const DOCUMENT_VOLUME = 'charitypilot-personal-server-documents';
const INTERNAL_NETWORK = 'charitypilot-personal-server-internal';
const DOCUMENT_ARCHIVE_IMAGE = 'alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
const POSTGRES_IMAGE = 'postgres:16.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const CADDY_IMAGE = 'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const REQUIRED_RUNTIME_SERVICES = ['db', 'api', 'web', 'caddy'];
const WRITER_SERVICES = ['caddy', 'web', 'api'];
const BUILD_SERVICES = ['migrate', 'api', 'web'];
const MAX_ENV_BYTES = 64 * 1024;
const DEFAULT_WAIT_SECONDS = 180;
const MAX_DECOMMISSION_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RECOVERY_CLOCK_SKEW_MS = 5 * 60 * 1000;
const STALE_OPERATION_LOCK_AGE_MS = 15 * 60 * 1000;
const MAX_PENDING_UPDATE_RESUME_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INSTALLATION_PHASES = new Set([
  'initializing',
  'restore-prepared',
  'replacement-restoring',
  'initialized-backup-pending',
  'failed',
  'ready',
  'updating',
  'restoring',
  'decommissioning',
  'decommissioned',
]);
const APPLICATION_DOCUMENT_INVENTORY_SCRIPT = `
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { StorageService } from './dist/services/storage.service.js';
const prisma = new PrismaClient();
try {
  const rows = await prisma.document.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, organisationId: true, fileUrl: true, fileSize: true },
  });
  const storage = new StorageService();
  const documents = [];
  for (const row of rows) {
    const bytes = await storage.downloadFile(row.organisationId, row.fileUrl);
    documents.push({
      id: row.id,
      organisationId: row.organisationId,
      storagePath: row.fileUrl,
      recordedBytes: row.fileSize,
      actualBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  console.log(JSON.stringify({ format: 'charitypilot-personal-document-inventory/v1', documents }));
} catch {
  console.error('Personal-server application document reconciliation failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
`;
const PERSONAL_INITIALIZATION_STATE_SCRIPT = `
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const [organisationCount, userCount, subscriptionCount, owner] = await Promise.all([
    prisma.organisation.count(),
    prisma.user.count(),
    prisma.subscription.count(),
    prisma.user.findUnique({
      where: { email: process.env.PERSONAL_SERVER_OWNER_EMAIL },
      select: { email: true, role: true, emailVerified: true },
    }),
  ]);
  console.log(JSON.stringify({
    format: 'charitypilot-personal-server-initialization-state/v1',
    organisationCount,
    userCount,
    subscriptionCount,
    owner,
  }));
} finally {
  await prisma.$disconnect();
}
`;
const DISPOSABLE_FULL_APPLICATION_PROBE_SCRIPT = `
import { createHash } from 'node:crypto';
const base = 'http://caddy:8080';
const origin = process.env.CHARITYPILOT_PROBE_ORIGIN;
const email = process.env.CHARITYPILOT_PROBE_OWNER_EMAIL;
const password = process.env.CHARITYPILOT_PROBE_OWNER_PASSWORD;
const page = await fetch(base + '/login', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
const pageBody = await page.text();
if (page.status !== 200) throw new Error('compiled web login page did not return HTTP 200 through disposable Caddy');
if (page.headers.get('x-charitypilot-deployment') !== 'personal-server') {
  throw new Error('disposable Caddy did not emit the personal-server deployment header');
}
const robots = (page.headers.get('x-robots-tag') || '').toLowerCase();
if (!robots.includes('noindex') || !robots.includes('nofollow')) {
  throw new Error('disposable Caddy did not emit the private noindex and nofollow policy');
}
if (!pageBody.includes('Welcome back') || !pageBody.includes('private CharityPilot server')) {
  throw new Error('compiled web response did not contain the expected private login markers');
}
const login = await fetch(base + '/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(15000),
});
const loginBody = await login.json().catch(() => null);
if (login.status !== 200 || loginBody?.user?.email !== email) {
  throw new Error('Owner login failed through disposable Caddy');
}
const setCookies = typeof login.headers.getSetCookie === 'function'
  ? login.headers.getSetCookie()
  : [login.headers.get('set-cookie')].filter(Boolean);
const cookies = setCookies.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
if (!/(?:^|; )charitypilot_access=/.test(cookies) || !/(?:^|; )charitypilot_refresh=/.test(cookies)) {
  throw new Error('Owner login did not issue both authenticated cookies');
}
const me = await fetch(base + '/api/v1/auth/me', {
  headers: { cookie: cookies, origin },
  signal: AbortSignal.timeout(15000),
});
const meBody = await me.json().catch(() => null);
if (me.status !== 200 || meBody?.email !== email) {
  throw new Error('Authenticated Owner session failed through disposable Caddy');
}
const documentId = process.env.CHARITYPILOT_PROBE_DOCUMENT_ID;
if (documentId) {
  const download = await fetch(base + '/api/v1/documents/' + encodeURIComponent(documentId) + '/download', {
    headers: { cookie: cookies, origin },
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await download.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (download.status !== 200 || digest !== process.env.CHARITYPILOT_PROBE_DOCUMENT_SHA256) {
    throw new Error('Authenticated sampled document download did not match the recovery-set bytes');
  }
}
console.log(JSON.stringify({
  format: 'charitypilot-personal-full-application-proof/v1',
  ownerLogin: true,
  webThroughCaddy: true,
  sampledDocument: Boolean(documentId),
}));
`;
const DISPOSABLE_PROOF_IDENTITY_SCRIPT = `
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
if (!/^charitypilot-personal-rehearsal-[a-f0-9]{12}$/.test(process.env.CHARITYPILOT_REHEARSAL_GUARD || '')) {
  throw new Error('synthetic identity creation is restricted to an exact disposable rehearsal');
}
const prisma = new PrismaClient();
try {
  const document = await prisma.document.findFirst({
    where: { organisation: { is: { lifecycleStatus: 'ACTIVE' } } },
    orderBy: { id: 'asc' },
    select: { organisationId: true },
  });
  const organisation = document
    ? await prisma.organisation.findUnique({ where: { id: document.organisationId }, select: { id: true } })
    : await prisma.organisation.findFirst({ where: { lifecycleStatus: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true } });
  if (!organisation) throw new Error('recovered database has no organisation for disposable login proof');
  const existing = await prisma.user.findUnique({ where: { email: process.env.CHARITYPILOT_PROBE_OWNER_EMAIL }, select: { id: true } });
  if (existing) throw new Error('random disposable proof identity already exists');
  await prisma.user.create({
    data: {
      email: process.env.CHARITYPILOT_PROBE_OWNER_EMAIL,
      name: 'Disposable restore proof',
      passwordHash: await bcrypt.hash(process.env.CHARITYPILOT_PROBE_OWNER_PASSWORD, 12),
      role: 'OWNER',
      organisationId: organisation.id,
      emailVerified: true,
      lifecycleStatus: 'ACTIVE',
    },
  });
  console.log(JSON.stringify({ format: 'charitypilot-personal-disposable-identity/v1', organisationId: organisation.id }));
} finally {
  await prisma.$disconnect();
}
`;
const REVOKE_RESTORED_SESSIONS_SCRIPT = `
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const now = new Date();
  const result = await prisma.authSession.updateMany({
    where: { revokedAt: null },
    data: { revokedAt: now, revocationReason: 'ADMIN_ALL_SESSIONS_REVOKED' },
  });
  console.log(JSON.stringify({ format: 'charitypilot-personal-session-revocation/v1', sessionsRevoked: result.count }));
} finally {
  await prisma.$disconnect();
}
`;

function usage() {
  return `CharityPilot personal-server operator

Usage:
  node scripts/personal-server.mjs init --owner-email=<email> --owner-name=<name> --organisation-name=<name> [--origin=<origin>] [--port=<port>] [--dry-run]
  node scripts/personal-server.mjs resume-init [--dry-run]
  node scripts/personal-server.mjs start [--dry-run]
  node scripts/personal-server.mjs status [--dry-run]
  node scripts/personal-server.mjs stop [--dry-run]
  node scripts/personal-server.mjs backup [--output-dir=<path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs update --update-receipt=<protected-path> [--resume-pending] [--output-dir=<path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs rollback --confirm=<typed-confirmation> [--output-dir=<path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs bootstrap-restore-plan --recovery-set=<path> --source-origin=<original-origin> --origin=<target-origin> --port=<port> --encryption-key-file=<absolute-path>
  node scripts/personal-server.mjs bootstrap-restore --recovery-set=<path> --source-origin=<original-origin> --origin=<target-origin> --port=<port> --confirm=<typed-confirmation> [--owner-email=<email> --owner-password-file=<absolute-path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs rehearse-restore --recovery-set=<path> [--source-origin=<original-origin>] [--owner-password-file=<absolute-path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs restore --recovery-set=<path> --confirm=<typed-confirmation> [--source-origin=<original-origin>] [--preservation-output-dir=<path>] [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs decommission --recovery-set=<path> --confirm=<typed-confirmation> [--encryption-key-file=<absolute-path>] [--dry-run]
  node scripts/personal-server.mjs reset-link --email=<canonical-lowercase-email> [--dry-run]
  node scripts/personal-server.mjs reset-password --email=<canonical-lowercase-email> [--dry-run]
  node scripts/personal-server.mjs help

Safety:
  - init never overwrites .env.personal-server and never stores the owner password;
  - start never builds, migrates, or seeds;
  - stop preserves both named data volumes;
  - update requires a verified database-and-document backup before migration;
  - bootstrap-restore is only for an installer-prepared, blank replacement host and never runs the Owner initializer;
  - rehearse-restore uses isolated disposable database, document, network, API, web, and Caddy resources;
  - restore verifies and rehearses the selected set, creates a preservation backup, and requires exact typed confirmation;
  - decommission requires a fresh verified recovery set and removes only the exact Compose containers, network, and two data volumes;
  - reset-link is preferred; reset-password is an emergency fallback.
`;
}

function optionName(arg) {
  return arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
}

function parseOptions(argv, allowedValueOptions, allowedBooleanOptions = new Set()) {
  const options = { dryRun: false };
  let dryRunSeen = false;
  let helpSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      if (dryRunSeen) throw new Error('--dry-run may be provided only once');
      dryRunSeen = true;
      options.dryRun = true;
      continue;
    }
    if (arg === '--help') {
      if (helpSeen) throw new Error('--help may be provided only once');
      helpSeen = true;
      options.help = true;
      continue;
    }
    if (allowedBooleanOptions.has(arg)) {
      const optionKey = arg === '--resume-pending' ? 'resumePending' : arg.slice(2);
      if (options[optionKey] !== undefined) {
        throw new Error(`${arg} may be provided only once`);
      }
      options[optionKey] = true;
      continue;
    }

    const name = optionName(arg);
    if (allowedBooleanOptions.has(name)) throw new Error(`${name} does not accept a value`);
    if (!allowedValueOptions.has(name)) throw new Error(`Unknown option: ${arg}`);
    let value;
    if (arg.includes('=')) {
      value = arg.slice(arg.indexOf('=') + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (options[name.slice(2)] !== undefined) throw new Error(`${name} may be provided only once`);
    options[name.slice(2)] = value;
  }
  return options;
}

export function parsePersonalServerArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', options: {} };
  }
  const command = argv[0];
  if (command === 'help') {
    if (argv.length !== 1) throw new Error('help does not accept options');
    return { command, options: {} };
  }

  const allowedByCommand = {
    init: new Set(['--owner-email', '--owner-name', '--organisation-name', '--origin', '--port']),
    'resume-init': new Set(),
    start: new Set(),
    status: new Set(),
    stop: new Set(),
    backup: new Set(['--output-dir', '--encryption-key-file']),
    update: new Set(['--update-receipt', '--output-dir', '--encryption-key-file']),
    rollback: new Set(['--confirm', '--output-dir', '--encryption-key-file']),
    'bootstrap-restore-plan': new Set(['--recovery-set', '--source-origin', '--origin', '--port', '--encryption-key-file']),
    'bootstrap-restore': new Set(['--recovery-set', '--source-origin', '--origin', '--port', '--confirm', '--owner-email', '--owner-password-file', '--encryption-key-file']),
    'rehearse-restore': new Set(['--recovery-set', '--source-origin', '--owner-password-file', '--encryption-key-file']),
    restore: new Set(['--recovery-set', '--confirm', '--source-origin', '--preservation-output-dir', '--encryption-key-file']),
    decommission: new Set(['--recovery-set', '--confirm', '--encryption-key-file']),
    'reset-link': new Set(['--email']),
    'reset-password': new Set(['--email']),
  };
  const allowed = allowedByCommand[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  const booleanOptions = command === 'update' ? new Set(['--resume-pending']) : new Set();
  const options = parseOptions(argv.slice(1), allowed, booleanOptions);
  if (options.help) return { command: 'help', options: {} };
  return { command, options };
}

function canonicalEmail(value, name) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value !== value.toLowerCase() ||
    value.length > 254 ||
    value.includes('$') ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
  ) {
    throw new Error(`${name} must be a canonical lowercase email address`);
  }
  return value;
}

function canonicalText(value, name, maximumLength) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > maximumLength ||
    value.includes('$') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name} must be non-empty canonical text of at most ${maximumLength} characters`);
  }
  return value;
}

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin !== value) throw new Error();
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1';
    if ((url.protocol === 'http:' && loopback) || (url.protocol === 'https:' && !url.port && host.endsWith('.ts.net'))) {
      return value;
    }
  } catch {
    // The common error below is deliberately value-free.
  }
  throw new Error('origin must be exact HTTPS with a DNS hostname or HTTP with an exact loopback host');
}

function canonicalPort(value) {
  if (!/^[1-9]\d{0,4}$/u.test(String(value))) throw new Error('port must be an integer from 1 to 65535');
  const port = Number(value);
  if (port > 65535) throw new Error('port must be an integer from 1 to 65535');
  return String(port);
}

function dotenvValue(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

export function renderPersonalServerEnv(config) {
  const entries = [
    ['CHARITYPILOT_PERSONAL_SERVER_PORT', config.port],
    ['CHARITYPILOT_PERSONAL_SERVER_ORIGIN', config.origin],
    ['CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG', config.imageTag],
    ['POSTGRES_DB', config.postgresDatabase],
    ['POSTGRES_USER', config.postgresUser],
    ['POSTGRES_PASSWORD', config.postgresPassword],
    ['JWT_SECRET', config.jwtSecret],
    ['AUTH_RECOVERY_SECRET', config.authRecoverySecret],
    ['JWT_EXPIRY', '15m'],
    ['REFRESH_TOKEN_TTL_DAYS', '7'],
    ['READINESS_API_KEY', config.readinessApiKey],
    ['PERSONAL_SERVER_OWNER_EMAIL', config.ownerEmail],
    ['PERSONAL_SERVER_OWNER_NAME', config.ownerName],
    ['PERSONAL_SERVER_ORGANISATION_NAME', config.organisationName],
  ];
  return [
    '# Generated once by scripts/personal-server.mjs. Do not commit or share this file.',
    '# The generated Owner password is deliberately never stored here.',
    ...entries.map(([name, value]) => `${name}=${dotenvValue(value)}`),
    '',
  ].join('\r\n');
}

function parseDotenvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error();
      return parsed;
    } catch {
      throw new Error('Personal-server environment contains an invalid quoted value');
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function parsePersonalServerEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error('Personal-server environment contains an invalid line');
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate personal-server environment key: ${match[1]}`);
    values[match[1]] = parseDotenvValue(match[2]);
  }
  return values;
}

function validateStoredEnvironment(values) {
  const port = canonicalPort(values.CHARITYPILOT_PERSONAL_SERVER_PORT);
  const origin = canonicalOrigin(values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN);
  const originUrl = new URL(origin);
  if (originUrl.protocol === 'http:' && String(originUrl.port || '80') !== port) {
    throw new Error('Loopback HTTP origin port must match CHARITYPILOT_PERSONAL_SERVER_PORT');
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG ?? '')) {
    throw new Error('CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG is invalid');
  }
  for (const name of ['POSTGRES_DB', 'POSTGRES_USER']) {
    if (!/^[a-z][a-z0-9_]{2,62}$/u.test(values[name] ?? '')) throw new Error(`${name} is invalid`);
  }
  if (!/^[A-Fa-f0-9]{64}$/u.test(values.POSTGRES_PASSWORD ?? '')) {
    throw new Error('POSTGRES_PASSWORD must be a 64-character hexadecimal secret');
  }
  for (const name of ['JWT_SECRET', 'READINESS_API_KEY', 'AUTH_RECOVERY_SECRET']) {
    if (!values[name] || values[name].length < 32 || /CHANGE_ME|REPLACE_ME/iu.test(values[name])) {
      throw new Error(`${name} must be a configured secret of at least 32 characters`);
    }
  }
  if (new Set([
    values.JWT_SECRET,
    values.READINESS_API_KEY,
    values.AUTH_RECOVERY_SECRET,
  ]).size !== 3) {
    throw new Error('JWT_SECRET, READINESS_API_KEY, and AUTH_RECOVERY_SECRET must be distinct');
  }
  const recoverySecret = values.AUTH_RECOVERY_SECRET;
  let decodedRecoverySecret;
  if (/^[0-9a-f]+$/iu.test(recoverySecret) && recoverySecret.length % 2 === 0) {
    decodedRecoverySecret = Buffer.from(recoverySecret, 'hex');
  } else if (/^[A-Za-z0-9_-]+$/u.test(recoverySecret)) {
    decodedRecoverySecret = Buffer.from(recoverySecret, 'base64url');
  } else {
    throw new Error('AUTH_RECOVERY_SECRET must be canonical hex or base64url');
  }
  if (
    decodedRecoverySecret.length < 32 ||
    decodedRecoverySecret.length > 64 ||
    (
      recoverySecret.toLowerCase() !== decodedRecoverySecret.toString('hex') &&
      recoverySecret !== decodedRecoverySecret.toString('base64url')
    )
  ) {
    throw new Error('AUTH_RECOVERY_SECRET must canonically encode 32 to 64 high-entropy bytes');
  }
  canonicalEmail(values.PERSONAL_SERVER_OWNER_EMAIL, 'PERSONAL_SERVER_OWNER_EMAIL');
  canonicalText(values.PERSONAL_SERVER_OWNER_NAME, 'PERSONAL_SERVER_OWNER_NAME', 200);
  canonicalText(values.PERSONAL_SERVER_ORGANISATION_NAME, 'PERSONAL_SERVER_ORGANISATION_NAME', 300);
  if (values.PERSONAL_SERVER_OWNER_PASSWORD) {
    throw new Error('PERSONAL_SERVER_OWNER_PASSWORD must never be persisted in .env.personal-server');
  }
  return values;
}

function randomHex(bytes, randomBytesImpl) {
  return randomBytesImpl(bytes).toString('hex');
}

function randomBase64Url(bytes, randomBytesImpl) {
  return randomBytesImpl(bytes).toString('base64url');
}

export function generateStrongOneTimePassword(randomBytesImpl = randomBytes) {
  return `Cp!7${randomBase64Url(18, randomBytesImpl)}`;
}

function writeExclusiveFile(path, content, mode = 0o600) {
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Windows chmod does not model NTFS ACLs; exclusive creation remains mandatory.
  }
}

function loadEnvironmentFile(envPath) {
  const status = lstatSync(envPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > MAX_ENV_BYTES) {
    throw new Error('.env.personal-server must be a non-empty regular file smaller than 64 KiB');
  }
  return validateStoredEnvironment(parsePersonalServerEnv(readFileSync(envPath, 'utf8')));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+<>-]+$/u.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function formatPersonalServerCommand(command) {
  return command.map(shellQuote).join(' ');
}

function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, 'postgresql://[redacted]');
}

function environmentPathFromLocationPointer(localApplicationData) {
  const pointerPath = join(localApplicationData, 'CharityPilot', LOCATION_POINTER_FILE_NAME);
  if (!existsSync(pointerPath)) return null;
  const status = lstatSync(pointerPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 16 * 1024) {
    throw new Error('CharityPilot installation-location pointer must be a small regular non-symlink file');
  }
  let value;
  try {
    value = JSON.parse(readFileSync(pointerPath, 'utf8'));
  } catch {
    throw new Error('CharityPilot installation-location pointer is not valid JSON');
  }
  if (
    value?.format !== 'charitypilot-personal-server-location/v1' ||
    typeof value?.stateRoot !== 'string' || !isAbsolute(value.stateRoot) ||
    typeof value?.environmentPath !== 'string' || !isAbsolute(value.environmentPath) ||
    resolve(value.environmentPath) !== resolve(value.stateRoot, ENV_FILE_NAME)
  ) {
    throw new Error('CharityPilot installation-location pointer has an invalid state or environment path');
  }
  return resolve(value.environmentPath);
}

export function environmentFilePath(context) {
  const configured = context.processEnv.CHARITYPILOT_PERSONAL_SERVER_ENV_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('CHARITYPILOT_PERSONAL_SERVER_ENV_FILE must be an explicit absolute path');
    }
    return resolve(configured);
  }
  const localApplicationData = context.processEnv.LOCALAPPDATA?.trim();
  if (localApplicationData && isAbsolute(localApplicationData)) {
    const pointerEnvironment = environmentPathFromLocationPointer(localApplicationData);
    if (pointerEnvironment) return pointerEnvironment;
    const installedPath = join(localApplicationData, 'CharityPilot', 'personal-server', ENV_FILE_NAME);
    if (existsSync(installedPath)) return installedPath;
  }
  return join(context.repoRoot, ENV_FILE_NAME);
}

function readInstallationState(context) {
  const statePath = join(dirname(environmentFilePath(context)), 'install-state.json');
  if (!existsSync(statePath)) return null;
  const status = lstatSync(statePath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 64 * 1024) {
    throw new Error('Personal-server installation state must be a small regular non-symlink file');
  }
  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
  catch { throw new Error('Personal-server installation state is not valid JSON'); }
  if (
    state?.format !== 'charitypilot-personal-server-install-state/v1' ||
    !INSTALLATION_PHASES.has(state?.phase)
  ) {
    throw new Error('Personal-server installation state has an invalid identity or phase');
  }
  return { path: statePath, value: state };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOperationLock(lockPath) {
  const status = lstatSync(lockPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 16 * 1024) {
    throw new Error('Personal-server operation lock is not a small regular non-symlink file');
  }
  let value;
  try { value = JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch { throw new Error('Personal-server operation lock is unreadable; do not remove it without investigating'); }
  const startedAtMs = typeof value?.startedAt === 'string' ? Date.parse(value.startedAt) : Number.NaN;
  if (
    value?.format !== 'charitypilot-personal-server-operation-lock/v1' ||
    !/^[a-f0-9]{24}$/u.test(value?.operationId ?? '') ||
    !Number.isSafeInteger(value?.pid) || value.pid <= 0 ||
    typeof value?.hostname !== 'string' || !value.hostname ||
    typeof value?.command !== 'string' || !value.command ||
    !Number.isFinite(startedAtMs)
  ) {
    throw new Error('Personal-server operation lock has invalid metadata; do not remove it without investigating');
  }
  return { value, startedAtMs };
}

function acquireOperationLock(command, context) {
  const stateDirectory = dirname(environmentFilePath(context));
  const lockPath = join(stateDirectory, 'personal-server-operation.lock');
  if (!existsSync(stateDirectory)) {
    if (context.dryRun) {
      context.writeOutput(`DRY RUN: acquire exclusive personal-server operation lock for ${command} after protected state creation.\n`);
      return null;
    }
    throw new Error('Personal-server state directory is missing');
  }
  if (existsSync(lockPath)) {
    const existing = readOperationLock(lockPath);
    const age = context.now().getTime() - existing.startedAtMs;
    const sameHost = existing.value.hostname === hostname();
    if (!sameHost || processIsAlive(existing.value.pid) || !Number.isFinite(age) || age < STALE_OPERATION_LOCK_AGE_MS) {
      throw new Error(`Personal-server operation ${existing.value.command} is already locked by PID ${existing.value.pid}`);
    }
    if (context.dryRun) {
      context.writeOutput(`DRY RUN: stale operation lock for ${existing.value.command} would be preserved as evidence and replaced.\n`);
    } else {
      const stalePath = join(stateDirectory, `operation-lock-stale-${existing.value.operationId}.json`);
      renameSync(lockPath, stalePath);
    }
  }
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: acquire exclusive personal-server operation lock for ${command}.\n`);
    return null;
  }
  const operationId = context.randomBytesImpl(12).toString('hex');
  const record = {
    format: 'charitypilot-personal-server-operation-lock/v1',
    operationId,
    pid: process.pid,
    hostname: hostname(),
    command,
    startedAt: context.now().toISOString(),
  };
  try {
    writeExclusiveFile(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    throw new Error(`Could not acquire the exclusive personal-server operation lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { lockPath, operationId };
}

function releaseOperationLock(lock) {
  if (!lock) return;
  const current = readOperationLock(lock.lockPath);
  if (current.value.operationId !== lock.operationId || current.value.pid !== process.pid) {
    throw new Error('Personal-server operation lock ownership changed unexpectedly');
  }
  rmSync(lock.lockPath);
}

function markInstallationDecommissioned(context, finalRecoverySet) {
  const record = readInstallationState(context);
  if (!record) throw new Error('Supported decommission requires the protected installer state record');
  const value = {
    ...record.value,
    phase: 'decommissioned',
    decommissionedAt: context.now().toISOString(),
    finalRecoverySet,
    decommissionOperation: null,
    updatedAt: context.now().toISOString(),
  };
  const temporaryPath = `${record.path}.${process.pid}.${context.randomBytesImpl(6).toString('hex')}.tmp`;
  writeExclusiveFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, record.path);
}

function writeInstallationStateExact(context, value) {
  const record = readInstallationState(context);
  if (!record) throw new Error('Supported installation recovery requires the protected installer state record');
  if (
    value?.format !== 'charitypilot-personal-server-install-state/v1' ||
    !INSTALLATION_PHASES.has(value?.phase)
  ) {
    throw new Error('Refusing to write an invalid personal-server installation state');
  }
  const temporaryPath = `${record.path}.${process.pid}.${context.randomBytesImpl(6).toString('hex')}.tmp`;
  writeExclusiveFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, record.path);
  return value;
}

function updateInstallationState(context, patch) {
  const record = readInstallationState(context);
  if (!record) throw new Error('Supported installation recovery requires the protected installer state record');
  const value = {
    ...record.value,
    ...patch,
    updatedAt: context.now().toISOString(),
  };
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: transition protected installation state ${record.value.phase} -> ${value.phase}.\n`);
    return value;
  }
  return writeInstallationStateExact(context, value);
}

function composePrefix(context) {
  return ['docker', 'compose', '--env-file', environmentFilePath(context), '-f', COMPOSE_FILE_NAME];
}

function runCommand(command, context, { capture = false, env = context.processEnv, secrets = [] } = {}) {
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: ${formatPersonalServerCommand(command)}\n`);
    return '';
  }
  const result = context.spawnSyncImpl(command[0], command.slice(1), {
    cwd: context.repoRoot,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    timeout: context.commandTimeoutMs,
  });
  if (result.status !== 0) {
    const detail = capture ? redactText(result.stderr, secrets).trim() : '';
    throw new Error(`${formatPersonalServerCommand(command)} failed${detail ? `: ${detail}` : ''}`);
  }
  return capture ? String(result.stdout ?? '') : '';
}

function runCommandToFile(command, outputPath, context) {
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: ${formatPersonalServerCommand(command)} > ${shellQuote(outputPath)}\n`);
    return;
  }
  const tempPath = `${outputPath}.partial`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    const result = context.spawnSyncImpl(command[0], command.slice(1), {
      cwd: context.repoRoot,
      env: context.processEnv,
      encoding: 'utf8',
      stdio: ['ignore', fd, 'pipe'],
      timeout: context.commandTimeoutMs,
      maxBuffer: 1024 * 1024,
    });
    fsyncSync(fd);
    if (result.status !== 0) throw new Error('Document archive command failed');
  } catch (error) {
    closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }
  closeSync(fd);
  if (statSync(tempPath).size <= 0) {
    rmSync(tempPath, { force: true });
    throw new Error('Document archive is empty');
  }
  renameSync(tempPath, outputPath);
}

function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function environmentForNewInstall(options, context) {
  const ownerEmail = canonicalEmail(options['owner-email'], '--owner-email');
  const ownerName = canonicalText(options['owner-name'], '--owner-name', 200);
  const organisationName = canonicalText(options['organisation-name'], '--organisation-name', 300);
  const port = canonicalPort(options.port ?? '8080');
  const origin = canonicalOrigin(options.origin ?? `http://localhost:${port}`);
  if (new URL(origin).protocol === 'http:' && String(new URL(origin).port || '80') !== port) {
    throw new Error('Loopback HTTP origin port must match --port');
  }
  return {
    port,
    origin,
    imageTag: initialImageTag(context.repoRoot),
    postgresDatabase: 'charitypilot_personal_server',
    postgresUser: 'charitypilot_personal_server',
    postgresPassword: randomHex(32, context.randomBytesImpl),
    jwtSecret: `jwt_${randomBase64Url(48, context.randomBytesImpl)}`,
    authRecoverySecret: randomBase64Url(48, context.randomBytesImpl),
    readinessApiKey: `readiness_${randomBase64Url(48, context.randomBytesImpl)}`,
    ownerEmail,
    ownerName,
    organisationName,
  };
}

function environmentForReplacementRestore(options, imageTag, context) {
  const ownerEmail = options['owner-email'] === undefined
    ? 'recovered-owner@invalid.example'
    : canonicalEmail(options['owner-email'], '--owner-email');
  if (options['owner-password-file'] !== undefined && options['owner-email'] === undefined) {
    throw new Error('--owner-email is required when --owner-password-file is supplied');
  }
  const port = canonicalPort(options.port ?? '8080');
  const origin = canonicalOrigin(options.origin ?? `http://localhost:${port}`);
  if (new URL(origin).protocol === 'http:' && String(new URL(origin).port || '80') !== port) {
    throw new Error('Loopback HTTP origin port must match --port');
  }
  return {
    port,
    origin,
    imageTag,
    postgresDatabase: 'charitypilot_personal_server',
    postgresUser: 'charitypilot_personal_server',
    postgresPassword: randomHex(32, context.randomBytesImpl),
    jwtSecret: `jwt_${randomBase64Url(48, context.randomBytesImpl)}`,
    authRecoverySecret: randomBase64Url(48, context.randomBytesImpl),
    readinessApiKey: `readiness_${randomBase64Url(48, context.randomBytesImpl)}`,
    ownerEmail,
    ownerName: 'Recovered Owner',
    organisationName: 'Recovered Charity',
  };
}

function initialImageTag(repoRoot) {
  const identityPath = join(repoRoot, 'personal-server-release.json');
  if (!existsSync(identityPath)) return 'local';
  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (
      identity?.format === 'charitypilot-personal-server-bundle/v1' &&
      identity?.profile === 'personal-server' &&
      /^personal-v\d+\.\d+\.\d+$/u.test(identity?.tag ?? '')
    ) return identity.tag;
  } catch {
    // The installer performs the authoritative release identity check.
  }
  throw new Error('Release bundle identity cannot determine the initial image tag');
}

function personalImageNames(tag) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(tag ?? '')) throw new Error('Personal-server image tag is invalid');
  return {
    api: `charitypilot-personal-server-api:${tag}`,
    migrations: `charitypilot-personal-server-migrations:${tag}`,
    web: `charitypilot-personal-server-web:${tag}`,
  };
}

function ensureInitMetadataMatches(options, values) {
  const comparisons = [
    ['owner-email', 'PERSONAL_SERVER_OWNER_EMAIL'],
    ['owner-name', 'PERSONAL_SERVER_OWNER_NAME'],
    ['organisation-name', 'PERSONAL_SERVER_ORGANISATION_NAME'],
    ['origin', 'CHARITYPILOT_PERSONAL_SERVER_ORIGIN'],
    ['port', 'CHARITYPILOT_PERSONAL_SERVER_PORT'],
  ];
  for (const [option, envName] of comparisons) {
    if (options[option] !== undefined && String(options[option]) !== values[envName]) {
      throw new Error(`Refusing to overwrite existing ${envName}`);
    }
  }
}

function validateCompose(context) {
  runCommand([...composePrefix(context), 'config', '--quiet'], context);
}

function startRuntime(context) {
  runCommand([
    ...composePrefix(context),
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    String(DEFAULT_WAIT_SECONDS),
  ], context);
}

function verifyRuntimeMigrationHistory(context) {
  // Routine startup must remain read-only with respect to application data. Bring
  // up only PostgreSQL, then ask the already-built migration image to compare its
  // exact migration catalog with the live history before any application runtime
  // is allowed to start. `migrate status` never deploys or resolves migrations.
  runCommand([
    ...composePrefix(context),
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    String(DEFAULT_WAIT_SECONDS),
    'db',
  ], context);
  runCommand([
    ...composePrefix(context),
    '--profile',
    'maintenance',
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'migrate',
    'migrate',
    'status',
    '--schema',
    'prisma/schema.prisma',
  ], context);
}

function verifyBootstrapLogin(values, ownerPassword, context) {
  const verificationScript = `
const port = process.env.CHARITYPILOT_PERSONAL_SERVER_PORT;
const origin = process.env.CHARITYPILOT_PERSONAL_SERVER_ORIGIN;
const email = process.env.PERSONAL_SERVER_OWNER_EMAIL;
const password = process.env.PERSONAL_SERVER_OWNER_PASSWORD;
const base = 'http://127.0.0.1:' + port;
const deadline = Date.now() + 30000;
let frontDoorReady = false;
while (Date.now() < deadline) {
  try {
    const remaining = Math.max(1, deadline - Date.now());
    const readiness = await fetch(base + '/login', {
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(3000, remaining)),
    });
    await readiness.arrayBuffer();
    if (readiness.status === 200) {
      frontDoorReady = true;
      break;
    }
    if (![502, 503, 504].includes(readiness.status)) {
      console.error('Personal-server host front door returned unexpected HTTP ' + readiness.status);
      process.exit(1);
    }
  } catch {
    // Docker Desktop can report the container healthy before its Windows
    // loopback forwarding socket is accepting connections. Retry only this
    // unauthenticated readiness request; the credential POST remains one-shot.
  }
  if (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!frontDoorReady) {
  console.error('Personal-server host front door did not become reachable within 30 seconds');
  process.exit(1);
}
const response = await fetch(base + '/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(15000),
});
await response.arrayBuffer();
if (response.status !== 200) {
  console.error('Personal-server bootstrap login verification failed with HTTP ' + response.status);
  process.exit(1);
}
`;
  runCommand([process.execPath, '--input-type=module', '-e', verificationScript], context, {
    env: {
      ...context.processEnv,
      CHARITYPILOT_PERSONAL_SERVER_PORT: values.CHARITYPILOT_PERSONAL_SERVER_PORT,
      CHARITYPILOT_PERSONAL_SERVER_ORIGIN: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      PERSONAL_SERVER_OWNER_EMAIL: values.PERSONAL_SERVER_OWNER_EMAIL,
      PERSONAL_SERVER_OWNER_PASSWORD: ownerPassword,
    },
    secrets: [ownerPassword],
  });
}

function buildImagesSequentially(context) {
  for (const service of BUILD_SERVICES) {
    runCommand([...composePrefix(context), '--profile', 'personal-init', 'build', service], context);
  }
}

function runPersonalInitializer(values, ownerPassword, context) {
  const childEnv = { ...context.processEnv, PERSONAL_SERVER_OWNER_PASSWORD: ownerPassword };
  runCommand([
    ...composePrefix(context),
    '--profile',
    'personal-init',
    'run',
    '--rm',
    '--no-deps',
    '-e',
    'PERSONAL_SERVER_OWNER_PASSWORD',
    'personal-init',
  ], context, { env: childEnv, secrets: [ownerPassword] });
}

function preparePinnedRuntimeImages(context) {
  runCommand([
    ...composePrefix(context),
    'pull',
    'db',
    'document-storage-init',
    'caddy',
  ], context);
  runCommand([
    ...composePrefix(context),
    'run',
    '--rm',
    '--no-deps',
    'caddy',
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ], context);
}

function initialize(options, context) {
  const envPath = environmentFilePath(context);
  let values;
  if (existsSync(envPath)) {
    values = loadEnvironmentFile(envPath);
    ensureInitMetadataMatches(options, values);
  } else {
    const config = environmentForNewInstall(options, context);
    const content = renderPersonalServerEnv(config);
    values = validateStoredEnvironment(parsePersonalServerEnv(content));
    if (!context.dryRun) writeExclusiveFile(envPath, content);
  }

  const ownerPassword = generateStrongOneTimePassword(context.randomBytesImpl);
  validateCompose(context);
  preparePinnedRuntimeImages(context);
  buildImagesSequentially(context);
  runCommand([...composePrefix(context), '--profile', 'maintenance', 'run', '--rm', 'migrate'], context);
  let ownerCreated = false;
  try {
    runPersonalInitializer(values, ownerPassword, context);
    ownerCreated = !context.dryRun;
    startRuntime(context);
    verifyBootstrapLogin(values, ownerPassword, context);
  } catch (error) {
    if (ownerCreated) {
      context.writeOutput('The Owner workspace was created, but the runtime health check failed. Preserve the data volumes and use this credential after repairing startup.\n');
      context.writeOutput(`Owner email: ${values.PERSONAL_SERVER_OWNER_EMAIL}\n`);
      context.writeOutput(`Generated Owner password (shown once): ${ownerPassword}\n`);
    }
    throw error;
  }

  if (!context.dryRun) {
    context.writeOutput('Personal server initialized and healthy.\n');
    context.writeOutput(`Owner email: ${values.PERSONAL_SERVER_OWNER_EMAIL}\n`);
    context.writeOutput(`Generated Owner password (shown once): ${ownerPassword}\n`);
  } else {
    context.writeOutput('DRY RUN: no environment file, data, or password was created.\n');
  }
}

function sameSourcePath(left, right) {
  if (!isAbsolute(left ?? '') || !isAbsolute(right ?? '')) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function canonicalGitRemoteIdentity(value) {
  try {
    const url = new URL(String(value).trim());
    return (
      url.protocol === 'https:' &&
      !url.username && !url.password &&
      url.hostname.toLowerCase() === 'github.com' &&
      url.pathname.replace(/\.git$/u, '').replace(/\/$/u, '').toLowerCase() === '/jasperfordesq-ai/charity-governance'
    );
  } catch {
    return false;
  }
}

export function validateCleanGitReleaseAdoption({
  installationSource,
  activeImageTag,
  currentImageTag,
  workingTree,
  revision,
  branch,
  remote,
  originMasterRevision,
  targetCommitSha,
  targetCommitPresent,
  targetDescendsFromCurrent,
}) {
  const recordedRevision = installationSource?.revision;
  if (activeImageTag !== currentImageTag) {
    throw new Error('Protected installation state active image tag does not match the protected environment');
  }
  if (
    !['git', 'clean-git'].includes(installationSource?.kind) ||
    installationSource?.canonicalRemote !== true ||
    installationSource?.branch !== 'master' ||
    !/^[a-f0-9]{40}$/u.test(recordedRevision ?? '') ||
    currentImageTag !== 'local'
  ) {
    throw new Error('First official release adoption requires the recorded canonical clean-Git installation identity');
  }
  if (
    workingTree !== '' || revision !== recordedRevision || branch !== installationSource.branch ||
    !canonicalGitRemoteIdentity(remote) || originMasterRevision !== recordedRevision
  ) {
    throw new Error('Installed clean-Git source is dirty, changed, or no longer the exact fetched canonical origin/master commit');
  }
  if (
    !/^[a-f0-9]{40}$/u.test(targetCommitSha ?? '') ||
    targetCommitPresent !== true || targetDescendsFromCurrent !== true
  ) {
    throw new Error('Target release commit is unavailable or does not descend from the recorded installed commit');
  }
  return true;
}

function assertCleanGitReleaseAdoption(installationState, currentImageTag, targetCommitSha, context) {
  const source = installationState.value.source;
  if (source?.releaseIdentity) return;
  const sourceContext = {
    ...context,
    repoRoot: resolve(installationState.value.sourceRoot),
  };
  const commands = {
    workingTree: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
    revision: ['git', 'rev-parse', 'HEAD'],
    branch: ['git', 'branch', '--show-current'],
    remote: ['git', 'remote', 'get-url', 'origin'],
    originMasterRevision: ['git', 'rev-parse', '--verify', 'refs/remotes/origin/master^{commit}'],
  };
  if (context.dryRun) {
    for (const command of Object.values(commands)) runCommand(command, sourceContext);
    runCommand(['git', 'cat-file', '-e', `${targetCommitSha}^{commit}`], sourceContext);
    runCommand(['git', 'merge-base', '--is-ancestor', source.revision, targetCommitSha], sourceContext);
    validateCleanGitReleaseAdoption({
      installationSource: source,
      activeImageTag: installationState.value.activeImageTag,
      currentImageTag,
      workingTree: '',
      revision: source.revision,
      branch: source.branch,
      remote: 'https://github.com/jasperfordesq-ai/charity-governance.git',
      originMasterRevision: source.revision,
      targetCommitSha,
      targetCommitPresent: true,
      targetDescendsFromCurrent: true,
    });
    return;
  }
  const evidence = Object.fromEntries(Object.entries(commands).map(([name, command]) => [
    name,
    runCommand(command, sourceContext, { capture: true }).trim(),
  ]));
  let targetCommitPresent = true;
  let targetDescendsFromCurrent = true;
  try {
    runCommand(['git', 'cat-file', '-e', `${targetCommitSha}^{commit}`], sourceContext, { capture: true });
  } catch {
    targetCommitPresent = false;
  }
  if (targetCommitPresent) {
    try {
      runCommand(
        ['git', 'merge-base', '--is-ancestor', source.revision, targetCommitSha],
        sourceContext,
        { capture: true },
      );
    } catch {
      targetDescendsFromCurrent = false;
    }
  }
  validateCleanGitReleaseAdoption({
    installationSource: source,
    activeImageTag: installationState.value.activeImageTag,
    currentImageTag,
    ...evidence,
    targetCommitSha,
    targetCommitPresent,
    targetDescendsFromCurrent,
  });
}

function assertFailedInstallSourceBinding(installationState, context) {
  const recorded = installationState.value;
  if (!sameSourcePath(recorded.sourceRoot, context.repoRoot)) {
    throw new Error('Failed-install source root does not match the protected installer state');
  }
  const release = recorded.source?.releaseIdentity;
  if (release) {
    const identityPath = join(context.repoRoot, 'personal-server-release.json');
    if (!existsSync(identityPath)) throw new Error('Failed-install release identity file is missing');
    const status = lstatSync(identityPath);
    if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 64 * 1024) {
      throw new Error('Failed-install release identity must be a small regular file');
    }
    const identity = parseAllowlistedJson(readFileSync(identityPath, 'utf8'), 'Failed-install release identity');
    if (
      identity.format !== 'charitypilot-personal-server-bundle/v1' ||
      identity.profile !== 'personal-server' ||
      identity.tag !== release.tag ||
      identity.commitSha !== release.commitSha
    ) {
      throw new Error('Failed-install release identity no longer matches the protected installer state');
    }
    return;
  }
  if (
    recorded.source?.canonicalRemote !== true ||
    !/^[a-f0-9]{40}$/u.test(recorded.source?.revision ?? '')
  ) {
    throw new Error('Failed-install Git source identity is incomplete');
  }
  const sourceContext = { ...context, repoRoot: resolve(recorded.sourceRoot) };
  const commands = [
    ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'branch', '--show-current'],
    ['git', 'remote', 'get-url', 'origin'],
  ];
  if (context.dryRun) {
    for (const command of commands) runCommand(command, sourceContext);
    return;
  }
  const [workingTree, revision, branch, remote] = commands.map((command) => (
    runCommand(command, sourceContext, { capture: true }).trim()
  ));
  if (
    workingTree ||
    revision !== recorded.source.revision ||
    branch !== 'master' ||
    !canonicalGitRemoteIdentity(remote)
  ) {
    throw new Error('Failed-install Git source is dirty or no longer matches canonical recorded master');
  }
}

function resumeInitialization(options, context) {
  const installationState = readInstallationState(context);
  if (!installationState || installationState.value.phase !== 'failed') {
    throw new Error('resume-init requires a protected installer state in failed phase');
  }
  assertFailedInstallSourceBinding(installationState, context);
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  preparePinnedRuntimeImages(context);
  buildImagesSequentially(context);
  runCommand([
    ...composePrefix(context),
    'up', '-d', '--no-build', '--wait', '--wait-timeout', String(DEFAULT_WAIT_SECONDS), 'db',
  ], context);
  runCommand([...composePrefix(context), '--profile', 'maintenance', 'run', '--rm', 'migrate'], context);
  const probeCommand = [
    ...composePrefix(context),
    'run', '--rm', '--no-deps', '-e', 'PERSONAL_SERVER_OWNER_EMAIL',
    'api', 'node', '--input-type=module', '-e', PERSONAL_INITIALIZATION_STATE_SCRIPT,
  ];
  if (context.dryRun) {
    runCommand(probeCommand, context, {
      env: { ...context.processEnv, PERSONAL_SERVER_OWNER_EMAIL: values.PERSONAL_SERVER_OWNER_EMAIL },
    });
    context.writeOutput('DRY RUN: resume would initialize an empty database or reset exactly one matching Owner, then prove login.\n');
    return;
  }
  const probe = parseAllowlistedJson(runCommand(probeCommand, context, {
    capture: true,
    env: { ...context.processEnv, PERSONAL_SERVER_OWNER_EMAIL: values.PERSONAL_SERVER_OWNER_EMAIL },
  }), 'Personal-server initialization-state probe');
  if (probe.format !== 'charitypilot-personal-server-initialization-state/v1') {
    throw new Error('Personal-server initialization-state probe returned an invalid identity');
  }
  let ownerPassword;
  if (probe.organisationCount === 0 && probe.userCount === 0 && probe.subscriptionCount === 0 && probe.owner === null) {
    ownerPassword = generateStrongOneTimePassword(context.randomBytesImpl);
    runPersonalInitializer(values, ownerPassword, context);
    startRuntime(context);
    verifyBootstrapLogin(values, ownerPassword, context);
    context.writeOutput('Failed installation resumed by creating the previously absent Owner workspace.\n');
  } else if (
    probe.organisationCount === 1 && probe.userCount === 1 && probe.subscriptionCount === 1 &&
    probe.owner?.email === values.PERSONAL_SERVER_OWNER_EMAIL && probe.owner?.role === 'OWNER' && probe.owner?.emailVerified === true
  ) {
    startRuntime(context);
    const reset = accountCommand('reset-password', { email: values.PERSONAL_SERVER_OWNER_EMAIL }, context, { deferSecretOutput: true });
    ownerPassword = reset.oneTimePassword;
    verifyBootstrapLogin(values, ownerPassword, context);
    context.writeOutput(`Password reset succeeded; revoked sessions: ${reset.sessionsRevoked}.\n`);
    context.writeOutput('Failed installation resumed using the one exact existing Owner workspace.\n');
  } else {
    throw new Error('Failed installation database is neither empty nor the one exact expected Owner workspace; preserving all data for supervised recovery');
  }
  updateInstallationState(context, {
    phase: 'initialized-backup-pending',
    resumedAt: context.now().toISOString(),
  });
  context.writeOutput(`Owner email: ${values.PERSONAL_SERVER_OWNER_EMAIL}\n`);
  context.writeOutput(`Generated replacement Owner password (shown once): ${ownerPassword}\n`);
}

function start(options, context) {
  loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  verifyRuntimeMigrationHistory(context);
  startRuntime(context);
  if (!context.dryRun) context.writeOutput('Personal server is healthy.\n');
}

function parseComposePsJson(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function latestBackup(context) {
  const root = resolveBackupRoot(undefined, context);
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .filter((entry) => existsSync(join(entry.path, 'manifest.json')))
    .sort((left, right) => right.name.localeCompare(left.name))[0] ?? null;
}

function status(options, context) {
  const installationState = readInstallationState(context);
  if (installationState?.value.phase === 'decommissioned') {
    context.writeOutput('installation phase: decommissioned\n');
    context.writeOutput(`final recovery set: ${installationState.value.finalRecoverySet?.recoverySetId ?? 'unknown'}\n`);
    context.writeOutput('Docker runtime and data volumes are intentionally absent. This state root is terminal; restore only through the documented replacement-host bootstrap into a different empty state root/profile.\n');
    return;
  }
  if (installationState?.value.phase === 'restoring') {
    context.writeOutput('installation phase: restoring\n');
    context.writeOutput(`preservation recovery set: ${installationState.value.restoreOperation?.preservationRecoverySet?.recoverySetId ?? 'unknown'}\n`);
    context.writeOutput('Ordinary lifecycle commands are blocked; writers must remain stopped pending supervised recovery.\n');
    return;
  }
  if (installationState?.value.phase === 'decommissioning') {
    context.writeOutput('installation phase: decommissioning\n');
    context.writeOutput(`final recovery set: ${installationState.value.decommissionOperation?.finalRecoverySet?.recoverySetId ?? 'unknown'}\n`);
    context.writeOutput('Ordinary lifecycle commands are blocked; rerun guarded decommission with the exact stored final recovery set.\n');
    return;
  }
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  if (context.dryRun) {
    runCommand([...composePrefix(context), 'ps', '--format', 'json'], context);
    context.writeOutput(`Configured origin: ${values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN}\n`);
    return;
  }
  const records = parseComposePsJson(runCommand([...composePrefix(context), 'ps', '--format', 'json'], context, { capture: true }));
  const byService = new Map(records.map((record) => [record.Service, record]));
  let healthy = true;
  for (const service of REQUIRED_RUNTIME_SERVICES) {
    const record = byService.get(service);
    const state = record?.State ?? 'missing';
    const health = record?.Health || 'unknown';
    context.writeOutput(`${service}: state=${state} health=${health}\n`);
    if (state !== 'running' || health !== 'healthy') healthy = false;
  }
  context.writeOutput(`origin: ${values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN}\n`);
  const latest = latestBackup(context);
  context.writeOutput(
    `latest completed recovery set in default root: ${latest?.name ?? 'none found'}\n`,
  );
  if (!healthy) throw new Error('Personal server is not healthy');
}

function stop(options, context) {
  loadEnvironmentFile(environmentFilePath(context));
  runCommand([...composePrefix(context), 'stop', ...WRITER_SERVICES, 'db'], context);
  if (!context.dryRun) context.writeOutput('Personal server stopped; data volumes were preserved.\n');
}

function resolveBackupRoot(option, context) {
  const approvedRepositoryRoot = join(context.repoRoot, '.charitypilot-backups', 'personal-server');
  const envDirectory = dirname(environmentFilePath(context));
  const relativeState = relative(context.repoRoot, envDirectory);
  const externalState = (
    relativeState === '..' ||
    relativeState.startsWith(`..${sep}`) ||
    isAbsolute(relativeState)
  );
  const configured = option ?? (externalState ? join(envDirectory, 'recovery') : approvedRepositoryRoot);
  const resolved = isAbsolute(configured) ? resolve(configured) : resolve(context.repoRoot, configured);
  const relativePath = relative(context.repoRoot, resolved);
  if (relativePath === '' || resolved === context.repoRoot || dirname(resolved) === resolved) {
    throw new Error('Backup output must not be a filesystem or repository root');
  }
  const insideRepository = (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
  const relativeToApprovedRoot = relative(approvedRepositoryRoot, resolved);
  const insideApprovedRepositoryRoot = (
    relativeToApprovedRoot === '' ||
    (
      relativeToApprovedRoot !== '..' &&
      !relativeToApprovedRoot.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToApprovedRoot)
    )
  );
  if (insideRepository && !insideApprovedRepositoryRoot) {
    throw new Error('Backups inside the repository must stay under .charitypilot-backups/personal-server');
  }
  return resolved;
}

function safeRecoveryId(context) {
  const timestamp = context.now().toISOString().replace(/[:.]/gu, '-');
  return `personal-server-${timestamp}-${randomHex(4, context.randomBytesImpl)}`;
}

function runningServices(context) {
  if (context.dryRun) {
    runCommand([...composePrefix(context), 'ps', '--status', 'running', '--services'], context);
    return [...REQUIRED_RUNTIME_SERVICES];
  }
  return runCommand([...composePrefix(context), 'ps', '--status', 'running', '--services'], context, { capture: true })
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function verifyContainerId(value) {
  const id = value.trim();
  if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Could not resolve exactly one personal-server database container');
  return id;
}

function documentArchiveCommand() {
  return [
    'docker',
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    '--memory',
    '256m',
    '--cpus',
    '0.50',
    '--pids-limit',
    '64',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--user',
    '1000:1000',
    '--mount',
    `type=volume,src=${DOCUMENT_VOLUME},dst=/documents,readonly`,
    DOCUMENT_ARCHIVE_IMAGE,
    'tar',
    '-cf',
    '-',
    '-C',
    '/documents',
    '.',
  ];
}

function personalDatabaseUrl(values, databaseName = values.POSTGRES_DB, host = 'db') {
  return `postgresql://${values.POSTGRES_USER}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@${host}:5432/${databaseName}`;
}

function parseAllowlistedJson(value, label) {
  try {
    const parsed = JSON.parse(value.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function databaseProofEnvironment(values, context, databaseName = values.POSTGRES_DB, host = 'db') {
  const databaseUrl = personalDatabaseUrl(values, databaseName, host);
  return {
    databaseUrl,
    env: { ...context.processEnv, DATABASE_URL: databaseUrl },
  };
}

function captureDatabaseIdentity(values, context, { databaseName, host, network = INTERNAL_NETWORK } = {}) {
  const proofEnvironment = databaseProofEnvironment(values, context, databaseName, host);
  if (context.dryRun) {
    runCommand([
      process.execPath,
      'scripts/postgres-backup.mjs',
      'source-identity',
      `--docker-network=${network}`,
      '--json',
    ], context, { env: proofEnvironment.env, secrets: [proofEnvironment.databaseUrl, values.POSTGRES_PASSWORD] });
    return '0'.repeat(64);
  }
  const output = runCommand([
    process.execPath,
    'scripts/postgres-backup.mjs',
    'source-identity',
    `--docker-network=${network}`,
    '--json',
  ], context, {
    capture: true,
    env: proofEnvironment.env,
    secrets: [proofEnvironment.databaseUrl, values.POSTGRES_PASSWORD],
  });
  const identity = parseAllowlistedJson(output, 'Database source-identity helper');
  if (
    identity.format !== 'charitypilot-postgres-source-identity/v2' ||
    identity.ok !== true ||
    identity.sourceReadOnlyVerified !== true ||
    !/^[a-f0-9]{64}$/u.test(identity.sourceDatabaseIdentitySha256 ?? '')
  ) {
    throw new Error('Database source-identity helper returned an unsafe result');
  }
  return identity.sourceDatabaseIdentitySha256;
}

function createExactDatabaseProof({
  values,
  recoverySetId,
  outputDirectory,
  context,
  databaseName,
  host,
  network = INTERNAL_NETWORK,
  dumpFile = 'database.dump',
  reportFile = 'database.restore-proof.json',
}) {
  const sourceIdentity = captureDatabaseIdentity(values, context, { databaseName, host, network });
  const proofEnvironment = databaseProofEnvironment(values, context, databaseName, host);
  runCommand([
    process.execPath,
    'scripts/postgres-backup.mjs',
    'prove-restore',
    `--docker-network=${network}`,
    `--recovery-set-id=${recoverySetId}`,
    `--expected-source-database-identity-sha256=${sourceIdentity}`,
    `--output-dir=${outputDirectory}`,
    `--output-file=${dumpFile}`,
    `--report-file=${reportFile}`,
  ], context, {
    env: proofEnvironment.env,
    secrets: [proofEnvironment.databaseUrl, values.POSTGRES_PASSWORD],
  });
  if (context.dryRun) return null;
  const proofPath = join(outputDirectory, reportFile);
  const proof = parseAllowlistedJson(readFileSync(proofPath, 'utf8'), 'Database restore proof');
  if (
    proof.format !== 'charitypilot-postgres-restore-proof/v2' ||
    proof.ok !== true ||
    proof.recoverySetId !== recoverySetId ||
    proof.sourceIdentityBindingMatched !== true ||
    proof.sourceReadOnlyVerified !== true ||
    proof.restoreTarget?.cleanupVerified !== true ||
    proof.restoreTarget?.productionOverwritten !== false ||
    proof.comparison?.mismatchCount !== 0 ||
    proof.comparison?.rowFingerprintsMatched !== true ||
    proof.comparison?.databaseFingerprintMatched !== true ||
    !/^[a-f0-9]{64}$/u.test(proof.source?.databaseFingerprintSha256 ?? '')
  ) {
    throw new Error('Database restore proof did not verify exact source/restored row content');
  }
  return proof;
}

function artifactEncryptionNonce(randomBytesImpl, recoverySetId, label) {
  return (size) => createHash('sha256')
    .update(randomBytesImpl(32))
    .update(recoverySetId)
    .update(label)
    .digest()
    .subarray(0, size);
}

function packageRecoveryArtifact({ path, label, recoverySetId, encryptionKey, context }) {
  const plaintextBytes = statSync(path).size;
  const plaintextSha256 = sha256File(path);
  if (!encryptionKey) {
    return {
      path,
      descriptor: {
        file: path.slice(path.lastIndexOf(sep) + 1),
        bytes: plaintextBytes,
        sha256: plaintextSha256,
        plaintextBytes,
        plaintextSha256,
        encryption: { format: personalServerRecoveryFormats.plaintextArtifact },
      },
    };
  }
  const encryptedPath = `${path}.enc`;
  const encrypted = encryptPersonalServerArtifact({
    inputPath: path,
    outputPath: encryptedPath,
    key: encryptionKey.key,
    aadContext: `${recoverySetId}:${label}`,
    randomBytesImpl: artifactEncryptionNonce(context.randomBytesImpl, recoverySetId, label),
  });
  if (encrypted.plaintextBytes !== plaintextBytes || encrypted.plaintextSha256 !== plaintextSha256) {
    rmSync(encryptedPath, { force: true });
    throw new Error(`${label} encryption did not preserve the plaintext identity`);
  }
  rmSync(path, { force: true });
  return {
    path: encryptedPath,
    descriptor: {
      file: encryptedPath.slice(encryptedPath.lastIndexOf(sep) + 1),
      bytes: encrypted.bytes,
      sha256: encrypted.sha256,
      plaintextBytes,
      plaintextSha256,
      encryption: {
        format: personalServerRecoveryFormats.encryptedArtifact,
        keySha256: encryptionKey.keySha256,
      },
    },
  };
}

function captureBackupApplicationIdentity(values, context) {
  const imageTag = values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG;
  const imageNames = personalImageNames(imageTag);
  const images = {};
  for (const [role, name] of Object.entries(imageNames)) {
    if (context.dryRun) {
      runCommand(['docker', 'image', 'inspect', '--format', '{{.Id}}', name], context);
      images[role] = { name, id: null };
      continue;
    }
    const id = runCommand(['docker', 'image', 'inspect', '--format', '{{.Id}}', name], context, { capture: true }).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error(`Could not bind ${role} image to one exact Docker image ID`);
    images[role] = { name, id };
  }
  const installation = readInstallationState(context)?.value;
  const release = installation?.source?.releaseIdentity;
  const source = release?.tag && release?.commitSha
    ? { kind: 'release-bundle', tag: release.tag, commitSha: release.commitSha }
    : installation?.source?.revision
      ? { kind: 'clean-git', commitSha: installation.source.revision }
      : { kind: 'unmanaged-local' };
  return {
    format: 'charitypilot-personal-server-application-identity/v1',
    imageTag,
    images,
    source,
  };
}

function dryRunBackup(values, backupRoot, context, encryptionKey, { leaveWritersStopped = false } = {}) {
  const id = safeRecoveryId(context);
  const setDir = join(backupRoot, id);
  const archivePath = join(setDir, 'documents.tar');
  runningServices(context);
  runCommand([...composePrefix(context), 'stop', ...WRITER_SERVICES], context);
  runCommand([...composePrefix(context), 'ps', '-q', 'db'], context);
  createExactDatabaseProof({ values, recoverySetId: id, outputDirectory: setDir, context });
  runCommand(['docker', 'volume', 'inspect', DOCUMENT_VOLUME], context);
  runCommandToFile(documentArchiveCommand(), archivePath, context);
  if (encryptionKey) {
    context.writeOutput('DRY RUN: database.dump and documents.tar would be authenticated-encrypted with the supplied key file; the key is never passed to Docker.\n');
  }
  if (leaveWritersStopped) {
    context.writeOutput('DRY RUN: the recovery-snapshot writers would remain stopped for the guarded cutover.\n');
  } else {
    runCommand([
      ...composePrefix(context),
      'up',
      '-d',
      '--no-build',
      '--wait',
      '--wait-timeout',
      String(DEFAULT_WAIT_SECONDS),
      ...WRITER_SERVICES,
    ], context);
  }
  context.writeOutput('DRY RUN: no recovery-set files were written.\n');
  return { backupPath: setDir, dryRun: true, writersBefore: [...WRITER_SERVICES] };
}

function encryptionKeyPathOption(options, context) {
  const value = options['encryption-key-file'];
  if (value !== undefined) {
    if (!isAbsolute(value)) throw new Error('--encryption-key-file must be an explicit absolute path');
    return resolve(value);
  }
  const installedKey = join(dirname(environmentFilePath(context)), 'recovery-key.hex');
  if (existsSync(installedKey)) return installedKey;
  if (existsSync(join(dirname(environmentFilePath(context)), 'install-state.json'))) {
    throw new Error('Installed personal-server recovery key is missing; refusing to create a plaintext backup');
  }
  return undefined;
}

function performBackup(options, context, { leaveWritersStopped = false } = {}) {
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  const backupRoot = resolveBackupRoot(options['output-dir'], context);
  const encryptionKeyFile = encryptionKeyPathOption(options, context);
  const encryptionKey = encryptionKeyFile
    ? loadPersonalServerEncryptionKey(encryptionKeyFile)
    : null;
  if (context.dryRun) {
    return dryRunBackup(values, backupRoot, context, encryptionKey, { leaveWritersStopped });
  }

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupRootStatus = lstatSync(backupRoot);
  if (!backupRootStatus.isDirectory() || backupRootStatus.isSymbolicLink()) {
    throw new Error('Backup output must be a real directory, not a file or symbolic link');
  }
  try { chmodSync(backupRoot, 0o700); } catch { /* Windows ACLs are managed by the operator. */ }
  const id = safeRecoveryId(context);
  const incompleteDir = join(backupRoot, `.${id}.incomplete`);
  const finalDir = join(backupRoot, id);
  const runningBefore = runningServices(context);
  const databaseWasRunning = runningBefore.includes('db');
  const writersBefore = WRITER_SERVICES.filter((service) => runningBefore.includes(service));
  mkdirSync(incompleteDir, { recursive: false, mode: 0o700 });
  const dumpPath = join(incompleteDir, 'database.dump');
  const archivePath = join(incompleteDir, 'documents.tar');
  let databaseStartedForBackup = false;
  let pendingError = null;
  try {
    if (!databaseWasRunning) {
      runCommand([
        ...composePrefix(context),
        'up',
        '-d',
        '--no-build',
        '--wait',
        '--wait-timeout',
        String(DEFAULT_WAIT_SECONDS),
        'db',
      ], context);
      databaseStartedForBackup = true;
    }
    if (writersBefore.length > 0) runCommand([...composePrefix(context), 'stop', ...writersBefore], context);

    verifyContainerId(runCommand([...composePrefix(context), 'ps', '-q', 'db'], context, { capture: true }));
    const databaseProof = createExactDatabaseProof({
      values,
      recoverySetId: id,
      outputDirectory: incompleteDir,
      context,
    });
    if (!existsSync(dumpPath) || statSync(dumpPath).size <= 0) throw new Error('Database backup artifact is missing or empty');

    runCommand(['docker', 'volume', 'inspect', DOCUMENT_VOLUME], context, { capture: true });
    runCommandToFile(documentArchiveCommand(), archivePath, context);

    const documentInventory = inspectPersonalServerDocumentArchive(archivePath);
    const databaseArtifact = packageRecoveryArtifact({
      path: dumpPath,
      label: 'database',
      recoverySetId: id,
      encryptionKey,
      context,
    });
    const documentArtifact = packageRecoveryArtifact({
      path: archivePath,
      label: 'documents',
      recoverySetId: id,
      encryptionKey,
      context,
    });
    if (
      databaseProof.dump?.sha256 !== databaseArtifact.descriptor.plaintextSha256 ||
      Number(databaseProof.dump?.bytes) !== databaseArtifact.descriptor.plaintextBytes
    ) {
      throw new Error('Database proof does not bind the packaged database dump');
    }
    const proofPath = join(incompleteDir, 'database.restore-proof.json');
    const applicationIdentity = captureBackupApplicationIdentity(values, context);

    const manifest = {
      format: 'charitypilot-personal-server-backup/v2',
      recoverySetId: id,
      createdAt: context.now().toISOString(),
      project: PROJECT_NAME,
      origin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      application: applicationIdentity,
      database: {
        ...databaseArtifact.descriptor,
        restoreVerified: true,
        contentFingerprintSha256: databaseProof.source.databaseFingerprintSha256,
        restoreProof: {
          file: 'database.restore-proof.json',
          bytes: statSync(proofPath).size,
          sha256: sha256File(proofPath),
        },
      },
      documents: {
        ...documentArtifact.descriptor,
        volume: DOCUMENT_VOLUME,
        fileCount: documentInventory.fileCount,
        totalFileBytes: documentInventory.totalFileBytes,
        inventorySha256: documentInventory.inventorySha256,
      },
      writersQuiesced: true,
    };
    if (encryptionKey) {
      manifest.authentication = {
        format: personalServerRecoveryFormats.manifestAuthentication,
        file: 'manifest.hmac-sha256',
        keySha256: encryptionKey.keySha256,
      };
    }
    const manifestPath = join(incompleteDir, 'manifest.json');
    writeExclusiveFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeExclusiveFile(join(incompleteDir, 'manifest.sha256'), `${sha256File(manifestPath)}  manifest.json\n`);
    if (encryptionKey) {
      writeExclusiveFile(
        join(incompleteDir, 'manifest.hmac-sha256'),
        `${hmacPersonalServerRecoveryManifest(manifestPath, encryptionKey.key)}  manifest.json\n`,
      );
    }
    const verified = verifyPersonalServerRecoverySet({
      recoverySetPath: incompleteDir,
      expectedProject: PROJECT_NAME,
      expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      encryptionKeyFile,
      extractDocuments: false,
    });
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    renameSync(incompleteDir, finalDir);
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      if (writersBefore.length > 0 && (!leaveWritersStopped || pendingError)) {
        runCommand([
          ...composePrefix(context),
          'up',
          '-d',
          '--no-build',
          '--wait',
          '--wait-timeout',
          String(DEFAULT_WAIT_SECONDS),
          ...writersBefore,
        ], context);
      }
      if (databaseStartedForBackup) runCommand([...composePrefix(context), 'stop', 'db'], context);
    } catch (restoreError) {
      if (!pendingError) throw restoreError;
      pendingError.message = `${pendingError.message}\nFailed to restore the pre-backup service state: ${restoreError.message}`;
    }
    if (pendingError && existsSync(incompleteDir)) rmSync(incompleteDir, { recursive: true, force: true });
  }
  context.writeOutput(`Verified recovery set: ${finalDir}\n`);
  return { backupPath: finalDir, dryRun: false, writersBefore: [...writersBefore] };
}

function restorePreBackupWriterAvailability(recovery, context) {
  const writers = recovery?.writersBefore;
  if (
    !Array.isArray(writers) ||
    writers.some((service) => !WRITER_SERVICES.includes(service)) ||
    new Set(writers).size !== writers.length
  ) {
    throw new Error('Recovery snapshot did not retain a valid pre-backup writer availability record');
  }
  if (writers.length === 0) return;
  runCommand([
    ...composePrefix(context),
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    String(DEFAULT_WAIT_SECONDS),
    ...writers,
  ], context);
}

function backup(options, context) {
  performBackup(options, context);
}

function releaseVersion(tag) {
  const match = /^personal-v(\d+)\.(\d+)\.(\d+)$/u.exec(tag ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function contextForSource(context, sourceRoot, imageTag) {
  const resolvedSource = resolve(sourceRoot);
  if (!existsSync(join(resolvedSource, COMPOSE_FILE_NAME))) throw new Error('Update source is missing compose.personal-server.yml');
  return {
    ...context,
    repoRoot: resolvedSource,
    processEnv: {
      ...context.processEnv,
      CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG: imageTag,
    },
  };
}

function replaceStoredImageTag(context, expectedTag, nextTag) {
  personalImageNames(expectedTag);
  personalImageNames(nextTag);
  const envPath = environmentFilePath(context);
  const text = readFileSync(envPath, 'utf8');
  const line = /^CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG=([^\r\n]+)$/gmu;
  const matches = [...text.matchAll(line)];
  if (matches.length !== 1 || parseDotenvValue(matches[0][1]) !== expectedTag) {
    throw new Error('Protected environment active image tag does not match the expected release');
  }
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: atomically switch protected image tag ${expectedTag} -> ${nextTag}.\n`);
    return;
  }
  const replacement = text.replace(line, `CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG=${dotenvValue(nextTag)}`);
  const temporaryPath = `${envPath}.${process.pid}.${context.randomBytesImpl(6).toString('hex')}.tmp`;
  writeExclusiveFile(temporaryPath, replacement);
  renameSync(temporaryPath, envPath);
  if (loadEnvironmentFile(envPath).CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG !== nextTag) {
    throw new Error('Protected environment image-tag switch did not persist exactly');
  }
}

function writeUpdateReceiptExact(receipt, value, context) {
  if (value?.format !== 'charitypilot-personal-server-update-receipt/v1' || typeof value?.phase !== 'string') {
    throw new Error('Refusing to write an invalid personal-server update receipt');
  }
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: transition protected update receipt ${receipt.value.phase} -> ${value.phase}.\n`);
  } else {
    const temporaryPath = `${receipt.path}.${process.pid}.${context.randomBytesImpl(6).toString('hex')}.tmp`;
    writeExclusiveFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporaryPath, receipt.path);
  }
  receipt.value = value;
  return value;
}

function transitionUpdateReceipt(receipt, expectedPhases, nextPhase, patch, context) {
  if (!expectedPhases.includes(receipt.value.phase)) {
    throw new Error(`Update receipt phase ${receipt.value.phase} cannot transition to ${nextPhase}`);
  }
  return writeUpdateReceiptExact(receipt, {
    ...receipt.value,
    ...patch,
    phase: nextPhase,
    updatedAt: context.now().toISOString(),
  }, context);
}

export function archiveUpdateReceipt(receipt, outcome, context) {
  if (!['completed', 'rolled-back', 'failed-pre-cutover'].includes(outcome)) {
    throw new Error('Update receipt archive outcome is invalid');
  }
  const attemptId = receipt.value.attemptId;
  if (!/^[a-f0-9]{24}$/u.test(attemptId ?? '')) throw new Error('Update receipt attempt identity is invalid');
  const tag = receipt.identity.tag;
  if (context.dryRun) {
    context.writeOutput(`DRY RUN: archive protected update receipt as ${outcome}.\n`);
    return `<protected-${outcome}-update-receipt>`;
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const collisionSuffix = attempt === 0 ? '' : `-${context.randomBytesImpl(4).toString('hex')}`;
    const archivedPath = join(dirname(receipt.path), `${outcome}-update-${tag}-${attemptId}${collisionSuffix}.json`);
    if (existsSync(archivedPath)) continue;
    renameSync(receipt.path, archivedPath);
    receipt.path = archivedPath;
    return archivedPath;
  }
  throw new Error('Could not allocate a collision-safe archived update receipt path');
}

function readUpdateReceipt(options, context, installationState, values) {
  const receiptOption = options['update-receipt'];
  if (!receiptOption || !isAbsolute(receiptOption)) throw new Error('--update-receipt must be an explicit absolute protected path');
  const receiptPath = resolve(receiptOption);
  const stateDirectory = dirname(environmentFilePath(context));
  if (dirname(receiptPath) !== stateDirectory || basename(receiptPath) !== 'pending-update.json') {
    throw new Error('Update receipt must be the protected state pending-update.json');
  }
  const status = lstatSync(receiptPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 64 * 1024) {
    throw new Error('Update receipt must be a small regular non-symlink file');
  }
  const receipt = parseAllowlistedJson(readFileSync(receiptPath, 'utf8'), 'Update receipt');
  const identityPath = join(context.repoRoot, 'personal-server-release.json');
  const identity = parseAllowlistedJson(readFileSync(identityPath, 'utf8'), 'Target release identity');
  const createdAtMs = Date.parse(receipt.createdAt ?? '');
  const age = context.now().getTime() - createdAtMs;
  const resumePending = options.resumePending === true;
  const acceptedPhases = resumePending ? ['prepared', 'pre-cutover'] : ['prepared'];
  const maximumAge = resumePending ? MAX_PENDING_UPDATE_RESUME_AGE_MS : 60 * 60 * 1000;
  if (resumePending && !acceptedPhases.includes(receipt.phase)) {
    throw new Error(`Refusing automatic resume from ambiguous update receipt phase ${receipt.phase ?? '<missing>'}`);
  }
  if (!resumePending && receipt.attemptId !== undefined) {
    throw new Error('Pending update was already attempted; rerun the verified updater with explicit --resume-pending');
  }
  if (receipt.attemptId !== undefined && !/^[a-f0-9]{24}$/u.test(receipt.attemptId)) {
    throw new Error('Pending update attempt identity is invalid');
  }
  if (
    receipt.format !== 'charitypilot-personal-server-update-receipt/v1' ||
    !acceptedPhases.includes(receipt.phase) ||
    !Number.isFinite(createdAtMs) || age < -MAX_RECOVERY_CLOCK_SKEW_MS || age > maximumAge ||
    resolve(receipt.target?.sourceRoot ?? '') !== context.repoRoot ||
    receipt.target?.tag !== identity.tag || receipt.target?.commitSha !== identity.commitSha ||
    receipt.target?.archiveFile !== `CharityPilot-${identity.tag}.zip` ||
    !/^[a-f0-9]{64}$/u.test(receipt.target?.archiveSha256 ?? '') ||
    identity.format !== 'charitypilot-personal-server-bundle/v1' || identity.profile !== 'personal-server' ||
    !releaseVersion(identity.tag) || !/^[a-f0-9]{40}$/u.test(identity.commitSha ?? '') ||
    receipt.current?.imageTag !== values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG ||
    resolve(receipt.current?.sourceRoot ?? '') !== resolve(installationState.value.sourceRoot ?? '')
  ) {
    throw new Error('Protected update receipt does not bind the current installation to this exact verified release bundle');
  }
  const currentVersion = releaseVersion(installationState.value.source?.releaseIdentity?.tag);
  const targetVersion = releaseVersion(identity.tag);
  if (currentVersion && compareReleaseVersions(targetVersion, currentVersion) <= 0) {
    throw new Error('Target personal-server release must be newer than the installed release');
  }
  if (identity.tag === values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG) {
    throw new Error('Target release image tag is already active');
  }
  if (installationState.value.activeImageTag !== values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG) {
    throw new Error('Protected installation state active image tag does not match the protected environment');
  }
  assertCleanGitReleaseAdoption(
    installationState,
    values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG,
    identity.commitSha,
    context,
  );
  return { path: receiptPath, value: receipt, identity };
}

function expectedApplicationSource(source) {
  const release = source?.releaseIdentity;
  if (
    release?.tag && release?.commitSha &&
    /^personal-v\d+\.\d+\.\d+$/u.test(release.tag) &&
    /^[a-f0-9]{40}$/u.test(release.commitSha)
  ) {
    return { kind: 'release-bundle', tag: release.tag, commitSha: release.commitSha };
  }
  if (/^[a-f0-9]{40}$/u.test(source?.revision ?? '')) {
    return { kind: 'clean-git', commitSha: source.revision };
  }
  throw new Error('Recorded rollback source identity is incomplete');
}

export function validateReplacementRestoreSourceBinding(application, imageTag, installationSource) {
  const expected = expectedApplicationSource(installationSource);
  if (
    application?.format !== 'charitypilot-personal-server-application-identity/v1' ||
    application.imageTag !== imageTag ||
    application.source?.kind !== expected.kind ||
    (expected.kind === 'release-bundle' && (
      application.source.tag !== expected.tag || application.source.commitSha !== expected.commitSha
    )) ||
    (expected.kind === 'clean-git' && application.source.commitSha !== expected.commitSha)
  ) {
    throw new Error('Replacement-host recovery source does not match the exact authenticated backup source');
  }
  return true;
}

export function validateRecoveryApplicationBinding(application, expectedTag, expectedSource, retainedImages) {
  const source = expectedApplicationSource(expectedSource);
  if (
    application?.format !== 'charitypilot-personal-server-application-identity/v1' ||
    application.imageTag !== expectedTag ||
    application.source?.kind !== source.kind ||
    (source.kind === 'release-bundle' && (
      application.source.tag !== source.tag || application.source.commitSha !== source.commitSha
    )) ||
    (source.kind === 'clean-git' && application.source.commitSha !== source.commitSha)
  ) {
    throw new Error('Recovery set application source identity does not match the recorded rollback release');
  }
  const expectedNames = personalImageNames(expectedTag);
  for (const role of ['api', 'migrations', 'web']) {
    const manifestImage = application.images?.[role];
    const retainedImage = retainedImages?.[role];
    if (
      manifestImage?.name !== expectedNames[role] ||
      !/^sha256:[a-f0-9]{64}$/u.test(manifestImage?.id ?? '') ||
      retainedImage?.name !== expectedNames[role] ||
      retainedImage.id !== manifestImage.id
    ) {
      throw new Error(`Retained ${role} image does not match the authenticated recovery-set image identity`);
    }
  }
  return true;
}

function inspectRetainedImages(tag, context, dryRunIdentity) {
  const names = personalImageNames(tag);
  const images = {};
  for (const role of ['api', 'migrations', 'web']) {
    if (context.dryRun) {
      runCommand(['docker', 'image', 'inspect', '--format', '{{.Id}}', names[role]], context);
      images[role] = { name: names[role], id: dryRunIdentity.images[role].id };
      continue;
    }
    const id = runCommand(
      ['docker', 'image', 'inspect', '--format', '{{.Id}}', names[role]],
      context,
      { capture: true },
    ).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error(`Retained ${role} image ID is invalid`);
    images[role] = { name: names[role], id };
  }
  return images;
}

function assertRetainedSourceIdentity(sourceRoot, source, context) {
  const expected = expectedApplicationSource(source);
  if (expected.kind === 'release-bundle') {
    const identityPath = join(sourceRoot, 'personal-server-release.json');
    if (!existsSync(identityPath)) throw new Error('Retained release source identity file is missing');
    const identity = parseAllowlistedJson(readFileSync(identityPath, 'utf8'), 'Retained release source identity');
    if (
      identity.format !== 'charitypilot-personal-server-bundle/v1' ||
      identity.profile !== 'personal-server' ||
      identity.tag !== expected.tag ||
      identity.commitSha !== expected.commitSha
    ) throw new Error('Retained release source does not match the recorded rollback identity');
    return;
  }
  if (context.dryRun) {
    runCommand(['git', 'status', '--porcelain=v1', '--untracked-files=all'], { ...context, repoRoot: sourceRoot });
    runCommand(['git', 'rev-parse', 'HEAD'], { ...context, repoRoot: sourceRoot });
    return;
  }
  const sourceContext = { ...context, repoRoot: sourceRoot };
  const status = runCommand(['git', 'status', '--porcelain=v1', '--untracked-files=all'], sourceContext, { capture: true }).trim();
  const revision = runCommand(['git', 'rev-parse', 'HEAD'], sourceContext, { capture: true }).trim();
  if (status || revision !== expected.commitSha) {
    throw new Error('Retained Git rollback source is dirty or no longer at the recorded revision');
  }
}

function assertRecoveryApplicationBinding(verified, expectedTag, expectedSource, sourceRoot, context) {
  assertRetainedSourceIdentity(sourceRoot, expectedSource, context);
  const application = verified.manifest.application;
  const retainedImages = inspectRetainedImages(expectedTag, context, application);
  validateRecoveryApplicationBinding(application, expectedTag, expectedSource, retainedImages);
}

function dryRunVerifiedRecovery(recoveryPath, values, imageTag, source) {
  const names = personalImageNames(imageTag);
  return {
    manifest: {
      recoverySetId: basename(recoveryPath),
      origin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      application: {
        format: 'charitypilot-personal-server-application-identity/v1',
        imageTag,
        images: {
          api: { name: names.api, id: `sha256:${'a'.repeat(64)}` },
          migrations: { name: names.migrations, id: `sha256:${'b'.repeat(64)}` },
          web: { name: names.web, id: `sha256:${'c'.repeat(64)}` },
        },
        source: expectedApplicationSource(source),
      },
    },
    databasePath: '<verified-pre-update-database-dump>',
    documentsPath: '<verified-pre-update-documents>',
    databaseProof: { source: { databaseFingerprintSha256: '0'.repeat(64) } },
    documentInventory: { files: [] },
  };
}

function restoreVerifiedRecoveryIntoRuntime(verified, values, context) {
  const targets = assertPersonalRestoreTargets(context);
  restoreDatabaseDump(
    targets.databaseContainer,
    verified.databasePath,
    values,
    context,
    { replaceDatabase: true },
  );
  proveRestoredDatabaseContent({ verified, values, host: 'db', network: INTERNAL_NETWORK, context });
  populateDocumentVolume(DOCUMENT_VOLUME, verified.documentsPath, context, { clearExisting: true });
}

function stopAllWritersForDestructiveRecovery(context) {
  runCommand([...composePrefix(context), 'stop', ...WRITER_SERVICES], context);
}

export function executePersonalServerCutoverRecovery({
  stopWriters,
  restoreImageTag,
  restoreData,
  startRuntime: startRecoveredRuntime,
  restoreInstallationState,
}) {
  for (const [name, operation] of Object.entries({
    stopWriters,
    restoreImageTag,
    restoreData,
    startRecoveredRuntime,
    restoreInstallationState,
  })) {
    if (typeof operation !== 'function') throw new Error(`Missing cutover recovery operation ${name}`);
  }
  stopWriters();
  restoreImageTag();
  restoreData();
  startRecoveredRuntime();
  restoreInstallationState();
}

export function executePersonalServerRestoreCutover({
  persistRestoring,
  stopWriters,
  restoreSelectedDatabase,
  proveSelectedDatabaseFingerprint,
  migrateCurrentSchema,
  restoreSelectedDocuments,
  startSelectedRuntime,
  verifySelectedApplication,
  persistReady,
}) {
  const operations = {
    persistRestoring,
    stopWriters,
    restoreSelectedDatabase,
    proveSelectedDatabaseFingerprint,
    migrateCurrentSchema,
    restoreSelectedDocuments,
    startSelectedRuntime,
    verifySelectedApplication,
    persistReady,
  };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== 'function') throw new Error(`Missing restore cutover operation ${name}`);
  }
  persistRestoring();
  stopWriters();
  restoreSelectedDatabase();
  proveSelectedDatabaseFingerprint();
  migrateCurrentSchema();
  restoreSelectedDocuments();
  startSelectedRuntime();
  verifySelectedApplication();
  persistReady();
}

export function executePersonalServerDecommissionFinalization({
  stopWriters,
  verifyFinalRecovery,
  rehearseFinalRecovery,
  closePrivateAccess,
  removeRuntime,
  removeDatabaseVolume,
  removeDocumentVolume,
  assertResourcesAbsent,
  persistDecommissioned,
}) {
  const operations = {
    stopWriters,
    verifyFinalRecovery,
    rehearseFinalRecovery,
    closePrivateAccess,
    removeRuntime,
    removeDatabaseVolume,
    removeDocumentVolume,
    assertResourcesAbsent,
    persistDecommissioned,
  };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== 'function') throw new Error(`Missing decommission operation ${name}`);
  }
  stopWriters();
  const verified = verifyFinalRecovery();
  rehearseFinalRecovery(verified);
  closePrivateAccess();
  removeRuntime();
  removeDatabaseVolume();
  removeDocumentVolume();
  assertResourcesAbsent();
  persistDecommissioned();
  return verified;
}

function ensureStoredImageTag(context, desiredTag, alternateTag) {
  const activeTag = loadEnvironmentFile(environmentFilePath(context)).CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG;
  if (activeTag === desiredTag) return;
  if (activeTag !== alternateTag) {
    throw new Error(`Protected environment image tag ${activeTag} is neither expected recovery identity`);
  }
  replaceStoredImageTag(context, alternateTag, desiredTag);
}

function update(options, context) {
  const installationState = readInstallationState(context);
  if (!installationState || installationState.value.phase !== 'ready') {
    throw new Error('Version-bound update requires a ready protected installer state');
  }
  const originalInstallationState = JSON.parse(JSON.stringify(installationState.value));
  const values = loadEnvironmentFile(environmentFilePath(context));
  const receipt = readUpdateReceipt(options, context, installationState, values);
  const currentTag = values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG;
  const targetTag = receipt.identity.tag;
  const currentContext = contextForSource(context, installationState.value.sourceRoot, currentTag);
  const targetContext = contextForSource(context, context.repoRoot, targetTag);
  validateCompose(currentContext);
  validateCompose(targetContext);
  if (!receipt.value.attemptId) {
    transitionUpdateReceipt(receipt, ['prepared'], 'prepared', {
      attemptId: context.randomBytesImpl(12).toString('hex'),
      attemptStartedAt: context.now().toISOString(),
    }, context);
  }

  let recovery;
  let verified;
  let writersQuiesced = false;
  let installationStateTransitioned = false;
  let cutoverStarted = false;
  let updateCompleted = false;
  try {
    recovery = performBackup({
      'output-dir': options['output-dir'],
      'encryption-key-file': options['encryption-key-file'],
    }, currentContext, { leaveWritersStopped: true });
    writersQuiesced = !context.dryRun;
    const encryptionKeyFile = encryptionKeyPathOption(options, currentContext);
    verified = context.dryRun
      ? dryRunVerifiedRecovery(recovery.backupPath, values, currentTag, installationState.value.source)
      : verifyPersonalServerRecoverySet({
        recoverySetPath: recovery.backupPath,
        expectedProject: PROJECT_NAME,
        expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
        encryptionKeyFile,
      });
    assertRecoveryApplicationBinding(
      verified,
      currentTag,
      installationState.value.source,
      installationState.value.sourceRoot,
      currentContext,
    );
    buildImagesSequentially(targetContext);
    runDisposableApplicationRehearsal(verified, values, targetContext, { images: personalImageNames(targetTag) });
    assertPersonalRestoreTargets(currentContext);
    transitionUpdateReceipt(receipt, ['prepared', 'pre-cutover'], 'pre-cutover', {
      preUpdateRecoverySet: recovery.backupPath,
      currentImageTag: currentTag,
      targetImageTag: targetTag,
      preCutoverVerifiedAt: context.now().toISOString(),
    }, context);
    transitionUpdateReceipt(receipt, ['pre-cutover'], 'cutover-started', {
      cutoverStartedAt: context.now().toISOString(),
    }, context);
    updateInstallationState(context, {
      phase: 'updating',
      updateOperation: {
        kind: 'version-update',
        attemptId: receipt.value.attemptId,
        fromImageTag: currentTag,
        toImageTag: targetTag,
        preUpdateRecoverySet: recovery.backupPath,
        startedAt: context.now().toISOString(),
      },
    });
    installationStateTransitioned = !context.dryRun;
    runCommand([...composePrefix(currentContext), 'stop', ...WRITER_SERVICES], currentContext);
    cutoverStarted = true;
    replaceStoredImageTag(context, currentTag, targetTag);
    runCommand([...composePrefix(targetContext), '--profile', 'maintenance', 'run', '--rm', 'migrate'], targetContext);
    startRuntime(targetContext);
    writersQuiesced = false;

    if (!context.dryRun) {
      transitionUpdateReceipt(receipt, ['cutover-started'], 'runtime-ready', {
        runtimeReadyAt: context.now().toISOString(),
      }, context);
      updateInstallationState(context, {
        phase: 'ready',
        sourceRoot: context.repoRoot,
        source: {
          kind: 'release-bundle',
          verifiedArchive: {
            file: receipt.value.target.archiveFile,
            sha256: receipt.value.target.archiveSha256,
          },
          releaseIdentity: receipt.identity,
        },
        activeImageTag: targetTag,
        previousRelease: {
          sourceRoot: installationState.value.sourceRoot,
          source: installationState.value.source,
          imageTag: currentTag,
          recoverySetPath: recovery.backupPath,
        },
        lastUpdate: {
          completedAt: context.now().toISOString(),
          fromImageTag: currentTag,
          toImageTag: targetTag,
          preUpdateRecoverySet: recovery.backupPath,
        },
        updateOperation: null,
      });
      transitionUpdateReceipt(receipt, ['runtime-ready'], 'completed', {
        completedAt: context.now().toISOString(),
      }, context);
      archiveUpdateReceipt(receipt, 'completed', context);
      installationStateTransitioned = false;
      updateCompleted = true;
    } else {
      context.writeOutput(`DRY RUN: version-bound update ${currentTag} -> ${targetTag} would retain the prior images and recovery set.\n`);
    }
  } catch (error) {
    let recoveryError = null;
    if (cutoverStarted && !context.dryRun && verified) {
      try {
        executePersonalServerCutoverRecovery({
          stopWriters: () => stopAllWritersForDestructiveRecovery(targetContext),
          restoreImageTag: () => ensureStoredImageTag(context, currentTag, targetTag),
          restoreData: () => restoreVerifiedRecoveryIntoRuntime(verified, values, currentContext),
          startRuntime: () => startRuntime(currentContext),
          restoreInstallationState: () => writeInstallationStateExact(context, originalInstallationState),
        });
        installationStateTransitioned = false;
        transitionUpdateReceipt(
          receipt,
          ['cutover-started', 'runtime-ready', 'completed'],
          'rolled-back',
          { rolledBackAt: context.now().toISOString(), failure: redactText(error.message).slice(0, 2000) },
          context,
        );
        archiveUpdateReceipt(receipt, 'rolled-back', context);
        error.message = `${error.message}\nAutomatic rollback restored ${currentTag} and recovery set ${recovery.backupPath}.`;
      } catch (rollbackError) {
        recoveryError = rollbackError;
      }
    } else if (!context.dryRun) {
      const preCutoverRecoveryErrors = [];
      if (installationStateTransitioned) {
        try {
          writeInstallationStateExact(context, originalInstallationState);
          installationStateTransitioned = false;
        } catch (stateError) {
          preCutoverRecoveryErrors.push(stateError);
        }
      }
      if (writersQuiesced && recovery) {
        try {
          restorePreBackupWriterAvailability(recovery, currentContext);
          writersQuiesced = false;
        } catch (availabilityError) {
          preCutoverRecoveryErrors.push(availabilityError);
        }
      }
      if (existsSync(receipt.path)) {
        try {
          transitionUpdateReceipt(
            receipt,
            ['prepared', 'pre-cutover', 'cutover-started'],
            'failed-pre-cutover',
            { failedAt: context.now().toISOString(), failure: redactText(error.message).slice(0, 2000) },
            context,
          );
          archiveUpdateReceipt(receipt, 'failed-pre-cutover', context);
        } catch (receiptError) {
          preCutoverRecoveryErrors.push(receiptError);
        }
      }
      if (preCutoverRecoveryErrors.length > 0) {
        recoveryError = new Error(preCutoverRecoveryErrors.map(({ message }) => message).join('; '));
      }
    }
    if (recoveryError) {
      error.message = `${error.message}\nAUTOMATIC ROLLBACK FAILED: ${recoveryError.message}. Runtime state is uncertain; do not start or write data.`;
    }
    throw error;
  } finally {
    cleanupPersonalServerRecoveryStaging(verified?.stagingDirectory);
  }
  if (updateCompleted) {
    context.writeOutput(`Personal server updated to ${targetTag}. Pre-update recovery set: ${recovery.backupPath}\n`);
  }
}

export function personalServerRollbackConfirmation(currentTag, previousTag, recoverySetPath) {
  personalImageNames(currentTag);
  personalImageNames(previousTag);
  const binding = createHash('sha256')
    .update(currentTag)
    .update('\0')
    .update(previousTag)
    .update('\0')
    .update(resolve(recoverySetPath))
    .digest('hex')
    .slice(0, 16);
  return `ROLLBACK-CHARITYPILOT-PERSONAL-SERVER:${currentTag}-TO-${previousTag}:${binding}`;
}

function rollback(options, context) {
  const installationState = readInstallationState(context);
  if (!installationState || installationState.value.phase !== 'ready') {
    throw new Error('Rollback requires a ready protected installer state');
  }
  const originalInstallationState = JSON.parse(JSON.stringify(installationState.value));
  const previous = installationState.value.previousRelease;
  if (
    !previous || typeof previous !== 'object' ||
    !isAbsolute(previous.sourceRoot ?? '') || !existsSync(join(previous.sourceRoot, COMPOSE_FILE_NAME)) ||
    !isAbsolute(previous.recoverySetPath ?? '')
  ) {
    throw new Error('No complete previous release and recovery-set binding is available for rollback');
  }
  const values = loadEnvironmentFile(environmentFilePath(context));
  const currentTag = values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG;
  const previousTag = previous.imageTag;
  const expectedConfirmation = personalServerRollbackConfirmation(currentTag, previousTag, previous.recoverySetPath);
  if (context.dryRun && options.confirm === undefined) {
    context.writeOutput(`Required rollback confirmation: ${expectedConfirmation}\n`);
    context.writeOutput('DRY RUN: confirmation discovery performed no backup, rehearsal, image switch, data restore, or state change.\n');
    return;
  }
  if (options.confirm !== expectedConfirmation) {
    throw new Error(`--confirm must exactly equal ${expectedConfirmation}`);
  }
  if (resolve(installationState.value.sourceRoot) !== context.repoRoot) {
    throw new Error('Run rollback from the active release source recorded by the protected installer state');
  }
  const encryptionKeyFile = encryptionKeyPathOption(options, context);
  const currentContext = contextForSource(context, context.repoRoot, currentTag);
  const previousContext = contextForSource(context, previous.sourceRoot, previousTag);
  let previousVerified;
  let preservation;
  let currentVerified;
  let writersQuiesced = false;
  let installationStateTransitioned = false;
  let cutoverStarted = false;
  let rollbackCompleted = false;
  try {
    previousVerified = verifyPersonalServerRecoverySet({
      recoverySetPath: previous.recoverySetPath,
      expectedProject: PROJECT_NAME,
      expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      encryptionKeyFile,
      materialize: !context.dryRun,
    });
    assertRecoveryApplicationBinding(
      previousVerified,
      previousTag,
      previous.source,
      previous.sourceRoot,
      previousContext,
    );
    runDisposableApplicationRehearsal(previousVerified, values, previousContext, { images: personalImageNames(previousTag) });
    assertPersonalRestoreTargets(currentContext);
    preservation = performBackup({
      'output-dir': options['output-dir'],
      'encryption-key-file': options['encryption-key-file'],
    }, currentContext, { leaveWritersStopped: true });
    writersQuiesced = !context.dryRun;
    currentVerified = context.dryRun
      ? dryRunVerifiedRecovery(preservation.backupPath, values, currentTag, installationState.value.source)
      : verifyPersonalServerRecoverySet({
        recoverySetPath: preservation.backupPath,
        expectedProject: PROJECT_NAME,
        expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
        encryptionKeyFile,
      });
    assertRecoveryApplicationBinding(
      currentVerified,
      currentTag,
      installationState.value.source,
      installationState.value.sourceRoot,
      currentContext,
    );
    updateInstallationState(context, {
      phase: 'updating',
      updateOperation: {
        kind: 'manual-rollback',
        fromImageTag: currentTag,
        toImageTag: previousTag,
        selectedRecoverySet: previous.recoverySetPath,
        preRollbackRecoverySet: preservation.backupPath,
        startedAt: context.now().toISOString(),
      },
    });
    installationStateTransitioned = !context.dryRun;
    runCommand([...composePrefix(currentContext), 'stop', ...WRITER_SERVICES], currentContext);
    cutoverStarted = true;
    replaceStoredImageTag(context, currentTag, previousTag);
    restoreVerifiedRecoveryIntoRuntime(previousVerified, values, previousContext);
    startRuntime(previousContext);
    writersQuiesced = false;
    if (!context.dryRun) {
      updateInstallationState(context, {
        phase: 'ready',
        sourceRoot: previous.sourceRoot,
        source: previous.source,
        activeImageTag: previousTag,
        previousRelease: {
          sourceRoot: installationState.value.sourceRoot,
          source: installationState.value.source,
          imageTag: currentTag,
          recoverySetPath: preservation.backupPath,
        },
        lastRollback: {
          completedAt: context.now().toISOString(),
          fromImageTag: currentTag,
          toImageTag: previousTag,
          preRollbackRecoverySet: preservation.backupPath,
        },
        updateOperation: null,
      });
      installationStateTransitioned = false;
      rollbackCompleted = true;
    } else {
      context.writeOutput(`DRY RUN: rollback ${currentTag} -> ${previousTag} would preserve the current state first.\n`);
    }
  } catch (error) {
    let recoveryError = null;
    if (cutoverStarted && !context.dryRun) {
      try {
        executePersonalServerCutoverRecovery({
          stopWriters: () => stopAllWritersForDestructiveRecovery(previousContext),
          restoreImageTag: () => ensureStoredImageTag(context, currentTag, previousTag),
          restoreData: () => restoreVerifiedRecoveryIntoRuntime(currentVerified, values, currentContext),
          startRuntime: () => startRuntime(currentContext),
          restoreInstallationState: () => writeInstallationStateExact(context, originalInstallationState),
        });
        installationStateTransitioned = false;
        error.message = `${error.message}\nAutomatic rollback-of-rollback restored ${currentTag} and ${preservation.backupPath}.`;
      } catch (rollbackRecoveryError) {
        recoveryError = rollbackRecoveryError;
      }
    } else if (!context.dryRun) {
      const preCutoverRecoveryErrors = [];
      if (installationStateTransitioned) {
        try {
          writeInstallationStateExact(context, originalInstallationState);
          installationStateTransitioned = false;
        } catch (stateRecoveryError) {
          preCutoverRecoveryErrors.push(stateRecoveryError);
        }
      }
      if (writersQuiesced && preservation) {
        try {
          restorePreBackupWriterAvailability(preservation, currentContext);
          writersQuiesced = false;
        } catch (availabilityError) {
          preCutoverRecoveryErrors.push(availabilityError);
        }
      }
      if (preCutoverRecoveryErrors.length > 0) {
        recoveryError = new Error(preCutoverRecoveryErrors.map(({ message }) => message).join('; '));
      }
    }
    if (recoveryError) {
      error.message = `${error.message}\nROLLBACK RECOVERY FAILED: ${recoveryError.message}. Runtime state is uncertain; do not start or write data.`;
    }
    throw error;
  } finally {
    cleanupPersonalServerRecoveryStaging(previousVerified?.stagingDirectory);
    cleanupPersonalServerRecoveryStaging(currentVerified?.stagingDirectory);
  }
  if (rollbackCompleted) {
    context.writeOutput(`Personal server rolled back to ${previousTag}. Pre-rollback recovery set: ${preservation.backupPath}\n`);
  }
}

function parseDockerInspect(output, label) {
  const value = parseAllowlistedJson(output, label);
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  if (value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error(`${label} did not resolve exactly one object`);
  }
  return value[0];
}

export function validatePersonalServerVolumeIdentity(volume, volumeName, composeVolumeName) {
  if (
    !volume || typeof volume !== 'object' ||
    volume.Name !== volumeName ||
    volume.Driver !== 'local' ||
    volume.Labels?.['com.docker.compose.project'] !== PROJECT_NAME ||
    volume.Labels?.['com.docker.compose.volume'] !== composeVolumeName
  ) {
    throw new Error(`Refusing recovery because Docker volume ${volumeName} is not the exact personal-server Compose volume`);
  }
  return true;
}

export function validatePersonalServerNetworkIdentity(network) {
  if (
    !network || typeof network !== 'object' ||
    network.Name !== INTERNAL_NETWORK ||
    network.Driver !== 'bridge' ||
    network.Internal !== true ||
    network.Labels?.['com.docker.compose.project'] !== PROJECT_NAME ||
    network.Labels?.['com.docker.compose.network'] !== 'personal-server-internal' ||
    !Array.isArray(network.IPAM?.Config) || network.IPAM.Config.length !== 1 ||
    network.IPAM.Config[0]?.Subnet !== '172.30.250.0/24' ||
    network.IPAM.Config[0]?.Gateway !== '172.30.250.1'
  ) {
    throw new Error(`Refusing decommission because Docker network ${INTERNAL_NETWORK} is not the exact internal personal-server Compose network`);
  }
  return true;
}

function inspectPersonalVolume(volumeName, composeVolumeName, context) {
  if (context.dryRun) {
    runCommand(['docker', 'volume', 'inspect', volumeName], context);
    return;
  }
  const volume = parseDockerInspect(
    runCommand(['docker', 'volume', 'inspect', volumeName], context, { capture: true }),
    `Docker volume ${volumeName}`,
  );
  validatePersonalServerVolumeIdentity(volume, volumeName, composeVolumeName);
}

function inspectPersonalNetwork(context) {
  if (context.dryRun) {
    runCommand(['docker', 'network', 'inspect', INTERNAL_NETWORK], context);
    return;
  }
  const network = parseDockerInspect(
    runCommand(['docker', 'network', 'inspect', INTERNAL_NETWORK], context, { capture: true }),
    `Docker network ${INTERNAL_NETWORK}`,
  );
  validatePersonalServerNetworkIdentity(network);
}

function inspectPersonalServiceContainer(service, expectedVolume, expectedDestination, context) {
  if (context.dryRun) {
    runCommand([...composePrefix(context), 'ps', '-q', service], context);
    runCommand(['docker', 'inspect', `<${service}-container-id>`], context);
    return `<${service}-container-id>`;
  }
  const id = verifyContainerId(runCommand([...composePrefix(context), 'ps', '-q', service], context, { capture: true }));
  const container = parseDockerInspect(
    runCommand(['docker', 'inspect', id], context, { capture: true }),
    `Docker container for ${service}`,
  );
  const expectedMount = container.Mounts?.filter((mount) => (
    mount.Type === 'volume' && mount.Name === expectedVolume && mount.Destination === expectedDestination
  )) ?? [];
  if (
    !String(container.Id ?? '').startsWith(id) ||
    container.Config?.Labels?.['com.docker.compose.project'] !== PROJECT_NAME ||
    container.Config?.Labels?.['com.docker.compose.service'] !== service ||
    expectedMount.length !== 1
  ) {
    throw new Error(`Refusing recovery because ${service} is not the exact personal-server Compose container`);
  }
  return id;
}

function assertPersonalRestoreTargets(context) {
  inspectPersonalVolume(DATABASE_VOLUME, 'personal-server-db', context);
  inspectPersonalVolume(DOCUMENT_VOLUME, 'personal-server-documents', context);
  inspectPersonalNetwork(context);
  return {
    databaseContainer: inspectPersonalServiceContainer('db', DATABASE_VOLUME, '/var/lib/postgresql/data', context),
  };
}

function restoreDatabaseDump(container, dumpPath, values, context, { replaceDatabase }) {
  const containerDump = `/tmp/charitypilot-personal-restore-${randomHex(4, context.randomBytesImpl)}.dump`;
  let copied = false;
  let pendingError = null;
  try {
    runCommand(['docker', 'cp', dumpPath, `${container}:${containerDump}`], context);
    copied = true;
    if (replaceDatabase) {
      runCommand([
        'docker', 'exec', container, 'dropdb', '--username', values.POSTGRES_USER,
        '--if-exists', '--force', values.POSTGRES_DB,
      ], context);
      runCommand([
        'docker', 'exec', container, 'createdb', '--username', values.POSTGRES_USER,
        '--owner', values.POSTGRES_USER, values.POSTGRES_DB,
      ], context);
    }
    runCommand([
      'docker', 'exec', container, 'pg_restore', '--username', values.POSTGRES_USER,
      '--dbname', values.POSTGRES_DB, '--exit-on-error', '--no-owner', '--no-privileges', containerDump,
    ], context);
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    if (copied || context.dryRun) {
      try {
        runCommand(['docker', 'exec', container, 'rm', '-f', containerDump], context);
      } catch (cleanupError) {
        if (!pendingError) throw cleanupError;
        pendingError.message = `${pendingError.message}\nFailed to remove the staged database dump: ${cleanupError.message}`;
      }
    }
  }
}

function populateDocumentVolume(volumeName, documentsPath, context, { clearExisting }) {
  const loader = `charitypilot-personal-document-loader-${randomHex(4, context.randomBytesImpl)}`;
  let started = false;
  let pendingError = null;
  try {
    runCommand([
      'docker', 'run', '-d', '--name', loader, '--pull', 'never', '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--mount', `type=volume,src=${volumeName},dst=/documents`,
      DOCUMENT_ARCHIVE_IMAGE, 'sleep', '300',
    ], context);
    started = true;
    if (clearExisting) {
      runCommand([
        'docker', 'exec', loader, 'sh', '-ec',
        'find /documents -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
      ], context);
    }
    runCommand(['docker', 'cp', `${documentsPath}${sep}.`, `${loader}:/documents`], context);
    runCommand([
      'docker', 'exec', loader, 'sh', '-ec',
      'chown -R 1000:1000 /documents && chmod 0700 /documents && find /documents -type d -exec chmod 0700 {} + && find /documents -type f -exec chmod 0600 {} +',
    ], context);
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    if (started || context.dryRun) {
      try {
        runCommand(['docker', 'rm', '-f', loader], context);
      } catch (cleanupError) {
        if (!pendingError) throw cleanupError;
        pendingError.message = `${pendingError.message}\nFailed to remove the document loader: ${cleanupError.message}`;
      }
    }
  }
}

function waitForRecoveryDatabase(container, values, context) {
  runCommand([
    'docker', 'exec', container, 'sh', '-ec',
    `for i in $(seq 1 120); do pg_isready -U ${values.POSTGRES_USER} -d ${values.POSTGRES_DB} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`,
  ], context);
}

function waitForRecoveryApi(container, context) {
  runCommand([
    'docker', 'exec', container, 'node', '-e',
    "(async()=>{for(let i=0;i<120;i+=1){try{const r=await fetch('http://127.0.0.1:3002/api/v1/health/readiness',{headers:{'x-charitypilot-readiness-key':process.env.READINESS_API_KEY||''}});if(r.ok)process.exit(0)}catch{}await new Promise(resolve=>setTimeout(resolve,1000))}process.exit(1)})()",
  ], context);
}

function waitForRecoveryWeb(container, context) {
  runCommand([
    'docker', 'exec', container, 'node', '-e',
    "(async()=>{for(let i=0;i<120;i+=1){try{const r=await fetch('http://127.0.0.1:3003/login',{redirect:'manual'});if(r.status===200)process.exit(0)}catch{}await new Promise(resolve=>setTimeout(resolve,1000))}process.exit(1)})()",
  ], context);
}

function readOwnerPasswordProofFile(options) {
  const value = options['owner-password-file'];
  if (value === undefined) return null;
  if (!isAbsolute(value)) throw new Error('--owner-password-file must be an explicit absolute path');
  const resolved = resolve(value);
  const status = lstatSync(resolved);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 12 || status.size > 1024) {
    throw new Error('Owner password proof file must be a small regular non-symlink file');
  }
  let password = readFileSync(resolved, 'utf8');
  if (password.endsWith('\r\n')) password = password.slice(0, -2);
  else if (password.endsWith('\n')) password = password.slice(0, -1);
  if (password.length < 12 || password.length > 512 || /[\r\n\u0000]/u.test(password)) {
    throw new Error('Owner password proof file must contain exactly one non-empty password line');
  }
  return password;
}

function recoveryWebEnvironment(values, context) {
  return {
    ...context.processEnv,
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PORT: '3003',
    HOST: '0.0.0.0',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_API_URL: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    CHARITYPILOT_INTERNAL_API_URL: 'http://api:3002',
  };
}

function containerNetworkAddress(container, context) {
  if (context.dryRun) {
    runCommand(['docker', 'inspect', '--format', '<exact-container-ipv4>', container], context);
    return '172.31.255.10';
  }
  const address = runCommand([
    'docker', 'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container,
  ], context, { capture: true }).trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) {
    throw new Error('Disposable Caddy did not have one exact IPv4 address');
  }
  return address;
}

function runDisposableFullApplicationProof({
  webContainer,
  values,
  ownerEmail = values.PERSONAL_SERVER_OWNER_EMAIL,
  ownerPassword,
  organisationId = null,
  applicationInventory,
  context,
}) {
  if (!ownerPassword) return { ownerLogin: false, sampledDocument: false };
  const sample = organisationId
    ? applicationInventory.documents.find((document) => document.organisationId === organisationId) ?? null
    : applicationInventory.documents[0] ?? null;
  const proofEnvironment = {
    ...context.processEnv,
    CHARITYPILOT_PROBE_ORIGIN: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    CHARITYPILOT_PROBE_OWNER_EMAIL: ownerEmail,
    CHARITYPILOT_PROBE_OWNER_PASSWORD: ownerPassword,
    CHARITYPILOT_PROBE_DOCUMENT_ID: sample?.id ?? '',
    CHARITYPILOT_PROBE_DOCUMENT_SHA256: sample?.sha256 ?? '',
  };
  if (context.dryRun) {
    runCommand([
      'docker', 'exec', webContainer, 'node', '--input-type=module', '-e', '<full-application-login-and-document-proof>',
    ], context, { env: proofEnvironment, secrets: [ownerPassword] });
    return { ownerLogin: true, sampledDocument: Boolean(sample) };
  }
  const output = runCommand([
    'docker', 'exec',
    '-e', 'CHARITYPILOT_PROBE_ORIGIN',
    '-e', 'CHARITYPILOT_PROBE_OWNER_EMAIL',
    '-e', 'CHARITYPILOT_PROBE_OWNER_PASSWORD',
    '-e', 'CHARITYPILOT_PROBE_DOCUMENT_ID',
    '-e', 'CHARITYPILOT_PROBE_DOCUMENT_SHA256',
    webContainer, 'node', '--input-type=module', '-e', DISPOSABLE_FULL_APPLICATION_PROBE_SCRIPT,
  ], context, { capture: true, env: proofEnvironment, secrets: [ownerPassword] });
  const proof = parseAllowlistedJson(output, 'Disposable full-application proof');
  if (
    proof.format !== 'charitypilot-personal-full-application-proof/v1' ||
    proof.ownerLogin !== true || proof.webThroughCaddy !== true ||
    proof.sampledDocument !== Boolean(sample)
  ) {
    throw new Error('Disposable full-application proof returned an unsafe result');
  }
  return proof;
}

function createDisposableProofIdentity({ network, values, image, context }) {
  if (!/^charitypilot-personal-rehearsal-[a-f0-9]{12}$/u.test(network)) {
    throw new Error('Synthetic proof identity requires an exact disposable rehearsal network');
  }
  const email = `restore-proof-${randomHex(12, context.randomBytesImpl)}@example.invalid`;
  const password = generateStrongOneTimePassword(context.randomBytesImpl);
  const databaseUrl = personalDatabaseUrl(values, values.POSTGRES_DB, 'db');
  const command = [
    'docker', 'run', '--rm', '--pull', 'never', '--network', network,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '-e', 'DATABASE_URL', '-e', 'CHARITYPILOT_REHEARSAL_GUARD',
    '-e', 'CHARITYPILOT_PROBE_OWNER_EMAIL', '-e', 'CHARITYPILOT_PROBE_OWNER_PASSWORD',
    image, 'node', '--input-type=module', '-e', DISPOSABLE_PROOF_IDENTITY_SCRIPT,
  ];
  const commandOptions = {
    env: {
      ...context.processEnv,
      DATABASE_URL: databaseUrl,
      CHARITYPILOT_REHEARSAL_GUARD: network,
      CHARITYPILOT_PROBE_OWNER_EMAIL: email,
      CHARITYPILOT_PROBE_OWNER_PASSWORD: password,
    },
    secrets: [databaseUrl, values.POSTGRES_PASSWORD, password],
  };
  if (context.dryRun) {
    runCommand(command, context, commandOptions);
    return { email, password, organisationId: null };
  }
  const output = runCommand(command, context, { ...commandOptions, capture: true });
  const result = parseAllowlistedJson(output, 'Disposable proof identity');
  if (
    result.format !== 'charitypilot-personal-disposable-identity/v1' ||
    typeof result.organisationId !== 'string' || !result.organisationId
  ) throw new Error('Disposable proof identity returned an unsafe result');
  return { email, password, organisationId: result.organisationId };
}

function revokeRestoredSessions(values, image, network, context) {
  const databaseUrl = personalDatabaseUrl(values, values.POSTGRES_DB, 'db');
  if (context.dryRun) {
    runCommand([
      'docker', 'run', '--rm', '--pull', 'never', '--network', network,
      '-e', 'DATABASE_URL', image, 'node', '--input-type=module', '-e', '<revoke-all-restored-sessions>',
    ], context, { env: { ...context.processEnv, DATABASE_URL: databaseUrl }, secrets: [databaseUrl, values.POSTGRES_PASSWORD] });
    return { sessionsRevoked: 0 };
  }
  const output = runCommand([
    'docker', 'run', '--rm', '--pull', 'never', '--network', network,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '-e', 'DATABASE_URL', image, 'node', '--input-type=module', '-e', REVOKE_RESTORED_SESSIONS_SCRIPT,
  ], context, {
    capture: true,
    env: { ...context.processEnv, DATABASE_URL: databaseUrl },
    secrets: [databaseUrl, values.POSTGRES_PASSWORD],
  });
  const result = parseAllowlistedJson(output, 'Restored session revocation');
  if (
    result.format !== 'charitypilot-personal-session-revocation/v1' ||
    !Number.isSafeInteger(result.sessionsRevoked) || result.sessionsRevoked < 0
  ) throw new Error('Restored session revocation returned an unsafe result');
  return result;
}

function applicationDocumentInventory(container, context, secrets = []) {
  if (context.dryRun) {
    runCommand(['docker', 'exec', container, 'node', '--input-type=module', '-e', '<application-document-reconciliation>'], context);
    return { format: 'charitypilot-personal-document-inventory/v1', documents: [] };
  }
  const output = runCommand([
    'docker', 'exec', container, 'node', '--input-type=module', '-e', APPLICATION_DOCUMENT_INVENTORY_SCRIPT,
  ], context, { capture: true, secrets });
  const inventory = parseAllowlistedJson(output, 'Application document reconciliation');
  if (inventory.format !== 'charitypilot-personal-document-inventory/v1' || !Array.isArray(inventory.documents)) {
    throw new Error('Application document reconciliation returned an unsafe result');
  }
  return inventory;
}

function compareApplicationDocuments(applicationInventory, archiveInventory) {
  const archiveByPath = new Map(archiveInventory.files.map((file) => [file.path, file]));
  if (archiveByPath.size !== archiveInventory.files.length) throw new Error('Recovered document archive contains duplicate files');
  const seen = new Set();
  for (const document of applicationInventory.documents) {
    if (
      !document || typeof document !== 'object' ||
      typeof document.id !== 'string' ||
      typeof document.organisationId !== 'string' ||
      typeof document.storagePath !== 'string' ||
      document.storagePath.includes('\\') ||
      !document.storagePath.startsWith(`${document.organisationId}/`) ||
      document.storagePath.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
      !Number.isSafeInteger(document.recordedBytes) || document.recordedBytes < 0 ||
      !Number.isSafeInteger(document.actualBytes) || document.actualBytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(document.sha256 ?? '')
    ) {
      throw new Error('Application document reconciliation returned an invalid document record');
    }
    if (seen.has(document.storagePath)) throw new Error('Multiple database document records reference the same recovered file');
    seen.add(document.storagePath);
    const file = archiveByPath.get(document.storagePath);
    if (
      !file ||
      file.bytes !== document.recordedBytes ||
      file.bytes !== document.actualBytes ||
      file.sha256 !== document.sha256
    ) {
      throw new Error('Recovered document database records and bytes do not match');
    }
  }
  if (seen.size !== archiveByPath.size) {
    throw new Error('Recovered document archive contains files with no matching database record');
  }
  return { documentCount: seen.size, matched: true };
}

function recoveryApiEnvironment(values, databaseHost, context, trustedProxy = '172.30.250.10') {
  return {
    ...context.processEnv,
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PORT: '3002',
    HOST: '0.0.0.0',
    DATABASE_URL: personalDatabaseUrl(values, values.POSTGRES_DB, databaseHost),
    JWT_SECRET: values.JWT_SECRET,
    JWT_EXPIRY: values.JWT_EXPIRY,
    REFRESH_TOKEN_TTL_DAYS: values.REFRESH_TOKEN_TTL_DAYS,
    READINESS_API_KEY: values.READINESS_API_KEY,
    FRONTEND_URL: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    NEXT_PUBLIC_API_URL: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    API_URL: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    CHARITYPILOT_INTERNAL_API_URL: 'http://api:3002',
    TRUSTED_PROXY_ADDRESSES: trustedProxy,
    DOCUMENT_STORAGE_DRIVER: 'local',
    LOCAL_FILE_STORAGE_DIR: '/data/documents',
    ENABLE_IN_PROCESS_JOBS: 'false',
    SELF_REGISTRATION_ENABLED: 'false',
    SEED_LOCAL_ADMIN: 'false',
    SEED_DEMO_WORKSPACE: 'false',
  };
}

const RECOVERY_API_ENV_NAMES = [
  'NODE_ENV', 'CHARITYPILOT_DEPLOYMENT_MODE', 'PORT', 'HOST', 'DATABASE_URL', 'JWT_SECRET',
  'JWT_EXPIRY', 'REFRESH_TOKEN_TTL_DAYS', 'READINESS_API_KEY', 'FRONTEND_URL',
  'NEXT_PUBLIC_API_URL', 'API_URL', 'CHARITYPILOT_INTERNAL_API_URL', 'TRUSTED_PROXY_ADDRESSES',
  'DOCUMENT_STORAGE_DRIVER', 'LOCAL_FILE_STORAGE_DIR', 'ENABLE_IN_PROCESS_JOBS',
  'SELF_REGISTRATION_ENABLED', 'SEED_LOCAL_ADMIN', 'SEED_DEMO_WORKSPACE',
];

function proveRestoredDatabaseContent({ verified, values, host, network, context }) {
  const proofDirectory = context.dryRun
    ? '<temporary-post-restore-proof-directory>'
    : mkdtempSync(join(tmpdir(), 'charitypilot-personal-post-restore-proof-'));
  try {
    const proof = createExactDatabaseProof({
      values,
      recoverySetId: `restored-${randomHex(8, context.randomBytesImpl)}`,
      outputDirectory: proofDirectory,
      context,
      host,
      network,
      dumpFile: 'restored.database.dump',
      reportFile: 'restored.database.proof.json',
    });
    if (
      !context.dryRun &&
      proof.source?.databaseFingerprintSha256 !== verified.databaseProof.source.databaseFingerprintSha256
    ) {
      throw new Error('Restored database content fingerprint does not match the selected recovery set');
    }
  } finally {
    if (!context.dryRun) rmSync(proofDirectory, { recursive: true, force: true });
  }
}

export function executePersonalServerCleanup(operations) {
  if (!Array.isArray(operations) || operations.some((operation) => typeof operation !== 'function')) {
    throw new Error('Disposable recovery cleanup requires an array of exact cleanup operations');
  }
  const errors = [];
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) {
    throw new Error(`Disposable recovery cleanup failed: ${errors.map(({ message }) => message).join('; ')}`);
  }
}

function runDisposableApplicationRehearsal(
  verified,
  values,
  context,
  {
    images = personalImageNames(values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG),
    ownerPassword = null,
  } = {},
) {
  const token = randomHex(6, context.randomBytesImpl);
  const network = `charitypilot-personal-rehearsal-${token}`;
  const databaseVolume = `${network}-db`;
  const documentVolume = `${network}-documents`;
  const databaseContainer = `${network}-postgres`;
  const apiContainer = `${network}-api`;
  const webContainer = `${network}-web`;
  const caddyContainer = `${network}-caddy`;
  const databaseEnv = {
    ...context.processEnv,
    POSTGRES_DB: values.POSTGRES_DB,
    POSTGRES_USER: values.POSTGRES_USER,
    POSTGRES_PASSWORD: values.POSTGRES_PASSWORD,
  };
  const documentsPath = verified.documentsPath ?? '<verified-recovered-documents>';
  let networkCreated = false;
  let databaseVolumeCreated = false;
  let documentVolumeCreated = false;
  let databaseStarted = false;
  let apiStarted = false;
  let webStarted = false;
  let caddyStarted = false;
  let pendingError = null;
  try {
    runCommand(['docker', 'image', 'inspect', POSTGRES_IMAGE], context);
    runCommand(['docker', 'image', 'inspect', DOCUMENT_ARCHIVE_IMAGE], context);
    runCommand(['docker', 'image', 'inspect', images.migrations], context);
    runCommand(['docker', 'image', 'inspect', images.api], context);
    runCommand(['docker', 'image', 'inspect', images.web], context);
    runCommand(['docker', 'image', 'inspect', CADDY_IMAGE], context);
    runCommand(['docker', 'network', 'create', '--internal', '--label', 'charitypilot.personal-rehearsal=true', network], context);
    networkCreated = true;
    runCommand(['docker', 'volume', 'create', '--label', 'charitypilot.personal-rehearsal=true', databaseVolume], context);
    databaseVolumeCreated = true;
    runCommand(['docker', 'volume', 'create', '--label', 'charitypilot.personal-rehearsal=true', documentVolume], context);
    documentVolumeCreated = true;
    runCommand([
      'docker', 'run', '-d', '--name', databaseContainer, '--pull', 'never',
      '--network', network, '--network-alias', 'db', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/var/run/postgresql:rw,noexec,nosuid,size=16m',
      '--mount', `type=volume,src=${databaseVolume},dst=/var/lib/postgresql/data`,
      '-e', 'POSTGRES_DB', '-e', 'POSTGRES_USER', '-e', 'POSTGRES_PASSWORD',
      POSTGRES_IMAGE,
    ], context, { env: databaseEnv, secrets: [values.POSTGRES_PASSWORD] });
    databaseStarted = true;
    waitForRecoveryDatabase(databaseContainer, values, context);
    restoreDatabaseDump(databaseContainer, verified.databasePath ?? '<verified-database-dump>', values, context, { replaceDatabase: false });
    proveRestoredDatabaseContent({ verified, values, host: 'db', network, context });
    populateDocumentVolume(documentVolume, documentsPath, context, { clearExisting: false });

    const migrationDatabaseUrl = personalDatabaseUrl(values, values.POSTGRES_DB, 'db');
    runCommand([
      'docker', 'run', '--rm', '--pull', 'never', '--network', network,
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '-e', 'DATABASE_URL', images.migrations,
    ], context, {
      env: { ...context.processEnv, DATABASE_URL: migrationDatabaseUrl },
      secrets: [migrationDatabaseUrl, values.POSTGRES_PASSWORD],
    });

    const syntheticProofIdentity = createDisposableProofIdentity({
      network,
      values,
      image: images.api,
      context,
    });

    const caddyConfigPath = join(context.repoRoot, 'caddy', 'Caddyfile.personal-server');
    runCommand([
      'docker', 'run', '-d', '--name', caddyContainer, '--pull', 'never',
      '--network', network, '--network-alias', 'caddy', '--read-only',
      '--user', '1000:1000',
      '--tmpfs', '/config:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700',
      '--tmpfs', '/data:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700',
      '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges=true',
      '--mount', `type=bind,src=${caddyConfigPath},dst=/etc/caddy/Caddyfile,readonly`,
      CADDY_IMAGE, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
    ], context);
    caddyStarted = true;
    const caddyAddress = containerNetworkAddress(caddyContainer, context);

    const apiEnv = recoveryApiEnvironment(values, 'db', context, caddyAddress);
    const apiArgs = [
      'docker', 'run', '-d', '--name', apiContainer, '--pull', 'never', '--network', network, '--network-alias', 'api',
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--mount', `type=volume,src=${documentVolume},dst=/data/documents`,
    ];
    for (const name of RECOVERY_API_ENV_NAMES) apiArgs.push('-e', name);
    apiArgs.push(images.api);
    runCommand(apiArgs, context, {
      env: apiEnv,
      secrets: [apiEnv.DATABASE_URL, values.POSTGRES_PASSWORD, values.JWT_SECRET, values.READINESS_API_KEY],
    });
    apiStarted = true;
    waitForRecoveryApi(apiContainer, context);
    const applicationInventory = applicationDocumentInventory(apiContainer, context, [values.JWT_SECRET, values.READINESS_API_KEY]);
    if (!context.dryRun) compareApplicationDocuments(applicationInventory, verified.documentInventory);

    const webEnv = recoveryWebEnvironment(values, context);
    const webArgs = [
      'docker', 'run', '-d', '--name', webContainer, '--pull', 'never', '--network', network, '--network-alias', 'web',
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    ];
    for (const name of [
      'NODE_ENV', 'CHARITYPILOT_DEPLOYMENT_MODE', 'PORT', 'HOST', 'NEXT_TELEMETRY_DISABLED',
      'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE', 'CHARITYPILOT_INTERNAL_API_URL',
    ]) webArgs.push('-e', name);
    webArgs.push(images.web);
    runCommand(webArgs, context, { env: webEnv });
    webStarted = true;
    waitForRecoveryWeb(webContainer, context);
    const syntheticProof = runDisposableFullApplicationProof({
      webContainer,
      values,
      ownerEmail: syntheticProofIdentity.email,
      ownerPassword: syntheticProofIdentity.password,
      organisationId: syntheticProofIdentity.organisationId,
      applicationInventory,
      context,
    });
    const ownerProof = ownerPassword
      ? runDisposableFullApplicationProof({
        webContainer,
        values,
        ownerPassword,
        applicationInventory,
        context,
      })
      : null;
    if (!context.dryRun) {
      const sampled = syntheticProof.sampledDocument
        ? ' one authenticated synthetic-Owner document download matched byte-for-byte.'
        : ' no recovered document existed to sample.';
      const optionalOwner = ownerProof ? ' The supplied real Owner credential also passed without being reset or stored.' : '';
      context.writeOutput(`Disposable full-application restore rehearsal passed through Caddy; documents reconciled: ${applicationInventory.documents.length};${sampled}${optionalOwner}\n`);
    }
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    const cleanup = [];
    if (caddyStarted || context.dryRun) cleanup.push(['docker', 'rm', '-f', caddyContainer]);
    if (webStarted || context.dryRun) cleanup.push(['docker', 'rm', '-f', webContainer]);
    if (apiStarted || context.dryRun) cleanup.push(['docker', 'rm', '-f', apiContainer]);
    if (databaseStarted || context.dryRun) cleanup.push(['docker', 'rm', '-f', databaseContainer]);
    if (documentVolumeCreated || context.dryRun) cleanup.push(['docker', 'volume', 'rm', documentVolume]);
    if (databaseVolumeCreated || context.dryRun) cleanup.push(['docker', 'volume', 'rm', databaseVolume]);
    if (networkCreated || context.dryRun) cleanup.push(['docker', 'network', 'rm', network]);
    try {
      executePersonalServerCleanup(cleanup.map((command) => () => runCommand(command, context)));
    } catch (cleanupError) {
      if (!pendingError) throw cleanupError;
      pendingError.message = `${pendingError.message}\n${cleanupError.message}`;
    }
  }
}

function recoverySetOption(options) {
  if (!options['recovery-set']) throw new Error('--recovery-set is required');
  return resolve(options['recovery-set']);
}

export function personalServerRestoreConfirmation(recoverySetId, sourceOrigin, targetOrigin) {
  const base = `RESTORE-CHARITYPILOT-PERSONAL-SERVER:${recoverySetId}`;
  if (!sourceOrigin || !targetOrigin || sourceOrigin === targetOrigin) return base;
  const binding = createHash('sha256').update(sourceOrigin).update('\0').update(targetOrigin).digest('hex').slice(0, 16);
  return `${base}:REBIND-ORIGIN:${binding}`;
}

function verifySelectedRecoverySet(options, values, context, { materialize }) {
  const targetOrigin = values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN;
  const sourceOrigin = options['source-origin'] === undefined ? targetOrigin : canonicalOrigin(options['source-origin']);
  const verified = verifyPersonalServerRecoverySet({
    recoverySetPath: recoverySetOption(options),
    expectedProject: PROJECT_NAME,
    expectedOrigin: sourceOrigin,
    encryptionKeyFile: encryptionKeyPathOption(options, context),
    extractDocuments: materialize,
    materialize,
  });
  return {
    ...verified,
    originRebind: sourceOrigin === targetOrigin ? null : { sourceOrigin, targetOrigin },
  };
}

function assertPersonalBootstrapResourcesAbsent(context) {
  assertPersonalContainersAbsent(context);
  for (const [kind, name] of [
    ['volume', DATABASE_VOLUME],
    ['volume', DOCUMENT_VOLUME],
    ['network', INTERNAL_NETWORK],
  ]) {
    if (context.dryRun) {
      runCommand(['docker', kind, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'], context);
    } else if (exactDockerResourceExists(kind, name, context)) {
      throw new Error(`Replacement-host restore requires Docker ${kind} ${name} to be absent`);
    }
  }
}

function createPersonalBootstrapTargets(values, context) {
  runCommand([
    ...composePrefix(context), 'create', '--no-build', 'db', 'document-storage-init',
  ], context);
  inspectPersonalVolume(DATABASE_VOLUME, 'personal-server-db', context);
  inspectPersonalVolume(DOCUMENT_VOLUME, 'personal-server-documents', context);
  inspectPersonalNetwork(context);
  const targets = assertPersonalRestoreTargets(context);
  runCommand([...composePrefix(context), 'start', 'db'], context);
  waitForRecoveryDatabase(targets.databaseContainer, values, context);
  const tableCount = runCommand([
    'docker', 'exec', targets.databaseContainer, 'psql', '--username', values.POSTGRES_USER,
    '--dbname', values.POSTGRES_DB, '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
    '--command', "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');",
  ], context, { capture: true, secrets: [values.POSTGRES_PASSWORD] }).trim();
  if (!context.dryRun && tableCount !== '0') {
    throw new Error('Replacement-host database target was not empty before restore');
  }
  runCommand([
    'docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--mount', `type=volume,src=${DOCUMENT_VOLUME},dst=/documents`,
    DOCUMENT_ARCHIVE_IMAGE, 'sh', '-ec', 'test -z "$(find /documents -mindepth 1 -print -quit)"',
  ], context);
  return targets;
}

function cleanupPersonalBootstrapTargets(context) {
  let cleanupError = null;
  try {
    inspectPersonalNetworkIfPresent(context);
    runCommand([...composePrefix(context), 'down', '--remove-orphans'], context);
  } catch (error) {
    cleanupError = error;
  }
  for (const [volumeName, composeVolumeName] of [
    [DATABASE_VOLUME, 'personal-server-db'],
    [DOCUMENT_VOLUME, 'personal-server-documents'],
  ]) {
    try { removePersonalVolumeIfPresent(volumeName, composeVolumeName, context); }
    catch (error) { cleanupError ??= error; }
  }
  try {
    assertPersonalContainersAbsent(context);
    assertDockerResourceAbsent('network', INTERNAL_NETWORK, context);
    assertDockerResourceAbsent('volume', DATABASE_VOLUME, context);
    assertDockerResourceAbsent('volume', DOCUMENT_VOLUME, context);
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

function currentReplacementRestoreSource(context) {
  const identityPath = join(context.repoRoot, 'personal-server-release.json');
  if (existsSync(identityPath)) {
    const identity = parseAllowlistedJson(readFileSync(identityPath, 'utf8'), 'Replacement-host release identity');
    if (
      identity.format !== 'charitypilot-personal-server-bundle/v1' ||
      identity.profile !== 'personal-server' ||
      !/^personal-v\d+\.\d+\.\d+$/u.test(identity.tag ?? '') ||
      !/^[a-f0-9]{40}$/u.test(identity.commitSha ?? '')
    ) throw new Error('Replacement-host release identity is invalid');
    return { releaseIdentity: identity };
  }
  const status = runCommand(['git', 'status', '--porcelain=v1', '--untracked-files=all'], context, { capture: true }).trim();
  const revision = runCommand(['git', 'rev-parse', 'HEAD'], context, { capture: true }).trim();
  if (status || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error('Replacement-host Git source must be clean and bound to one exact commit');
  }
  return { revision };
}

function bootstrapRestorePlan(options, context) {
  const sourceOrigin = canonicalOrigin(options['source-origin']);
  const port = canonicalPort(options.port ?? '8080');
  const targetOrigin = canonicalOrigin(options.origin ?? `http://localhost:${port}`);
  const verified = verifyPersonalServerRecoverySet({
    recoverySetPath: recoverySetOption(options),
    expectedProject: PROJECT_NAME,
    expectedOrigin: sourceOrigin,
    encryptionKeyFile: encryptionKeyPathOption(options, context),
    extractDocuments: false,
    materialize: false,
  });
  const source = currentReplacementRestoreSource(context);
  validateReplacementRestoreSourceBinding(
    verified.manifest.application,
    initialImageTag(context.repoRoot),
    source,
  );
  const plan = {
    format: 'charitypilot-personal-replacement-restore-plan/v1',
    recoverySetId: verified.manifest.recoverySetId,
    recoverySetPath: verified.recoverySetPath,
    sourceOrigin,
    targetOrigin,
    imageTag: verified.manifest.application.imageTag,
    confirmation: personalServerRestoreConfirmation(verified.manifest.recoverySetId, sourceOrigin, targetOrigin),
    secretsRotated: ['POSTGRES_PASSWORD', 'JWT_SECRET', 'AUTH_RECOVERY_SECRET', 'READINESS_API_KEY'],
    priorSessionsWillBeRevoked: true,
  };
  context.writeOutput(`${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function bootstrapRestore(options, context) {
  const installation = readInstallationState(context);
  if (
    !installation || installation.value.installationMode !== 'replacement-restore' ||
    !['restore-prepared', 'replacement-restoring', 'failed'].includes(installation.value.phase) ||
    (installation.value.phase === 'failed' && ![
      'restore-prepared', 'replacement-restoring', 'initialized-backup-pending',
    ].includes(installation.value.failedFromPhase))
  ) {
    throw new Error('Replacement-host restore requires the exact protected installer-prepared state');
  }
  if (!sameSourcePath(installation.value.sourceRoot, context.repoRoot)) {
    throw new Error('Replacement-host restore source root does not match protected installer state');
  }
  const sourceOrigin = canonicalOrigin(options['source-origin']);
  const targetPort = canonicalPort(options.port ?? installation.value.port ?? '8080');
  const targetOrigin = canonicalOrigin(options.origin ?? installation.value.origin ?? `http://localhost:${targetPort}`);
  if (sourceOrigin !== installation.value.restoreOperation?.sourceOrigin || targetOrigin !== installation.value.origin) {
    throw new Error('Replacement-host restore origin binding does not match protected installer state');
  }
  const recoverySetPath = recoverySetOption(options);
  if (!sameSourcePath(recoverySetPath, installation.value.restoreOperation?.recoverySetPath)) {
    throw new Error('Replacement-host recovery set path does not match protected installer state');
  }
  const verified = verifyPersonalServerRecoverySet({
    recoverySetPath,
    expectedProject: PROJECT_NAME,
    expectedOrigin: sourceOrigin,
    encryptionKeyFile: encryptionKeyPathOption(options, context),
    extractDocuments: !context.dryRun,
    materialize: !context.dryRun,
  });
  let resourceCreationAttempted = false;
  try {
    const expectedConfirmation = personalServerRestoreConfirmation(
      verified.manifest.recoverySetId,
      sourceOrigin,
      targetOrigin,
    );
    if (options.confirm !== expectedConfirmation) {
      throw new Error(`--confirm must exactly equal ${expectedConfirmation}`);
    }
    const imageTag = verified.manifest.application.imageTag;
    if (installation.value.activeImageTag !== imageTag) {
      throw new Error('Replacement-host image tag does not match protected installer state');
    }
    assertRetainedSourceIdentity(installation.value.sourceRoot, installation.value.source, context);
    validateReplacementRestoreSourceBinding(verified.manifest.application, imageTag, installation.value.source);

    const envPath = environmentFilePath(context);
    let values;
    if (existsSync(envPath)) {
      values = loadEnvironmentFile(envPath);
      if (
        values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN !== targetOrigin ||
        values.CHARITYPILOT_PERSONAL_SERVER_PORT !== targetPort ||
        values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG !== imageTag
      ) throw new Error('Existing replacement-host environment does not match protected restore state');
    } else {
      const config = environmentForReplacementRestore({ ...options, origin: targetOrigin, port: targetPort }, imageTag, context);
      const content = renderPersonalServerEnv(config);
      values = validateStoredEnvironment(parsePersonalServerEnv(content));
      if (!context.dryRun) writeExclusiveFile(envPath, content);
    }
    validateCompose(context);
    const postCutoverResume = (
      installation.value.phase === 'failed' &&
      installation.value.failedFromPhase === 'initialized-backup-pending'
    );
    if (postCutoverResume) {
      const restoredFrom = installation.value.restoredFrom;
      if (
        restoredFrom?.recoverySetId !== verified.manifest.recoverySetId ||
        !sameSourcePath(restoredFrom?.path, verified.recoverySetPath) ||
        restoredFrom?.sourceOrigin !== sourceOrigin
      ) throw new Error('Post-cutover replacement resume does not match the protected restored recovery set');
      const currentApplication = captureBackupApplicationIdentity(values, context);
      for (const role of ['api', 'migrations', 'web']) {
        if (currentApplication.images[role].id !== restoredFrom.runtimeApplication?.images?.[role]?.id) {
          throw new Error(`Post-cutover replacement resume ${role} image no longer matches protected runtime identity`);
        }
      }
      startRuntime(context);
      const apiContainer = inspectPersonalServiceContainer('api', DOCUMENT_VOLUME, '/data/documents', context);
      const inventory = applicationDocumentInventory(apiContainer, context, [values.JWT_SECRET, values.READINESS_API_KEY]);
      if (!context.dryRun) compareApplicationDocuments(inventory, verified.documentInventory);
      const ownerPassword = readOwnerPasswordProofFile(options);
      if (ownerPassword) verifyBootstrapLogin(values, ownerPassword, context);
      updateInstallationState(context, { phase: 'initialized-backup-pending', failedFromPhase: null });
      context.writeOutput('Replacement-host runtime was already cut over; exact runtime/data identity passed and post-install backup/certification may resume without another restore.\n');
      return;
    }
    updateInstallationState(context, {
      phase: 'replacement-restoring',
      failedFromPhase: null,
      restoreOperation: {
        ...installation.value.restoreOperation,
        recoverySetId: verified.manifest.recoverySetId,
        manifestSha256: context.dryRun ? '<verified-manifest-sha256>' : sha256File(join(recoverySetPath, 'manifest.json')),
        sourceApplication: verified.manifest.application,
        originRebind: sourceOrigin === targetOrigin ? null : { sourceOrigin, targetOrigin },
        secretsRotated: ['POSTGRES_PASSWORD', 'JWT_SECRET', 'READINESS_API_KEY'],
        startedAt: installation.value.restoreOperation?.startedAt ?? context.now().toISOString(),
      },
    });

    preparePinnedRuntimeImages(context);
    buildImagesSequentially(context);
    const ownerPassword = readOwnerPasswordProofFile(options);
    runDisposableApplicationRehearsal(verified, values, context, { ownerPassword });
    assertPersonalBootstrapResourcesAbsent(context);
    resourceCreationAttempted = true;
    const targets = createPersonalBootstrapTargets(values, context);
    restoreDatabaseDump(
      targets.databaseContainer,
      verified.databasePath ?? '<verified-database-dump>',
      values,
      context,
      { replaceDatabase: true },
    );
    proveRestoredDatabaseContent({ verified, values, host: 'db', network: INTERNAL_NETWORK, context });
    runCommand([...composePrefix(context), '--profile', 'maintenance', 'run', '--rm', 'migrate'], context);
    populateDocumentVolume(
      DOCUMENT_VOLUME,
      verified.documentsPath ?? '<verified-recovered-documents>',
      context,
      { clearExisting: true },
    );
    const revoked = revokeRestoredSessions(values, personalImageNames(imageTag).api, INTERNAL_NETWORK, context);
    startRuntime(context);
    const apiContainer = inspectPersonalServiceContainer('api', DOCUMENT_VOLUME, '/data/documents', context);
    const inventory = applicationDocumentInventory(apiContainer, context, [values.JWT_SECRET, values.READINESS_API_KEY]);
    if (!context.dryRun) compareApplicationDocuments(inventory, verified.documentInventory);
    if (ownerPassword) verifyBootstrapLogin(values, ownerPassword, context);
    const runtimeApplication = captureBackupApplicationIdentity(values, context);
    updateInstallationState(context, {
      phase: 'initialized-backup-pending',
      activeImageTag: imageTag,
      restoredFrom: {
        recoverySetId: verified.manifest.recoverySetId,
        path: verified.recoverySetPath,
        sourceOrigin,
        originRebind: sourceOrigin === targetOrigin ? null : { sourceOrigin, targetOrigin },
        authenticatedApplication: verified.manifest.application,
        runtimeApplication,
        sessionsRevoked: revoked.sessionsRevoked,
        restoredAt: context.now().toISOString(),
      },
      restoreOperation: {
        ...installation.value.restoreOperation,
        recoverySetId: verified.manifest.recoverySetId,
        recoverySetPath: verified.recoverySetPath,
        sourceOrigin,
        targetOrigin,
        completedAt: context.now().toISOString(),
      },
    });
    if (context.dryRun) {
      context.writeOutput('DRY RUN: replacement-host restore verified source, rehearsal, blank target, cutover, secret rotation, session revocation, and cleanup plan without creating state or Docker resources.\n');
    } else {
      context.writeOutput(`Replacement-host recovery restored ${verified.manifest.recoverySetId}; old sessions revoked: ${revoked.sessionsRevoked}; documents reconciled: ${inventory.documents.length}.\n`);
    }
  } catch (error) {
    if (resourceCreationAttempted) {
      try { cleanupPersonalBootstrapTargets(context); }
      catch (cleanupError) {
        error.message = `${error.message}\nReplacement-host fail-closed cleanup failed: ${cleanupError.message}. Do not start or alter these resources.`;
      }
    }
    throw error;
  } finally {
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
  }
}

function rehearseRestore(options, context) {
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  const verified = verifySelectedRecoverySet(options, values, context, { materialize: !context.dryRun });
  try {
    runDisposableApplicationRehearsal(verified, values, context, {
      ownerPassword: readOwnerPasswordProofFile(options),
    });
    if (verified.originRebind) {
      context.writeOutput(`Recovery origin rebind rehearsed: ${verified.originRebind.sourceOrigin} -> ${verified.originRebind.targetOrigin}.\n`);
    }
    if (context.dryRun) context.writeOutput('DRY RUN: no recovery containers, networks, volumes, or restored files were created.\n');
  } finally {
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
  }
}

function restore(options, context) {
  const installationState = readInstallationState(context);
  if (!installationState || installationState.value.phase !== 'ready') {
    throw new Error('Restore requires a ready protected installer state');
  }
  const originalInstallationState = JSON.parse(JSON.stringify(installationState.value));
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  const verified = verifySelectedRecoverySet(options, values, context, { materialize: !context.dryRun });
  const expectedConfirmation = personalServerRestoreConfirmation(
    verified.manifest.recoverySetId,
    verified.originRebind?.sourceOrigin,
    verified.originRebind?.targetOrigin,
  );
  if (context.dryRun && options.confirm === undefined) {
    context.writeOutput(`Required restore confirmation: ${expectedConfirmation}\n`);
    context.writeOutput('DRY RUN: confirmation discovery performed no rehearsal, preservation backup, data restore, or state change.\n');
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    return;
  }
  if (options.confirm !== expectedConfirmation) {
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    throw new Error(`--confirm must exactly equal ${expectedConfirmation}`);
  }
  let preservation;
  let preservationVerified;
  let destructiveStarted = false;
  try {
    assertPersonalRestoreTargets(context);
    inspectPersonalNetwork(context);
    runDisposableApplicationRehearsal(verified, values, context);
    if (verified.originRebind) {
      context.writeOutput(`Recovery origin rebind rehearsed: ${verified.originRebind.sourceOrigin} -> ${verified.originRebind.targetOrigin}.\n`);
    }
    preservation = performBackup({
      'output-dir': options['preservation-output-dir'],
      'encryption-key-file': options['encryption-key-file'],
    }, context, { leaveWritersStopped: true });
    if (!context.dryRun) context.writeOutput(`Pre-restore preservation recovery set: ${preservation.backupPath}\n`);
    const encryptionKeyFile = encryptionKeyPathOption(options, context);
    preservationVerified = context.dryRun
      ? dryRunVerifiedRecovery(
        preservation.backupPath,
        values,
        values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG,
        installationState.value.source,
      )
      : verifyPersonalServerRecoverySet({
        recoverySetPath: preservation.backupPath,
        expectedProject: PROJECT_NAME,
        expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
        encryptionKeyFile,
      });
    assertRecoveryApplicationBinding(
      preservationVerified,
      values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG,
      installationState.value.source,
      installationState.value.sourceRoot,
      context,
    );
    const targets = assertPersonalRestoreTargets(context);
    let applicationInventory = { documents: [] };
    executePersonalServerRestoreCutover({
      persistRestoring: () => updateInstallationState(context, {
        phase: 'restoring',
        restoreOperation: {
          selectedRecoverySet: {
            recoverySetId: verified.manifest.recoverySetId,
            path: verified.recoverySetPath,
          },
          preservationRecoverySet: {
            recoverySetId: preservationVerified.manifest.recoverySetId,
            path: preservation.backupPath,
          },
          startedAt: context.now().toISOString(),
        },
      }),
      stopWriters: () => {
        destructiveStarted = true;
        stopAllWritersForDestructiveRecovery(context);
      },
      restoreSelectedDatabase: () => restoreDatabaseDump(
        targets.databaseContainer,
        verified.databasePath ?? '<verified-database-dump>',
        values,
        context,
        { replaceDatabase: true },
      ),
      proveSelectedDatabaseFingerprint: () => proveRestoredDatabaseContent({
        verified,
        values,
        host: 'db',
        network: INTERNAL_NETWORK,
        context,
      }),
      migrateCurrentSchema: () => runCommand([
        ...composePrefix(context), '--profile', 'maintenance', 'run', '--rm', 'migrate',
      ], context),
      restoreSelectedDocuments: () => populateDocumentVolume(
        DOCUMENT_VOLUME,
        verified.documentsPath ?? '<verified-recovered-documents>',
        context,
        { clearExisting: true },
      ),
      startSelectedRuntime: () => startRuntime(context),
      verifySelectedApplication: () => {
        const apiContainer = inspectPersonalServiceContainer('api', DOCUMENT_VOLUME, '/data/documents', context);
        applicationInventory = applicationDocumentInventory(
          apiContainer,
          context,
          [values.JWT_SECRET, values.READINESS_API_KEY],
        );
        if (!context.dryRun) compareApplicationDocuments(applicationInventory, verified.documentInventory);
      },
      persistReady: () => {
        if (context.dryRun) {
          context.writeOutput('DRY RUN: transition protected installation state restoring -> ready after runtime verification.\n');
          return;
        }
        writeInstallationStateExact(context, {
          ...originalInstallationState,
          phase: 'ready',
          lastRestore: {
            completedAt: context.now().toISOString(),
            selectedRecoverySet: {
              recoverySetId: verified.manifest.recoverySetId,
              path: verified.recoverySetPath,
            },
            preservationRecoverySet: {
              recoverySetId: preservationVerified.manifest.recoverySetId,
              path: preservation.backupPath,
            },
            originRebind: verified.originRebind,
          },
          restoreOperation: null,
          updatedAt: context.now().toISOString(),
        });
      },
    });
    if (!context.dryRun) {
      context.writeOutput(`Personal server restored from ${verified.manifest.recoverySetId}; documents reconciled: ${applicationInventory.documents.length}.\n`);
    } else {
      context.writeOutput('DRY RUN: no personal database, document volume, container, network, or recovery-set file was changed.\n');
    }
  } catch (error) {
    if (destructiveStarted && !context.dryRun && preservationVerified) {
      try {
        executePersonalServerCutoverRecovery({
          stopWriters: () => stopAllWritersForDestructiveRecovery(context),
          restoreImageTag: () => {},
          restoreData: () => restoreVerifiedRecoveryIntoRuntime(preservationVerified, values, context),
          startRuntime: () => {
            startRuntime(context);
            const apiContainer = inspectPersonalServiceContainer('api', DOCUMENT_VOLUME, '/data/documents', context);
            const inventory = applicationDocumentInventory(
              apiContainer,
              context,
              [values.JWT_SECRET, values.READINESS_API_KEY],
            );
            compareApplicationDocuments(inventory, preservationVerified.documentInventory);
          },
          restoreInstallationState: () => writeInstallationStateExact(context, originalInstallationState),
        });
        error.message = `${error.message}\nAutomatic restore recovery returned the runtime and exact protected state to the pre-restore recovery set ${preservation.backupPath}.`;
      } catch (recoveryError) {
        let finalStopError = null;
        try { stopAllWritersForDestructiveRecovery(context); }
        catch (stopError) { finalStopError = stopError; }
        error.message = `${error.message}\nAUTOMATIC RESTORE RECOVERY FAILED: ${recoveryError.message}. Protected state remains restoring and writers were stopped; do not start or write data.${finalStopError ? ` Final writer-stop verification failed: ${finalStopError.message}` : ''}`;
      }
    } else if (preservation && !context.dryRun) {
      try {
        startRuntime(context);
      } catch (restartError) {
        error.message = `${error.message}\nPre-destructive restore preparation failed and the original runtime could not be restarted: ${restartError.message}`;
      }
    }
    throw error;
  } finally {
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    cleanupPersonalServerRecoveryStaging(preservationVerified?.stagingDirectory);
  }
}

export function personalServerDecommissionConfirmation(recoverySetId) {
  return `DECOMMISSION-CHARITYPILOT-PERSONAL-SERVER:${recoverySetId}`;
}

export function validatePersonalServerFreshRecovery(manifest, now) {
  const createdAt = manifest?.createdAt;
  const createdAtMs = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
    throw new Error('Decommission recovery set must have a canonical creation timestamp');
  }
  const idMatch = /^personal-server-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)-[a-f0-9]{8}$/u.exec(
    manifest.recoverySetId ?? '',
  );
  const idTimestampMs = idMatch
    ? Date.parse(`${idMatch[1]}:${idMatch[2]}:${idMatch[3]}.${idMatch[4]}`)
    : Number.NaN;
  if (!Number.isFinite(idTimestampMs) || Math.abs(idTimestampMs - createdAtMs) > MAX_RECOVERY_CLOCK_SKEW_MS) {
    throw new Error('Decommission recovery-set ID and creation timestamp do not agree');
  }
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const age = nowMs - createdAtMs;
  if (!Number.isFinite(age) || age < -MAX_RECOVERY_CLOCK_SKEW_MS || age > MAX_DECOMMISSION_RECOVERY_AGE_MS) {
    throw new Error('Decommission requires a verified recovery set created within the last 24 hours');
  }
  return true;
}

function assertDockerResourceAbsent(kind, name, context) {
  const output = runCommand([
    'docker', kind, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}',
  ], context, { capture: true });
  if (!context.dryRun && output.split(/\r?\n/u).some((candidate) => candidate.trim() === name)) {
    throw new Error(`Decommission did not remove Docker ${kind} ${name}`);
  }
}

export function validatePersonalServerContainerAbsence(output) {
  if (typeof output !== 'string') throw new Error('Docker container absence proof must be text');
  if (output.trim()) {
    throw new Error('Decommission did not remove every personal-server Compose project container');
  }
  return true;
}

function assertPersonalContainersAbsent(context) {
  const output = runCommand([
    'docker', 'container', 'ls', '-a',
    '--filter', `label=com.docker.compose.project=${PROJECT_NAME}`,
    '--format', '{{.ID}} {{.Names}}',
  ], context, { capture: true });
  if (!context.dryRun) validatePersonalServerContainerAbsence(output);
}

function exactDockerResourceExists(kind, name, context) {
  const output = runCommand([
    'docker', kind, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}',
  ], context, { capture: true });
  if (context.dryRun) return true;
  return output.split(/\r?\n/u).some((candidate) => candidate.trim() === name);
}

export function removePersonalVolumeIfPresent(volumeName, composeVolumeName, context) {
  if (!exactDockerResourceExists('volume', volumeName, context)) return;
  inspectPersonalVolume(volumeName, composeVolumeName, context);
  runCommand(['docker', 'volume', 'rm', volumeName], context);
}

function inspectPersonalNetworkIfPresent(context) {
  if (!exactDockerResourceExists('network', INTERNAL_NETWORK, context)) return;
  inspectPersonalNetwork(context);
}

export function validateTailscaleServeClosed(serveStatus) {
  if (!serveStatus || typeof serveStatus !== 'object' || Array.isArray(serveStatus)) {
    throw new Error('Tailscale Serve closed status must be an object');
  }
  const allowedKeys = new Set(['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']);
  for (const [key, value] of Object.entries(serveStatus)) {
    if (!allowedKeys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Tailscale Serve closed status contains unexpected configuration');
    }
    if (Object.keys(value).length > 0) {
      throw new Error('Tailscale Serve is not closed');
    }
  }
  return true;
}

function validateTailscaleNodeForOrigin(nodeStatus, origin) {
  const url = new URL(origin);
  const hostname = url.hostname.toLowerCase();
  const dnsName = String(nodeStatus?.Self?.DNSName ?? '').trim().replace(/\.$/u, '').toLowerCase();
  if (
    nodeStatus?.BackendState !== 'Running' || dnsName !== hostname ||
    !hostname.endsWith('.ts.net') || url.protocol !== 'https:' || url.port
  ) {
    throw new Error('Tailscale node identity does not own the configured private origin');
  }
}

function closePrivateTailscaleAccess(values, context) {
  const origin = values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN;
  if (!origin.startsWith('https://')) return;
  const executable = context.processEnv.OS === 'Windows_NT' ? 'tailscale.exe' : 'tailscale';
  if (context.dryRun) {
    runCommand([executable, 'status', '--json'], context);
    runCommand([executable, 'serve', 'status', '--json'], context);
    runCommand([executable, 'serve', 'reset'], context);
    runCommand([executable, 'serve', 'status', '--json'], context);
    return;
  }
  const nodeStatus = parseAllowlistedJson(runCommand([executable, 'status', '--json'], context, { capture: true }), 'Tailscale node status');
  const serveStatus = parseAllowlistedJson(runCommand([executable, 'serve', 'status', '--json'], context, { capture: true }), 'Tailscale Serve status');
  validateTailscaleNodeForOrigin(nodeStatus, origin);
  try {
    validateTailscaleServeClosed(serveStatus);
    return;
  } catch {
    // An active configuration must match the exact private CharityPilot proxy before it can be reset.
  }
  validateTailscalePrivateAccess(
    nodeStatus,
    serveStatus,
    origin,
    Number(values.CHARITYPILOT_PERSONAL_SERVER_PORT),
  );
  runCommand([executable, 'serve', 'reset'], context);
  const closedStatus = parseAllowlistedJson(
    runCommand([executable, 'serve', 'status', '--json'], context, { capture: true }),
    'Tailscale Serve post-reset status',
  );
  validateTailscaleServeClosed(closedStatus);
}

function validateDecommissionRecoveryBinding(binding) {
  if (
    !binding || typeof binding !== 'object' ||
    !isAbsolute(binding.path ?? '') || resolve(binding.path) !== binding.path ||
    basename(binding.path) !== binding.recoverySetId ||
    !/^personal-server-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u.test(binding.recoverySetId ?? '') ||
    !/^[a-f0-9]{64}$/u.test(binding.manifestSha256 ?? '') ||
    typeof binding.createdAt !== 'string' || !Number.isFinite(Date.parse(binding.createdAt))
  ) {
    throw new Error('Protected decommissioning state has an invalid final recovery-set binding');
  }
  return binding;
}

function decommissionRecoveryBinding(recoverySetPath, context) {
  if (context.dryRun && !existsSync(recoverySetPath)) {
    return {
      recoverySetId: basename(recoverySetPath),
      path: resolve(recoverySetPath),
      manifestSha256: '0'.repeat(64),
      createdAt: context.now().toISOString(),
    };
  }
  const manifestPath = join(recoverySetPath, 'manifest.json');
  const manifest = parseAllowlistedJson(readFileSync(manifestPath, 'utf8'), 'Final decommission recovery manifest');
  return validateDecommissionRecoveryBinding({
    recoverySetId: manifest.recoverySetId,
    path: resolve(recoverySetPath),
    manifestSha256: sha256File(manifestPath),
    createdAt: manifest.createdAt,
  });
}

function verifyBoundDecommissionRecovery(binding, values, options, installationState, context) {
  const verified = verifyPersonalServerRecoverySet({
    recoverySetPath: binding.path,
    expectedProject: PROJECT_NAME,
    expectedOrigin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
    encryptionKeyFile: encryptionKeyPathOption(options, context),
    materialize: !context.dryRun,
  });
  try {
    if (
      verified.manifest.recoverySetId !== binding.recoverySetId ||
      verified.manifest.createdAt !== binding.createdAt ||
      sha256File(join(binding.path, 'manifest.json')) !== binding.manifestSha256
    ) {
      throw new Error('Final decommission recovery set no longer matches its protected exact binding');
    }
    assertRecoveryApplicationBinding(
      verified,
      values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG,
      installationState.value.source,
      installationState.value.sourceRoot,
      context,
    );
    return verified;
  } catch (error) {
    cleanupPersonalServerRecoveryStaging(verified.stagingDirectory);
    throw error;
  }
}

function decommission(options, context) {
  const installationState = readInstallationState(context);
  if (!installationState || !['ready', 'decommissioning'].includes(installationState.value.phase)) {
    throw new Error('Decommission requires a ready or resumable decommissioning protected installer state');
  }
  const resuming = installationState.value.phase === 'decommissioning';
  const values = loadEnvironmentFile(environmentFilePath(context));
  validateCompose(context);
  let authorizationVerified;
  let finalVerified;
  let finalBinding;
  let writersMustRemainStopped = resuming;
  let decommissionOperation = resuming ? installationState.value.decommissionOperation : null;
  let decommissioningPersisted = resuming;
  try {
    if (resuming) {
      finalBinding = validateDecommissionRecoveryBinding(
        installationState.value.decommissionOperation?.finalRecoverySet,
      );
      if (!sameSourcePath(recoverySetOption(options), finalBinding.path)) {
        throw new Error(`--recovery-set must exactly equal the protected final recovery set ${finalBinding.path}`);
      }
      const expectedConfirmation = personalServerDecommissionConfirmation(finalBinding.recoverySetId);
      if (options.confirm !== expectedConfirmation) {
        throw new Error(`--confirm must exactly equal ${expectedConfirmation}`);
      }
      context.writeOutput(`Resuming guarded decommission from exact final recovery set ${finalBinding.recoverySetId}.\n`);
    } else {
      authorizationVerified = verifySelectedRecoverySet(options, values, context, { materialize: false });
      validatePersonalServerFreshRecovery(authorizationVerified.manifest, context.now());
      const expectedConfirmation = personalServerDecommissionConfirmation(
        authorizationVerified.manifest.recoverySetId,
      );
      if (options.confirm !== expectedConfirmation) {
        throw new Error(`--confirm must exactly equal ${expectedConfirmation}`);
      }
      inspectPersonalVolume(DATABASE_VOLUME, 'personal-server-db', context);
      inspectPersonalVolume(DOCUMENT_VOLUME, 'personal-server-documents', context);
      inspectPersonalNetwork(context);
      const finalBackup = performBackup({
        'encryption-key-file': options['encryption-key-file'],
      }, context, { leaveWritersStopped: true });
      writersMustRemainStopped = true;
      finalBinding = decommissionRecoveryBinding(finalBackup.backupPath, context);
      if (!context.dryRun) context.writeOutput(`Final pre-decommission recovery set: ${finalBinding.path}\n`);
      decommissionOperation = {
        authorizationRecoverySet: {
          recoverySetId: authorizationVerified.manifest.recoverySetId,
          path: authorizationVerified.recoverySetPath,
        },
        finalRecoverySet: finalBinding,
        startedAt: context.now().toISOString(),
      };
      updateInstallationState(context, {
        phase: 'decommissioning',
        decommissionOperation,
      });
      decommissioningPersisted = !context.dryRun;
    }

    finalVerified = executePersonalServerDecommissionFinalization({
      stopWriters: () => stopAllWritersForDestructiveRecovery(context),
      verifyFinalRecovery: () => {
        if (context.dryRun && !resuming) {
          context.writeOutput('DRY RUN: fully verify the exact generated final recovery set before deletion.\n');
          return dryRunVerifiedRecovery(
            finalBinding.path,
            values,
            values.CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG,
            installationState.value.source,
          );
        }
        const result = verifyBoundDecommissionRecovery(
          finalBinding,
          values,
          options,
          installationState,
          context,
        );
        finalVerified = result;
        if (!resuming) validatePersonalServerFreshRecovery(result.manifest, context.now());
        return result;
      },
      rehearseFinalRecovery: (verified) => runDisposableApplicationRehearsal(
        verified,
        values,
        context,
        {
          images: {
            api: verified.manifest.application.images.api.name,
            migrations: verified.manifest.application.images.migrations.name,
            web: verified.manifest.application.images.web.name,
          },
        },
      ),
      closePrivateAccess: () => closePrivateTailscaleAccess(values, context),
      removeRuntime: () => {
        inspectPersonalNetworkIfPresent(context);
        runCommand([...composePrefix(context), 'down'], context);
      },
      removeDatabaseVolume: () => removePersonalVolumeIfPresent(
        DATABASE_VOLUME,
        'personal-server-db',
        context,
      ),
      removeDocumentVolume: () => removePersonalVolumeIfPresent(
        DOCUMENT_VOLUME,
        'personal-server-documents',
        context,
      ),
      assertResourcesAbsent: () => {
        assertPersonalContainersAbsent(context);
        assertDockerResourceAbsent('network', INTERNAL_NETWORK, context);
        assertDockerResourceAbsent('volume', DATABASE_VOLUME, context);
        assertDockerResourceAbsent('volume', DOCUMENT_VOLUME, context);
      },
      persistDecommissioned: () => {
        if (context.dryRun) {
          context.writeOutput('DRY RUN: transition protected installation state decommissioning -> decommissioned only after absence proofs.\n');
        } else {
          markInstallationDecommissioned(context, finalBinding);
        }
      },
    });

    if (context.dryRun) {
      context.writeOutput('DRY RUN: no containers, network, volumes, source files, configuration, or recovery sets were removed.\n');
    } else {
      context.writeOutput(`Personal server decommissioned after final verified recovery set ${finalBinding.recoverySetId}.\n`);
      context.writeOutput('Application source, .env.personal-server, and all host recovery sets were preserved.\n');
    }
  } catch (error) {
    if (writersMustRemainStopped && !context.dryRun) {
      let stopError = null;
      let stateError = null;
      try { stopAllWritersForDestructiveRecovery(context); }
      catch (writerStopError) { stopError = writerStopError; }
      if (!decommissioningPersisted && finalBinding && decommissionOperation) {
        try {
          updateInstallationState(context, {
            phase: 'decommissioning',
            decommissionOperation,
          });
          decommissioningPersisted = true;
        } catch (persistError) {
          stateError = persistError;
        }
      }
      const resumeConfirmation = finalBinding
        ? personalServerDecommissionConfirmation(finalBinding.recoverySetId)
        : '<final recovery identity unavailable>';
      error.message = `${error.message}\nDecommission remains incomplete and writers were commanded to remain stopped. Resume only with the protected final recovery set ${finalBinding?.path ?? '<unavailable>'} and confirmation ${resumeConfirmation}.${stopError ? ` Writer stop failed: ${stopError.message}` : ''}${stateError ? ` Protected decommissioning state could not be persisted: ${stateError.message}` : ''}`;
    }
    throw error;
  } finally {
    cleanupPersonalServerRecoveryStaging(authorizationVerified?.stagingDirectory);
    cleanupPersonalServerRecoveryStaging(finalVerified?.stagingDirectory);
  }
}

function accountCommand(command, options, context, { deferSecretOutput = false } = {}) {
  const values = loadEnvironmentFile(environmentFilePath(context));
  const email = canonicalEmail(options.email, '--email');
  const childEnv = { ...context.processEnv, PERSONAL_SERVER_ACCOUNT_EMAIL: email };
  let oneTimePassword = null;
  if (command === 'reset-password') {
    oneTimePassword = generateStrongOneTimePassword(context.randomBytesImpl);
    childEnv.PERSONAL_SERVER_ACCOUNT_PASSWORD = oneTimePassword;
  }
  validateCompose(context);
  const envNames = ['-e', 'PERSONAL_SERVER_ACCOUNT_EMAIL'];
  if (oneTimePassword) envNames.push('-e', 'PERSONAL_SERVER_ACCOUNT_PASSWORD');
  const dockerCommand = [
    ...composePrefix(context),
    'run',
    '--rm',
    '--no-deps',
    ...envNames,
    'api',
    'node',
    'dist/jobs/personal-server-account.js',
    command,
  ];
  if (context.dryRun) {
    runCommand(dockerCommand, context, { env: childEnv, secrets: [oneTimePassword] });
    context.writeOutput(`DRY RUN: no ${command === 'reset-link' ? 'bearer URL' : 'password'} was created.\n`);
    return { dryRun: true };
  }

  const stdout = runCommand(dockerCommand, context, {
    capture: true,
    env: childEnv,
    secrets: [oneTimePassword],
  });
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error('Personal-server account command returned an invalid result');
  }
  if (command === 'reset-link') {
    if (result.resetLinkCreated !== true || typeof result.resetUrl !== 'string' || typeof result.expiresAt !== 'string') {
      throw new Error('Personal-server reset-link command returned an invalid result');
    }
    try {
      const resetUrl = new URL(result.resetUrl);
      const expiresAt = Date.parse(result.expiresAt);
      const lifetimeMs = expiresAt - context.now().getTime();
      if (
        resetUrl.origin !== values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN ||
        resetUrl.pathname !== '/reset-password' ||
        resetUrl.search ||
        !/^#token=[A-Za-z0-9_-]{32,}$/u.test(resetUrl.hash) ||
        !Number.isFinite(expiresAt) ||
        lifetimeMs <= 0 ||
        lifetimeMs > 61 * 60 * 1000
      ) {
        throw new Error();
      }
    } catch {
      throw new Error('Personal-server reset-link command returned an unsafe result');
    }
    context.writeOutput('Password reset link created successfully. Treat it as a one-hour bearer secret.\n');
    context.writeOutput(`${result.resetUrl}\n`);
    context.writeOutput(`Expires: ${result.expiresAt}\n`);
    return { resetUrl: result.resetUrl, expiresAt: result.expiresAt };
  }
  if (result.passwordReset !== true || !Number.isSafeInteger(result.sessionsRevoked)) {
    throw new Error('Personal-server reset-password command returned an invalid result');
  }
  if (!deferSecretOutput) {
    context.writeOutput(`Password reset succeeded; revoked sessions: ${result.sessionsRevoked}.\n`);
    context.writeOutput(`Generated replacement password (shown once): ${oneTimePassword}\n`);
  }
  return { oneTimePassword, sessionsRevoked: result.sessionsRevoked };
}

export function runPersonalServer({
  args = process.argv.slice(2),
  processEnv = process.env,
  repoRoot = defaultRepoRoot,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = randomBytes,
  now = () => new Date(),
  writeOutput = (value) => process.stdout.write(value),
  commandTimeoutMs = 30 * 60 * 1000,
} = {}) {
  const parsed = parsePersonalServerArgs(args);
  if (parsed.command === 'help') {
    writeOutput(usage());
    return;
  }
  const context = {
    repoRoot: resolve(repoRoot),
    processEnv,
    spawnSyncImpl,
    randomBytesImpl,
    now,
    writeOutput,
    dryRun: parsed.options.dryRun === true,
    commandTimeoutMs,
  };

  const composePath = join(context.repoRoot, COMPOSE_FILE_NAME);
  if (!existsSync(composePath)) throw new Error(`Missing ${COMPOSE_FILE_NAME}`);
  if (!['init', 'bootstrap-restore-plan', 'bootstrap-restore'].includes(parsed.command) && !existsSync(environmentFilePath(context))) {
    throw new Error('Missing .env.personal-server; run init first');
  }
  const installationState = readInstallationState(context);
  if (
    parsed.command === 'init' && installationState &&
    installationState.value.phase !== 'initializing'
  ) {
    throw new Error(`Personal server init is not permitted from protected installation phase ${installationState.value.phase}`);
  }
  if (installationState?.value.phase === 'decommissioned' && parsed.command !== 'status') {
    throw new Error('Personal server is decommissioned; ordinary lifecycle commands cannot recreate empty data volumes');
  }
  if (installationState?.value.phase === 'updating' && parsed.command !== 'status') {
    throw new Error('Personal server has an interrupted updating state; ordinary lifecycle commands are blocked pending supervised recovery');
  }
  if (installationState?.value.phase === 'restoring' && parsed.command !== 'status') {
    throw new Error('Personal server has an interrupted restoring state; ordinary lifecycle commands are blocked pending supervised recovery');
  }
  if (
    installationState?.value.phase === 'replacement-restoring' &&
    !['status', 'stop', 'bootstrap-restore'].includes(parsed.command)
  ) {
    throw new Error('Personal server has an interrupted replacement-host restore; ordinary lifecycle commands are blocked pending the exact installer resume');
  }
  if (
    installationState?.value.phase === 'failed' &&
    installationState.value.installationMode === 'replacement-restore' &&
    !['status', 'stop', 'bootstrap-restore'].includes(parsed.command)
  ) {
    throw new Error('Failed replacement-host restore permits only status, fail-closed stop, or the exact guarded installer resume');
  }
  if (
    installationState?.value.phase === 'decommissioning' &&
    !['status', 'decommission'].includes(parsed.command)
  ) {
    throw new Error('Personal server is decommissioning; ordinary lifecycle commands are blocked pending guarded decommission resume');
  }

  const handlers = {
    init: initialize,
    'resume-init': resumeInitialization,
    start,
    status,
    stop,
    backup,
    update,
    rollback,
    'bootstrap-restore-plan': bootstrapRestorePlan,
    'bootstrap-restore': bootstrapRestore,
    'rehearse-restore': rehearseRestore,
    restore,
    decommission,
    'reset-link': (options, ctx) => accountCommand('reset-link', options, ctx),
    'reset-password': (options, ctx) => accountCommand('reset-password', options, ctx),
  };
  const lockRequired = !['status', 'bootstrap-restore-plan'].includes(parsed.command);
  const operationLock = lockRequired ? acquireOperationLock(parsed.command, context) : null;
  let operationError;
  try {
    handlers[parsed.command](parsed.options, context);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseOperationLock(operationLock);
      if (context.dryRun && lockRequired) context.writeOutput(`DRY RUN: release exclusive personal-server operation lock for ${parsed.command}.\n`);
    } catch (lockError) {
      if (!operationError) throw lockError;
      operationError.message = `${operationError.message}\nFailed to release personal-server operation lock: ${lockError.message}`;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPersonalServer();
  } catch (error) {
    process.stderr.write(`${redactText(error instanceof Error ? error.message : String(error))}\n`);
    process.stderr.write('Run `node scripts/personal-server.mjs help` for usage.\n');
    process.exitCode = /Unknown (?:command|option)|requires a value|must be/u.test(String(error?.message)) ? 2 : 1;
  }
}
