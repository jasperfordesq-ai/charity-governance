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
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const ENV_FILE_NAME = '.env.personal-server';
const COMPOSE_FILE_NAME = 'compose.personal-server.yml';
const PROJECT_NAME = 'charitypilot-personal-server';
const DOCUMENT_VOLUME = 'charitypilot-personal-server-documents';
const DOCUMENT_ARCHIVE_IMAGE = 'alpine:3.20';
const REQUIRED_RUNTIME_SERVICES = ['db', 'api', 'web', 'caddy'];
const WRITER_SERVICES = ['caddy', 'web', 'api'];
const BUILD_SERVICES = ['migrate', 'api', 'web'];
const MAX_ENV_BYTES = 64 * 1024;
const DEFAULT_WAIT_SECONDS = 180;

function usage() {
  return `CharityPilot personal-server operator

Usage:
  node scripts/personal-server.mjs init --owner-email=<email> --owner-name=<name> --organisation-name=<name> [--origin=<origin>] [--port=<port>] [--dry-run]
  node scripts/personal-server.mjs start [--dry-run]
  node scripts/personal-server.mjs status [--dry-run]
  node scripts/personal-server.mjs stop [--dry-run]
  node scripts/personal-server.mjs backup [--output-dir=<path>] [--dry-run]
  node scripts/personal-server.mjs update [--output-dir=<path>] [--dry-run]
  node scripts/personal-server.mjs reset-link --email=<canonical-lowercase-email> [--dry-run]
  node scripts/personal-server.mjs reset-password --email=<canonical-lowercase-email> [--dry-run]
  node scripts/personal-server.mjs help

Safety:
  - init never overwrites .env.personal-server and never stores the owner password;
  - start never builds, migrates, or seeds;
  - stop preserves both named data volumes;
  - update requires a verified database-and-document backup before migration;
  - reset-link is preferred; reset-password is an emergency fallback.
`;
}

function optionName(arg) {
  return arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
}

function parseOptions(argv, allowedValueOptions) {
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

    const name = optionName(arg);
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
    start: new Set(),
    status: new Set(),
    stop: new Set(),
    backup: new Set(['--output-dir']),
    update: new Set(['--output-dir']),
    'reset-link': new Set(['--email']),
    'reset-password': new Set(['--email']),
  };
  const allowed = allowedByCommand[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  const options = parseOptions(argv.slice(1), allowed);
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
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const dnsHost = host.split('.').every((label) => (
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ));
    if ((url.protocol === 'http:' && loopback) || (url.protocol === 'https:' && dnsHost && !/^\d+(?:\.\d+){3}$/u.test(host))) {
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
    ['POSTGRES_DB', config.postgresDatabase],
    ['POSTGRES_USER', config.postgresUser],
    ['POSTGRES_PASSWORD', config.postgresPassword],
    ['JWT_SECRET', config.jwtSecret],
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
  for (const name of ['POSTGRES_DB', 'POSTGRES_USER']) {
    if (!/^[a-z][a-z0-9_]{2,62}$/u.test(values[name] ?? '')) throw new Error(`${name} is invalid`);
  }
  if (!/^[A-Fa-f0-9]{64}$/u.test(values.POSTGRES_PASSWORD ?? '')) {
    throw new Error('POSTGRES_PASSWORD must be a 64-character hexadecimal secret');
  }
  for (const name of ['JWT_SECRET', 'READINESS_API_KEY']) {
    if (!values[name] || values[name].length < 32 || /CHANGE_ME|REPLACE_ME/iu.test(values[name])) {
      throw new Error(`${name} must be a configured secret of at least 32 characters`);
    }
  }
  if (values.JWT_SECRET === values.READINESS_API_KEY) throw new Error('JWT_SECRET and READINESS_API_KEY must be distinct');
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

function composePrefix() {
  return ['docker', 'compose', '--env-file', ENV_FILE_NAME, '-f', COMPOSE_FILE_NAME];
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
    postgresDatabase: 'charitypilot_personal_server',
    postgresUser: 'charitypilot_personal_server',
    postgresPassword: randomHex(32, context.randomBytesImpl),
    jwtSecret: `jwt_${randomBase64Url(48, context.randomBytesImpl)}`,
    readinessApiKey: `readiness_${randomBase64Url(48, context.randomBytesImpl)}`,
    ownerEmail,
    ownerName,
    organisationName,
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
  runCommand([...composePrefix(), 'config', '--quiet'], context);
}

function startRuntime(context) {
  runCommand([
    ...composePrefix(),
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    String(DEFAULT_WAIT_SECONDS),
  ], context);
}

function buildImagesSequentially(context) {
  for (const service of BUILD_SERVICES) {
    runCommand([...composePrefix(), '--profile', 'personal-init', 'build', service], context);
  }
}

function initialize(options, context) {
  const envPath = join(context.repoRoot, ENV_FILE_NAME);
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
  const childEnv = { ...context.processEnv, PERSONAL_SERVER_OWNER_PASSWORD: ownerPassword };
  validateCompose(context);
  buildImagesSequentially(context);
  runCommand([...composePrefix(), '--profile', 'maintenance', 'run', '--rm', 'migrate'], context);
  runCommand([
    ...composePrefix(),
    '--profile',
    'personal-init',
    'run',
    '--rm',
    '--no-deps',
    '-e',
    'PERSONAL_SERVER_OWNER_PASSWORD',
    'personal-init',
  ], context, { env: childEnv, secrets: [ownerPassword] });
  startRuntime(context);

  if (!context.dryRun) {
    context.writeOutput('Personal server initialized and healthy.\n');
    context.writeOutput(`Owner email: ${values.PERSONAL_SERVER_OWNER_EMAIL}\n`);
    context.writeOutput(`Generated Owner password (shown once): ${ownerPassword}\n`);
  } else {
    context.writeOutput('DRY RUN: no environment file, data, or password was created.\n');
  }
}

function start(options, context) {
  loadEnvironmentFile(join(context.repoRoot, ENV_FILE_NAME));
  validateCompose(context);
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
  const root = join(context.repoRoot, '.charitypilot-backups', 'personal-server');
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .filter((entry) => existsSync(join(entry.path, 'manifest.json')))
    .sort((left, right) => right.name.localeCompare(left.name))[0] ?? null;
}

function status(options, context) {
  const values = loadEnvironmentFile(join(context.repoRoot, ENV_FILE_NAME));
  validateCompose(context);
  if (context.dryRun) {
    runCommand([...composePrefix(), 'ps', '--format', 'json'], context);
    context.writeOutput(`Configured origin: ${values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN}\n`);
    return;
  }
  const records = parseComposePsJson(runCommand([...composePrefix(), 'ps', '--format', 'json'], context, { capture: true }));
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
  loadEnvironmentFile(join(context.repoRoot, ENV_FILE_NAME));
  runCommand([...composePrefix(), 'stop', ...WRITER_SERVICES, 'db'], context);
  if (!context.dryRun) context.writeOutput('Personal server stopped; data volumes were preserved.\n');
}

function resolveBackupRoot(option, context) {
  const approvedRepositoryRoot = join(context.repoRoot, '.charitypilot-backups', 'personal-server');
  const configured = option ?? approvedRepositoryRoot;
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
    runCommand([...composePrefix(), 'ps', '--status', 'running', '--services'], context);
    return [...REQUIRED_RUNTIME_SERVICES];
  }
  return runCommand([...composePrefix(), 'ps', '--status', 'running', '--services'], context, { capture: true })
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

function dryRunBackup(values, backupRoot, context) {
  const id = safeRecoveryId(context);
  const setDir = join(backupRoot, id);
  const dumpPath = join(setDir, 'database.dump');
  const archivePath = join(setDir, 'documents.tar');
  runningServices(context);
  runCommand([...composePrefix(), 'stop', ...WRITER_SERVICES], context);
  runCommand([...composePrefix(), 'ps', '-q', 'db'], context);
  runCommand([
    process.execPath,
    'scripts/postgres-backup.mjs',
    'backup',
    '--database-container=<db-container-id>',
    `--database-name=${values.POSTGRES_DB}`,
    `--database-user=${values.POSTGRES_USER}`,
    `--output-dir=${setDir}`,
    '--output-file=database.dump',
  ], context);
  runCommand([
    process.execPath,
    'scripts/postgres-backup.mjs',
    'verify-restore',
    `--dump-file=${dumpPath}`,
  ], context);
  runCommand(['docker', 'volume', 'inspect', DOCUMENT_VOLUME], context);
  runCommandToFile(documentArchiveCommand(), archivePath, context);
  runCommand([
    ...composePrefix(),
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    String(DEFAULT_WAIT_SECONDS),
    ...WRITER_SERVICES,
  ], context);
  context.writeOutput('DRY RUN: no recovery-set files were written.\n');
  return { backupPath: setDir, dryRun: true };
}

function performBackup(options, context) {
  const values = loadEnvironmentFile(join(context.repoRoot, ENV_FILE_NAME));
  validateCompose(context);
  const backupRoot = resolveBackupRoot(options['output-dir'], context);
  if (context.dryRun) return dryRunBackup(values, backupRoot, context);

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
        ...composePrefix(),
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
    if (writersBefore.length > 0) runCommand([...composePrefix(), 'stop', ...writersBefore], context);

    const databaseContainer = verifyContainerId(
      runCommand([...composePrefix(), 'ps', '-q', 'db'], context, { capture: true }),
    );
    runCommand([
      process.execPath,
      'scripts/postgres-backup.mjs',
      'backup',
      `--database-container=${databaseContainer}`,
      `--database-name=${values.POSTGRES_DB}`,
      `--database-user=${values.POSTGRES_USER}`,
      `--output-dir=${incompleteDir}`,
      '--output-file=database.dump',
    ], context);
    if (!existsSync(dumpPath) || statSync(dumpPath).size <= 0) throw new Error('Database backup artifact is missing or empty');
    runCommand([
      process.execPath,
      'scripts/postgres-backup.mjs',
      'verify-restore',
      `--dump-file=${dumpPath}`,
    ], context);

    runCommand(['docker', 'volume', 'inspect', DOCUMENT_VOLUME], context, { capture: true });
    runCommandToFile(documentArchiveCommand(), archivePath, context);

    const manifest = {
      format: 'charitypilot-personal-server-backup/v1',
      recoverySetId: id,
      createdAt: context.now().toISOString(),
      project: PROJECT_NAME,
      origin: values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN,
      database: {
        file: 'database.dump',
        bytes: statSync(dumpPath).size,
        sha256: sha256File(dumpPath),
        restoreVerified: true,
      },
      documents: {
        volume: DOCUMENT_VOLUME,
        file: 'documents.tar',
        bytes: statSync(archivePath).size,
        sha256: sha256File(archivePath),
      },
      writersQuiesced: true,
    };
    const manifestPath = join(incompleteDir, 'manifest.json');
    writeExclusiveFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeExclusiveFile(join(incompleteDir, 'manifest.sha256'), `${sha256File(manifestPath)}  manifest.json\n`);
    renameSync(incompleteDir, finalDir);
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      if (writersBefore.length > 0) {
        runCommand([
          ...composePrefix(),
          'up',
          '-d',
          '--no-build',
          '--wait',
          '--wait-timeout',
          String(DEFAULT_WAIT_SECONDS),
          ...writersBefore,
        ], context);
      }
      if (databaseStartedForBackup) runCommand([...composePrefix(), 'stop', 'db'], context);
    } catch (restoreError) {
      if (!pendingError) throw restoreError;
      pendingError.message = `${pendingError.message}\nFailed to restore the pre-backup service state: ${restoreError.message}`;
    }
    if (pendingError && existsSync(incompleteDir)) rmSync(incompleteDir, { recursive: true, force: true });
  }
  context.writeOutput(`Verified recovery set: ${finalDir}\n`);
  return { backupPath: finalDir, dryRun: false };
}

function backup(options, context) {
  performBackup(options, context);
}

function update(options, context) {
  const recovery = performBackup(options, context);
  buildImagesSequentially(context);
  runCommand([...composePrefix(), 'stop', ...WRITER_SERVICES], context);
  runCommand([...composePrefix(), '--profile', 'maintenance', 'run', '--rm', 'migrate'], context);
  startRuntime(context);
  if (!context.dryRun) context.writeOutput(`Personal server updated. Pre-update recovery set: ${recovery.backupPath}\n`);
}

function accountCommand(command, options, context) {
  const values = loadEnvironmentFile(join(context.repoRoot, ENV_FILE_NAME));
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
    ...composePrefix(),
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
    return;
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
    return;
  }
  if (result.passwordReset !== true || !Number.isSafeInteger(result.sessionsRevoked)) {
    throw new Error('Personal-server reset-password command returned an invalid result');
  }
  context.writeOutput(`Password reset succeeded; revoked sessions: ${result.sessionsRevoked}.\n`);
  context.writeOutput(`Generated replacement password (shown once): ${oneTimePassword}\n`);
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
  if (parsed.command !== 'init' && !existsSync(join(context.repoRoot, ENV_FILE_NAME))) {
    throw new Error('Missing .env.personal-server; run init first');
  }

  const handlers = {
    init: initialize,
    start,
    status,
    stop,
    backup,
    update,
    'reset-link': (options, ctx) => accountCommand('reset-link', options, ctx),
    'reset-password': (options, ctx) => accountCommand('reset-password', options, ctx),
  };
  handlers[parsed.command](parsed.options, context);
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
