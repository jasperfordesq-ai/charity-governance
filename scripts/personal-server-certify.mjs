#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeSafeEnvironment,
  pinnedLocalDockerEnvironment,
  validateLocalDockerEndpoint,
  validateLocalDockerRuntime,
} from './personal-server-docker-boundary.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const EXPECTED_SERVICES = ['api', 'caddy', 'db', 'web'];
const EXPECTED_NETWORKS = Object.freeze({
  internal: Object.freeze({
    name: 'charitypilot-personal-server-internal',
    composeName: 'personal-server-internal',
    internal: true,
    subnet: '172.30.250.0/24',
    gateway: '172.30.250.1',
  }),
  edge: Object.freeze({
    name: 'charitypilot-personal-server-edge',
    composeName: 'personal-server-edge',
    internal: false,
    subnet: '172.30.251.0/24',
    gateway: '172.30.251.1',
  }),
});
const EXPECTED_VOLUMES = [
  'charitypilot-personal-server-db',
  'charitypilot-personal-server-documents',
];
const MAX_ENV_BYTES = 64 * 1024;
const CANONICAL_REMOTE = 'https://github.com/jasperfordesq-ai/charity-governance.git';

export function usage() {
  return `CharityPilot personal-server runtime-health attestation

Usage:
  node scripts/personal-server-certify.mjs [--env-file=<path>] [--report-file=<absolute-path>] [--local-only] [--dry-run]

Options:
  --env-file       Personal-server environment file. Default: .env.personal-server.
  --report-file    Write a new redacted runtime-health report under the protected state root; refuses overwrite.
  --local-only     Do not require the configured private HTTPS endpoint/Tailscale check.
                   Valid only when the configured origin is exact loopback HTTP.
  --dry-run        Print the checks without Docker, HTTP, Tailscale, or filesystem writes.
  --help           Show this help.

This command proves the installed runtime boundary and dependency health only. It is not the full
installation/recovery/director-access certification in docs/personal-server-readiness-scorecard.md.
It never prints passwords, private hostnames, database URLs, readiness keys, or container environment.
`;
}

export function parseOptions(argv) {
  const options = {};
  const booleans = new Set(['dry-run', 'local-only', 'help']);
  const values = new Set(['env-file', 'report-file']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const body = token.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    if (!booleans.has(name) && !values.has(name)) throw new Error(`Unknown option --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option --${name}`);
    if (booleans.has(name)) {
      if (equals !== -1) throw new Error(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    const value = equals === -1 ? argv[++index] : body.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
  }
  return options;
}

function parseDotenvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function parseEnvironment(content) {
  const values = {};
  for (const line of content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error('Personal-server environment contains a malformed line');
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate personal-server environment key: ${match[1]}`);
    values[match[1]] = parseDotenvValue(match[2]);
  }
  return values;
}

export function exactLoopbackOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(host) &&
    parsed.origin === origin &&
    parsed.pathname === '/' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash
  );
}

export function validateEnvironment(values, { localOnly = false } = {}) {
  const required = [
    'CHARITYPILOT_PERSONAL_SERVER_ORIGIN',
    'CHARITYPILOT_PERSONAL_SERVER_PORT',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'JWT_SECRET',
    'READINESS_API_KEY',
  ];
  for (const name of required) {
    if (typeof values[name] !== 'string' || !values[name]) throw new Error(`Missing required personal-server value ${name}`);
  }
  const origin = values.CHARITYPILOT_PERSONAL_SERVER_ORIGIN;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Personal-server origin is invalid');
  }
  if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Personal-server origin must be one exact origin without credentials, path, query, fragment, or trailing slash');
  }
  const port = Number(values.CHARITYPILOT_PERSONAL_SERVER_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || String(port) !== values.CHARITYPILOT_PERSONAL_SERVER_PORT) {
    throw new Error('Personal-server port must be an exact integer from 1 to 65535');
  }
  const loopback = exactLoopbackOrigin(origin);
  if (localOnly && !loopback) throw new Error('--local-only is valid only for exact loopback HTTP installations');
  if (parsed.protocol !== 'https:' && !loopback) throw new Error('Personal-server origin must use private HTTPS or exact loopback HTTP');
  if (parsed.protocol === 'https:' && !parsed.hostname.toLowerCase().endsWith('.ts.net')) {
    throw new Error('Runtime-health attestation supports only the exact private Tailscale .ts.net origin');
  }
  const originPort = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (loopback && originPort !== port) {
    throw new Error('Loopback origin port must match CHARITYPILOT_PERSONAL_SERVER_PORT');
  }
  return { origin, port, loopback };
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateTailscalePrivateAccess(nodeStatus, serveStatus, origin, loopbackPort) {
  const url = new URL(origin);
  const hostname = url.hostname.toLowerCase();
  const dnsName = String(nodeStatus?.Self?.DNSName ?? '').trim().replace(/\.$/u, '').toLowerCase();
  if (nodeStatus?.BackendState !== 'Running' || dnsName !== hostname) {
    throw new Error('Tailscale node identity is not running or does not own the configured private hostname');
  }
  if (!hostname.endsWith('.ts.net') || url.protocol !== 'https:' || url.port) {
    throw new Error('Private access must use the exact default-port HTTPS .ts.net node origin');
  }
  if (Object.keys(serveStatus?.AllowFunnel ?? {}).length > 0) {
    throw new Error('Tailscale Funnel is enabled; the personal server must remain tailnet-private');
  }
  if (Object.keys(serveStatus?.Foreground ?? {}).length > 0) {
    throw new Error('Tailscale Serve must use one persistent background configuration');
  }
  if (Object.keys(serveStatus?.Services ?? {}).length > 0) {
    throw new Error('Unexpected Tailscale Services configuration is present on the dedicated host');
  }
  const tcpKeys = Object.keys(serveStatus?.TCP ?? {});
  const tcp443 = serveStatus?.TCP?.['443'];
  if (
    tcpKeys.length !== 1 || tcpKeys[0] !== '443' || tcp443?.HTTPS !== true ||
    tcp443?.HTTP === true || tcp443?.TCPForward
  ) {
    throw new Error('Tailscale Serve must expose exactly one HTTPS listener on private port 443');
  }
  const hostPort = `${hostname}:443`;
  const webKeys = Object.keys(serveStatus?.Web ?? {});
  const handlers = serveStatus?.Web?.[hostPort]?.Handlers;
  if (webKeys.length !== 1 || webKeys[0] !== hostPort || !handlers) {
    throw new Error('Tailscale Serve hostname does not exactly match the configured private origin');
  }
  const handlerKeys = Object.keys(handlers);
  const expectedProxy = `http://127.0.0.1:${loopbackPort}`;
  if (handlerKeys.length !== 1 || handlerKeys[0] !== '/' || handlers['/']?.Proxy !== expectedProxy) {
    throw new Error(`Tailscale Serve must proxy only / to ${expectedProxy}`);
  }
  return { hostnameSha256: sha256Text(hostname), proxyTarget: expectedProxy, funnelDisabled: true };
}

function validatePersonalResponseHeaders(response, label) {
  if (response.headers.get('x-charitypilot-deployment') !== 'personal-server') {
    throw new Error(`${label} did not return the CharityPilot personal-server marker`);
  }
  const robots = response.headers.get('x-robots-tag') ?? '';
  if (!/noindex/u.test(robots) || !/nofollow/u.test(robots)) {
    throw new Error(`${label} is missing the private noindex/nofollow header`);
  }
  if (response.headers.has('server')) throw new Error(`${label} unexpectedly exposes a Server header`);
  const contentSecurityPolicy = response.headers.get('content-security-policy') ?? '';
  if (!contentSecurityPolicy || /fonts\.googleapis\.com|fonts\.gstatic\.com/u.test(contentSecurityPolicy)) {
    throw new Error(`${label} does not have the provider-free content security policy`);
  }
}

export function parseComposePs(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const value = JSON.parse(trimmed);
    if (!Array.isArray(value)) throw new Error('Docker Compose ps JSON must be an array');
    return value;
  }
  return trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizedService(row) {
  return row.Service ?? row.service;
}

function normalizedState(row) {
  return String(row.State ?? row.state ?? '').toLowerCase();
}

function normalizedHealth(row) {
  return String(row.Health ?? row.health ?? '').toLowerCase();
}

function normalizedPublishers(row) {
  return (row.Publishers ?? row.publishers ?? []).filter((publisher) => (
    Number(publisher.PublishedPort ?? publisher.publishedPort) > 0
  ));
}

export function validateComposeRuntime(rows, expectedPort) {
  const byService = new Map();
  for (const row of rows) {
    const service = normalizedService(row);
    if (!EXPECTED_SERVICES.includes(service)) throw new Error(`Unexpected running personal-server service: ${service || '<missing>'}`);
    if (byService.has(service)) throw new Error(`Duplicate running personal-server service: ${service}`);
    byService.set(service, row);
  }
  for (const service of EXPECTED_SERVICES) {
    const row = byService.get(service);
    if (!row) throw new Error(`Missing running personal-server service: ${service}`);
    if (normalizedState(row) !== 'running') throw new Error(`Personal-server service ${service} is not running`);
    if (normalizedHealth(row) !== 'healthy') throw new Error(`Personal-server service ${service} is not healthy`);
    const publishers = normalizedPublishers(row);
    if (service !== 'caddy' && publishers.length > 0) throw new Error(`Personal-server service ${service} unexpectedly publishes a host port`);
    if (service === 'caddy') {
      if (publishers.length !== 1) throw new Error('Caddy must publish exactly one host port');
      const publisher = publishers[0];
      const url = publisher.URL ?? publisher.url;
      const targetPort = Number(publisher.TargetPort ?? publisher.targetPort);
      const publishedPort = Number(publisher.PublishedPort ?? publisher.publishedPort);
      if (url !== '127.0.0.1' || targetPort !== 8080 || publishedPort !== expectedPort) {
        throw new Error('Caddy live port must be exactly 127.0.0.1:<configured-port> -> 8080');
      }
    }
  }
  return EXPECTED_SERVICES.map((service) => ({ service, state: 'running', health: 'healthy' }));
}

export function validatePersonalServerRuntimeNetwork(network, kind) {
  const expected = EXPECTED_NETWORKS[kind];
  if (!expected) throw new Error(`Unknown personal-server network kind: ${kind}`);
  if (
    !network || typeof network !== 'object' || Array.isArray(network) ||
    network.Name !== expected.name ||
    network.Driver !== 'bridge' ||
    network.Internal !== expected.internal ||
    network.Labels?.['com.docker.compose.project'] !== 'charitypilot-personal-server' ||
    network.Labels?.['com.docker.compose.network'] !== expected.composeName ||
    !Array.isArray(network.IPAM?.Config) || network.IPAM.Config.length !== 1 ||
    network.IPAM.Config[0]?.Subnet !== expected.subnet ||
    network.IPAM.Config[0]?.Gateway !== expected.gateway
  ) {
    throw new Error(`Personal-server ${kind} network is not the exact reviewed Compose bridge`);
  }
  if (!network.Containers || typeof network.Containers !== 'object' || Array.isArray(network.Containers)) {
    throw new Error(`Personal-server ${kind} network contains malformed attachment metadata`);
  }
  const attached = Object.values(network.Containers);
  if (attached.some((value) => !value || typeof value !== 'object' || typeof value.Name !== 'string')) {
    throw new Error(`Personal-server ${kind} network contains a malformed attachment`);
  }
  const attachedNames = attached.map((value) => value.Name).sort();
  const expectedNames = kind === 'edge'
    ? ['charitypilot-personal-server-caddy-1']
    : EXPECTED_SERVICES.map((service) => `charitypilot-personal-server-${service}-1`).sort();
  if (
    attachedNames.length !== expectedNames.length ||
    attachedNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Personal-server ${kind} network does not have its exact reviewed service attachments`);
  }
  return { name: expected.name, internal: expected.internal, subnet: expected.subnet };
}

export function validatePersonalServerServiceNetworkAttachments(container, service) {
  if (!EXPECTED_SERVICES.includes(service)) throw new Error(`Unknown personal-server service: ${service}`);
  const expectedContainerName = `charitypilot-personal-server-${service}-1`;
  const actualName = String(container?.Name ?? '').replace(/^\//u, '');
  const networks = container?.NetworkSettings?.Networks;
  const expectedNetworks = service === 'caddy'
    ? [EXPECTED_NETWORKS.edge.name, EXPECTED_NETWORKS.internal.name]
    : [EXPECTED_NETWORKS.internal.name];
  const actualNetworks = networks && typeof networks === 'object' && !Array.isArray(networks)
    ? Object.keys(networks).sort()
    : [];
  if (
    actualName !== expectedContainerName ||
    container?.Config?.Labels?.['com.docker.compose.project'] !== 'charitypilot-personal-server' ||
    container?.Config?.Labels?.['com.docker.compose.service'] !== service ||
    actualNetworks.length !== expectedNetworks.length ||
    actualNetworks.some((name, index) => name !== expectedNetworks[index])
  ) {
    throw new Error(`Personal-server ${service} container does not have its exact reviewed network set`);
  }
  for (const name of actualNetworks) {
    const endpoint = networks[name];
    const expectedGatewayPriority = service === 'caddy' && name === EXPECTED_NETWORKS.edge.name ? 1 : 0;
    if (
      !endpoint || typeof endpoint !== 'object' || typeof endpoint.IPAddress !== 'string' ||
      endpoint.GwPriority !== expectedGatewayPriority
    ) {
      throw new Error(`Personal-server ${service} has a malformed ${name} endpoint`);
    }
    if (name === EXPECTED_NETWORKS.internal.name) {
      if (service === 'caddy' ? endpoint.IPAddress !== '172.30.250.10' : !/^172\.30\.250\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/u.test(endpoint.IPAddress)) {
        throw new Error(`Personal-server ${service} has an unexpected internal IPv4 address`);
      }
    } else if (!/^172\.30\.251\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/u.test(endpoint.IPAddress)) {
      throw new Error('Personal-server Caddy has an unexpected edge IPv4 address');
    }
  }
  return actualNetworks;
}

export function validateBundleIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Personal-server bundle identity must be an object');
  if (value.format !== 'charitypilot-personal-server-bundle/v1' || value.profile !== 'personal-server') {
    throw new Error('Personal-server bundle identity format/profile is invalid');
  }
  if (!/^personal-v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u.test(value.tag)) {
    throw new Error('Personal-server bundle tag is invalid');
  }
  if (!/^[a-f0-9]{40}$/u.test(value.commitSha)) throw new Error('Personal-server bundle commit SHA is invalid');
  if (typeof value.commitTime !== 'string' || !Number.isFinite(Date.parse(value.commitTime))) {
    throw new Error('Personal-server bundle commit time is invalid');
  }
  return {
    kind: 'release-bundle',
    tag: value.tag,
    commitSha: value.commitSha,
    commitTime: value.commitTime,
  };
}

function run(command, args, { cwd, env, dryRun = false, timeout = 30_000 } = {}) {
  if (dryRun) return { stdout: '', command: [command, ...args] };
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed with exit code ${result.status}`);
  }
  return { stdout: result.stdout, command: [command, ...args] };
}

function readEnvironmentFile(path) {
  if (!existsSync(path)) throw new Error(`Personal-server environment file does not exist: ${path}`);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > MAX_ENV_BYTES) {
    throw new Error('Personal-server environment must be a non-empty regular non-symlink file smaller than 64 KiB');
  }
  return parseEnvironment(readFileSync(path, 'utf8'));
}

function parseInspectObject(output, label) {
  const value = JSON.parse(output);
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error(`${label} inspect did not return exactly one object`);
  }
  return value[0];
}

function readBundleIdentity(path) {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 16 * 1024) {
    throw new Error('Personal-server bundle identity must be a small regular non-symlink file');
  }
  return validateBundleIdentity(safeReadJson(readFileSync(path, 'utf8'), 'Personal-server bundle identity'));
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function releaseReceipt(envPath, repoRoot, bundle) {
  const receiptPath = join(dirname(envPath), 'install-state.json');
  if (!existsSync(receiptPath)) throw new Error('Release-bundle installation has no protected installer receipt');
  const status = lstatSync(receiptPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 64 * 1024) {
    throw new Error('Installer receipt must be a small regular non-symlink file');
  }
  const receipt = safeReadJson(readFileSync(receiptPath, 'utf8'), 'Installer receipt');
  const identity = receipt?.source?.releaseIdentity;
  const archive = receipt?.source?.verifiedArchive;
  if (
    receipt?.format !== 'charitypilot-personal-server-install-state/v1' ||
    !['initialized-backup-pending', 'ready'].includes(receipt?.phase) ||
    normalizedPath(receipt?.sourceRoot ?? '') !== normalizedPath(repoRoot) ||
    identity?.format !== 'charitypilot-personal-server-bundle/v1' ||
    identity?.tag !== bundle.tag ||
    identity?.commitSha !== bundle.commitSha ||
    !/^[a-f0-9]{64}$/u.test(archive?.sha256 ?? '') ||
    archive?.file !== `CharityPilot-${bundle.tag}.zip`
  ) {
    throw new Error('Protected installer receipt does not bind this extracted release bundle to its verified archive');
  }
  return { ...bundle, archiveSha256: archive.sha256 };
}

function sourceIdentity(repoRoot, processEnv, envPath) {
  const bundlePath = join(repoRoot, 'personal-server-release.json');
  const bundle = existsSync(bundlePath) ? readBundleIdentity(bundlePath) : undefined;
  const gitPath = join(repoRoot, '.git');
  if (!existsSync(gitPath)) {
    if (!bundle) throw new Error('Installation source has neither a release-bundle identity nor Git identity');
    return releaseReceipt(envPath, repoRoot, bundle);
  }

  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, env: processEnv });
  if (status.stdout.trim()) throw new Error('Installation source worktree is dirty');
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env: processEnv }).stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error('Installation source Git HEAD is invalid');
  const branch = run('git', ['branch', '--show-current'], { cwd: repoRoot, env: processEnv }).stdout.trim();
  if (branch !== 'master') throw new Error('Clean Git installation must use the canonical master branch');
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, env: processEnv }).stdout.trim();
  const normalizedRemote = remote.replace(/\/$/u, '').endsWith('.git')
    ? remote.replace(/\/$/u, '')
    : `${remote.replace(/\/$/u, '')}.git`;
  if (normalizedRemote !== CANONICAL_REMOTE) {
    throw new Error('Clean Git installation does not use the canonical CharityPilot origin remote');
  }
  if (bundle && bundle.commitSha !== head) throw new Error('Release-bundle identity does not match Git HEAD');
  return bundle ?? { kind: 'clean-git', tag: null, commitSha: head, commitTime: null, branch, canonicalRemote: true };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

function safeReadJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function writeExclusiveJson(path, value) {
  if (!isAbsolute(path)) throw new Error('--report-file must be an absolute path');
  const parent = dirname(path);
  const parentStatus = lstatSync(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) throw new Error('Report parent must be a real directory');
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function pathIsWithin(child, parent) {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

export async function certify(options, context = {}) {
  const repoRoot = context.repoRoot ?? defaultRepoRoot;
  const processEnv = context.processEnv ?? process.env;
  const execute = context.runImpl ?? run;
  const fetchRuntime = context.fetchImpl ?? fetchWithTimeout;
  const resolveSourceIdentity = context.sourceIdentityImpl ?? sourceIdentity;
  const now = context.now ?? (() => new Date());
  const dryRun = options['dry-run'] === true;
  const hostPlatform = context.hostPlatform ?? process.platform;
  const envPath = resolve(repoRoot, options['env-file'] ?? processEnv.CHARITYPILOT_PERSONAL_SERVER_ENV_FILE ?? '.env.personal-server');
  if (options['report-file'] && !isAbsolute(options['report-file'])) {
    throw new Error('--report-file must be an absolute path in both dry-run and live modes');
  }
  const protectedStateRoot = dirname(envPath);
  if (options['report-file']) {
    const reportPath = resolve(options['report-file']);
    if (!pathIsWithin(reportPath, protectedStateRoot) || pathIsWithin(protectedStateRoot, repoRoot)) {
      throw new Error('--report-file must stay under the external protected state directory containing the environment file');
    }
  }
  const planned = [];
  if (dryRun) {
    planned.push('validate protected personal-server environment');
    planned.push('verify the local host Docker boundary and Engine API');
    planned.push('docker compose config --quiet and live ps JSON');
    planned.push('inspect exact internal and Caddy-only edge networks plus persistent volumes');
    planned.push('fetch loopback Caddy /login and authenticated readiness');
    planned.push('fetch configured private HTTPS and verify Tailscale Serve when applicable');
    planned.push('write a redacted exclusive runtime-health report under protected state when requested');
    return { format: 'charitypilot-personal-server-runtime-health/v1', dryRun: true, planned };
  }

  const values = readEnvironmentFile(envPath);
  const configuration = validateEnvironment(values, { localOnly: options['local-only'] === true });
  const release = resolveSourceIdentity(repoRoot, processEnv, envPath);
  const dockerContext = execute('docker', [
    'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}|{{.Endpoints.docker.SkipTLSVerify}}',
  ], { cwd: repoRoot, env: processEnv });
  const [dockerEndpoint = '', dockerSkipTlsVerify = ''] = dockerContext.stdout.trim().split('|');
  validateLocalDockerEndpoint({
    endpoint: dockerEndpoint,
    skipTlsVerify: dockerSkipTlsVerify,
    platform: hostPlatform,
  }, processEnv);
  const dockerProbeEnv = pinnedLocalDockerEnvironment(processEnv, dockerEndpoint);
  const dockerInfo = execute('docker', ['info', '--format', '{{.OperatingSystem}}|{{.OSType}}'], {
    cwd: repoRoot, env: dockerProbeEnv,
  });
  const [dockerOperatingSystem = '', dockerServerOs = ''] = dockerInfo.stdout.trim().split('|');
  const dockerVersion = execute('docker', ['version', '--format', '{{.Server.APIVersion}}'], {
    cwd: repoRoot, env: dockerProbeEnv,
  });
  validateLocalDockerRuntime({
    endpoint: dockerEndpoint,
    skipTlsVerify: dockerSkipTlsVerify,
    operatingSystem: dockerOperatingSystem,
    serverOs: dockerServerOs,
    apiVersion: dockerVersion.stdout.trim(),
    platform: hostPlatform,
  }, processEnv);
  const dockerEnv = pinnedLocalDockerEnvironment(processEnv, dockerEndpoint);
  const compose = ['compose', '--project-name', 'charitypilot-personal-server', '--env-file', envPath, '-f', resolve(repoRoot, 'compose.personal-server.yml')];
  const composeEnv = composeSafeEnvironment(dockerEnv);
  execute('docker', [...compose, 'config', '--quiet'], { cwd: repoRoot, env: composeEnv });
  const ps = execute('docker', [...compose, 'ps', '--format', 'json'], { cwd: repoRoot, env: composeEnv });
  const services = validateComposeRuntime(parseComposePs(ps.stdout), configuration.port);

  const networkReports = {};
  for (const kind of ['internal', 'edge']) {
    const expected = EXPECTED_NETWORKS[kind];
    const networkRaw = execute('docker', ['network', 'inspect', expected.name], { cwd: repoRoot, env: dockerEnv });
    const network = parseInspectObject(networkRaw.stdout, `Personal ${kind} network`);
    networkReports[kind] = validatePersonalServerRuntimeNetwork(network, kind);
  }

  const serviceNetworks = {};
  for (const service of EXPECTED_SERVICES) {
    const containerName = `charitypilot-personal-server-${service}-1`;
    const containerRaw = execute('docker', ['inspect', containerName], { cwd: repoRoot, env: dockerEnv });
    const container = parseInspectObject(containerRaw.stdout, `Personal ${service} container`);
    serviceNetworks[service] = validatePersonalServerServiceNetworkAttachments(container, service);
  }

  const volumes = [];
  for (const name of EXPECTED_VOLUMES) {
    const raw = execute('docker', ['volume', 'inspect', name], { cwd: repoRoot, env: dockerEnv });
    const value = parseInspectObject(raw.stdout, `Volume ${name}`);
    if (value.Name !== name || value.Driver !== 'local') throw new Error(`Unexpected personal-server volume identity for ${name}`);
    volumes.push({ name, driver: value.Driver });
  }

  const localBase = `http://127.0.0.1:${configuration.port}`;
  const loginResponse = await fetchRuntime(`${localBase}/login`, { headers: { Accept: 'text/html' } });
  if (loginResponse.status !== 200) throw new Error(`Loopback Caddy login returned HTTP ${loginResponse.status}`);
  validatePersonalResponseHeaders(loginResponse, 'Loopback Caddy login response');

  const readinessResponse = await fetchRuntime(`${localBase}/api/v1/health/readiness`, {
    headers: {
      Accept: 'application/json',
      Origin: configuration.origin,
      'x-charitypilot-readiness-key': values.READINESS_API_KEY,
    },
  });
  const readinessText = await readinessResponse.text();
  if (readinessText.includes(values.READINESS_API_KEY)) throw new Error('Personal readiness response exposed its authentication key');
  const readiness = safeReadJson(readinessText, 'Personal readiness');
  if (readinessResponse.status !== 200 || readiness.status !== 'ready') {
    throw new Error(`Personal readiness is not ready (HTTP ${readinessResponse.status})`);
  }
  if (
    readiness.checks?.database !== true ||
    readiness.checks?.storageConfigured !== true ||
    readiness.checks?.storageBucketReachable !== true
  ) {
    throw new Error('Personal readiness did not prove database and document storage');
  }

  let privateAccess = { required: !configuration.loopback, checked: false };
  if (!configuration.loopback) {
    const node = execute('tailscale', ['status', '--json'], { cwd: repoRoot, env: processEnv });
    const tailscaleNode = safeReadJson(node.stdout, 'Tailscale node status');
    const serve = execute('tailscale', ['serve', 'status', '--json'], { cwd: repoRoot, env: processEnv });
    const tailscaleServe = safeReadJson(serve.stdout, 'Tailscale Serve status');
    const verifiedPrivateAccess = validateTailscalePrivateAccess(
      tailscaleNode,
      tailscaleServe,
      configuration.origin,
      configuration.port,
    );
    const publicResponse = await fetchRuntime(`${configuration.origin}/login`, { headers: { Accept: 'text/html' } });
    if (publicResponse.status !== 200) throw new Error(`Private HTTPS login returned HTTP ${publicResponse.status}`);
    validatePersonalResponseHeaders(publicResponse, 'Private HTTPS login response');
    privateAccess = {
      required: true,
      checked: true,
      httpsStatus: publicResponse.status,
      ...verifiedPrivateAccess,
    };
  }

  const report = {
    format: 'charitypilot-personal-server-runtime-health/v1',
    generatedAt: now().toISOString(),
    result: 'pass',
    scope: 'runtime-boundary-and-dependency-health-only',
    docker: { localDesktop: true, serverOs: 'linux', engineApi: dockerVersion.stdout.trim() },
    release,
    origin: {
      kind: configuration.loopback ? 'loopback-http' : 'tailscale-private-https',
      sha256: sha256Text(configuration.origin),
    },
    loopbackPort: configuration.port,
    services: services.map((service) => ({ ...service, networks: serviceNetworks[service.service] })),
    network: networkReports.internal,
    edgeNetwork: networkReports.edge,
    volumes,
    http: {
      loopbackLoginStatus: loginResponse.status,
      noindex: true,
      serverHeaderRemoved: true,
      providerFreeContentSecurityPolicy: true,
      readinessStatus: readinessResponse.status,
      databaseReady: true,
      storageConfigured: true,
      storageBucketReachable: true,
    },
    privateAccess,
    secretsIncluded: false,
  };
  if (options['report-file']) {
    writeExclusiveJson(resolve(options['report-file']), report);
  }
  return report;
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await certify(options);
    if (result.dryRun) {
      for (const step of result.planned) process.stdout.write(`DRY RUN: ${step}\n`);
      process.stdout.write('DRY RUN: no Docker, HTTP, Tailscale, or report write was performed.\n');
      return;
    }
    process.stdout.write('Personal-server runtime-health attestation passed.\n');
    process.stdout.write(`Origin class: ${result.origin.kind}; loopback port: ${result.loopbackPort}\n`);
    process.stdout.write(`Healthy services: ${result.services.map(({ service }) => service).join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`Personal-server runtime-health attestation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
