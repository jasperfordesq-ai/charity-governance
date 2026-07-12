#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statfsSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptsDirectory, '..');
const PREFLIGHT_FORMAT = 'charitypilot-personal-server-preflight/v1';
const PERSONAL_PROJECT = 'charitypilot-personal-server';
const PERSONAL_NETWORK = 'charitypilot-personal-server-internal';
const PERSONAL_SUBNET = '172.30.250.0/24';
const MINIMUM_FREE_GIB = 20;
const MINIMUM_FREE_BYTES = MINIMUM_FREE_GIB * 1024 ** 3;
const CANONICAL_REMOTE = 'https://github.com/jasperfordesq-ai/charity-governance.git';
const RELEASE_IDENTITY_FILE = 'personal-server-release.json';
const REQUIRED_REPOSITORY_FILES = [
  'package.json',
  'package-lock.json',
  'compose.personal-server.yml',
  'caddy/Caddyfile.personal-server',
  'scripts/personal-server.mjs',
];

function usage() {
  return `CharityPilot personal-server Windows preflight

Usage:
  node scripts/personal-server-preflight.mjs [--origin=<origin>] [--port=<port>] [--state-root=<absolute-path>] [--replacement-restore|--resume-failed] [--dry-run] [--json]

The preflight is read-only. It requires canonical clean Git master or an
official versioned CharityPilot release bundle, verifies the Windows/Docker toolchain, and refuses an
existing personal-server installation. It never creates the state directory,
.env.personal-server, containers, networks, volumes, images, or accounts.
`;
}

export function parsePreflightOptions(argv) {
  const options = { json: false, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json' || arg === '--dry-run' || arg === '--resume-failed' || arg === '--replacement-restore') {
      if (seen.has(arg)) throw new Error(`${arg} may be provided only once`);
      seen.add(arg);
      if (arg === '--json') options.json = true;
      if (arg === '--dry-run') options.dryRun = true;
      if (arg === '--resume-failed') options.resumeFailed = true;
      if (arg === '--replacement-restore') options.replacementRestore = true;
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!['--origin', '--port', '--state-root'].includes(name)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (seen.has(name)) throw new Error(`${name} may be provided only once`);
    seen.add(name);
    let value = equals >= 0 ? arg.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    options[name.slice(2).replaceAll('-', '')] = value;
  }
  if (options.resumeFailed && options.replacementRestore) {
    throw new Error('--resume-failed and --replacement-restore are mutually exclusive');
  }
  return options;
}

function defaultStateRoot(environment = process.env) {
  const localApplicationData = environment.LOCALAPPDATA?.trim();
  const base = localApplicationData || join(homedir(), 'AppData', 'Local');
  return resolve(base, 'CharityPilot', 'personal-server');
}

function canonicalPort(value) {
  if (!/^[1-9]\d{0,4}$/u.test(String(value))) {
    throw new Error('port must be an integer from 1 to 65535');
  }
  const port = Number(value);
  if (port > 65535) throw new Error('port must be an integer from 1 to 65535');
  return port;
}

export function canonicalInstallOrigin(value, port) {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value) throw new Error();
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1';
    if (parsed.protocol === 'http:' && loopback) {
      if (Number(parsed.port || 80) !== port) throw new Error();
      return parsed.origin;
    }
    if (
      parsed.protocol === 'https:' &&
      parsed.port === '' &&
      hostname.endsWith('.ts.net')
    ) {
      return parsed.origin;
    }
  } catch {
    // Emit one value-free error below.
  }
  throw new Error('origin must be exact default-port HTTPS on this Tailscale .ts.net node or exact IPv4 loopback HTTP using the selected port');
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/u.exec(String(value).trim().replace(/^v/u, ''));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesNodeEngine(version, range) {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(String(range).trim());
  if (!match) return false;
  const comparison = compareVersions(version, match[1]);
  return comparison !== null && comparison >= 0;
}

function ipv4ToInteger(address) {
  const octets = String(address).split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) {
    return null;
  }
  return octets.reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0);
}

function parseIpv4Cidr(value) {
  const [address, prefixText] = String(value).split('/');
  const prefix = Number(prefixText);
  const integer = ipv4ToInteger(address);
  if (integer === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (integer & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { start, end: start + size - 1 };
}

export function cidrOverlaps(left, right) {
  const a = parseIpv4Cidr(left);
  const b = parseIpv4Cidr(right);
  if (!a || !b) return false;
  return a.start <= b.end && b.start <= a.end;
}

function normalizedOutput(value) {
  return String(value ?? '').replaceAll('\u0000', '').trim();
}

function defaultExecute(command, args, { cwd = defaultRepositoryRoot, timeout = 15_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    stdio: 'pipe',
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: normalizedOutput(result.stdout),
    stderr: normalizedOutput(result.stderr || result.error?.message),
  };
}

function nearestExistingDirectory(path) {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  const status = lstatSync(candidate);
  return status.isDirectory() ? candidate : dirname(candidate);
}

function defaultDiskFreeBytes(path) {
  const stats = statfsSync(nearestExistingDirectory(path));
  return Number(stats.bavail) * Number(stats.bsize);
}

function defaultCanBindPort(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sourceArchiveFingerprint(repositoryRoot) {
  const hash = createHash('sha256');
  for (const file of [...REQUIRED_REPOSITORY_FILES, RELEASE_IDENTITY_FILE]) {
    hash.update(`${file}\0`, 'utf8');
    hash.update(readFileSync(join(repositoryRoot, file)));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function readReleaseBundleIdentity(repositoryRoot) {
  const path = join(repositoryRoot, RELEASE_IDENTITY_FILE);
  if (!existsSync(path)) throw new Error('missing release identity');
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 16 * 1024) {
    throw new Error('invalid release identity file');
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    value?.format !== 'charitypilot-personal-server-bundle/v1' ||
    value?.profile !== 'personal-server' ||
    !/^personal-v\d+\.\d+\.\d+$/u.test(value?.tag ?? '') ||
    !/^[a-f0-9]{40}$/u.test(value?.commitSha ?? '') ||
    typeof value?.commitTime !== 'string' ||
    new Date(value.commitTime).toISOString() !== value.commitTime
  ) {
    throw new Error('invalid release identity values');
  }
  return value;
}

function addCheck(checks, id, passed, summary, remediation = null, details = undefined) {
  checks.push({
    id,
    status: passed ? 'passed' : 'failed',
    summary,
    ...(remediation ? { remediation } : {}),
    ...(details === undefined ? {} : { details }),
  });
}

function addWarning(warnings, id, summary, remediation = null) {
  warnings.push({ id, summary, ...(remediation ? { remediation } : {}) });
}

function inspectSource(repositoryRoot, execute, checks) {
  if (existsSync(join(repositoryRoot, '.git'))) {
    const top = execute('git', ['rev-parse', '--show-toplevel'], { cwd: repositoryRoot });
    const head = execute('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
    const status = execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot });
    const branch = execute('git', ['branch', '--show-current'], { cwd: repositoryRoot });
    const remote = execute('git', ['remote', 'get-url', 'origin'], { cwd: repositoryRoot });
    const originMaster = execute(
      'git',
      ['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}'],
      { cwd: repositoryRoot },
    );
    const correctRoot = top.status === 0 && resolve(top.stdout) === repositoryRoot;
    addCheck(
      checks,
      'source.git-root',
      correctRoot,
      correctRoot ? 'Git repository root matches this installer.' : 'The installer is not running at the Git repository root.',
      'Open PowerShell in the top-level CharityPilot folder and run the installer again.',
    );
    const revisionValid = head.status === 0 && /^[0-9a-f]{40}$/u.test(head.stdout);
    addCheck(
      checks,
      'source.revision',
      revisionValid,
      revisionValid ? `Git revision recorded: ${head.stdout}.` : 'Git could not identify an exact 40-character revision.',
      'Use a complete clean clone or an extracted GitHub source archive.',
    );
    const clean = status.status === 0 && status.stdout === '';
    addCheck(
      checks,
      'source.clean',
      clean,
      clean ? 'Git checkout is clean.' : 'Git checkout contains modified or untracked files.',
      'Do not install from a development worktree. Commit/preserve your work, then use a fresh clean clone or release archive.',
    );
    const exactBranch = branch.status === 0 && branch.stdout === 'master';
    addCheck(
      checks,
      'source.branch',
      exactBranch,
      exactBranch ? 'Git source is on canonical master.' : 'Git source is not on canonical master.',
      'Use an official release bundle or a fresh clone of canonical master; forks and detached/development branches are unsupported for installation.',
    );
    const normalizedRemote = remote.status === 0
      ? `${remote.stdout.trim().replace(/\/$/u, '').replace(/\.git$/u, '')}.git`
      : '';
    const canonicalRemote = normalizedRemote === CANONICAL_REMOTE;
    addCheck(
      checks,
      'source.canonical-remote',
      canonicalRemote,
      canonicalRemote ? 'Git origin is the canonical CharityPilot repository.' : 'Git origin is missing or is not the canonical CharityPilot repository.',
      'Clone https://github.com/jasperfordesq-ai/charity-governance.git directly. Never install from a credential-bearing remote URL or an unreviewed fork.',
    );
    const originMasterValid = originMaster.status === 0 && /^[0-9a-f]{40}$/u.test(originMaster.stdout);
    const canonicalTrackingRef = revisionValid && originMasterValid && originMaster.stdout === head.stdout;
    addCheck(
      checks,
      'source.origin-master',
      canonicalTrackingRef,
      canonicalTrackingRef
        ? 'Git HEAD exactly matches the already-fetched canonical origin/master commit.'
        : 'Git HEAD does not exactly match the already-fetched origin/master commit.',
      'Use a fresh clone of canonical master. The installer will not fetch or modify Git refs during preflight.',
    );
    return {
      kind: 'git',
      revision: revisionValid ? head.stdout : null,
      branch: branch.status === 0 && branch.stdout ? branch.stdout : 'detached',
      canonicalRemote,
      canonicalTrackingRef,
      originMasterRevision: originMasterValid ? originMaster.stdout : null,
      clean,
    };
  }

  try {
    const releaseIdentity = readReleaseBundleIdentity(repositoryRoot);
    const fingerprint = sourceArchiveFingerprint(repositoryRoot);
    addCheck(
      checks,
      'source.archive',
      true,
      `Official release identity ${releaseIdentity.tag} (${releaseIdentity.commitSha}) is present.`,
      null,
    );
    return { kind: 'release-bundle', fingerprint, releaseIdentity, clean: true };
  } catch {
    addCheck(
      checks,
      'source.archive',
      false,
      'Source is not a valid official versioned CharityPilot release bundle.',
      'Download the named CharityPilot-<personal-vX.Y.Z>.zip asset from canonical GitHub Releases. Do not use Code > Download ZIP.',
    );
    return { kind: 'release-bundle', fingerprint: null, releaseIdentity: null, clean: false };
  }
}

function detectWsl2(execute, repositoryRoot) {
  const status = execute('wsl.exe', ['--status'], { cwd: repositoryRoot });
  const listing = execute('wsl.exe', ['--list', '--verbose'], { cwd: repositoryRoot });
  const combined = `${status.stdout}\n${listing.stdout}`;
  const defaultVersionTwo = /default\s+version\s*:\s*2/iu.test(combined);
  const versionTwoDistribution = /(?:^|\n)\s*\*?\s*\S+\s+(?:running|stopped)\s+2\s*(?:\n|$)/iu.test(combined);
  return {
    available: status.status === 0 || listing.status === 0,
    versionTwo: defaultVersionTwo || versionTwoDistribution,
    summary: normalizedOutput(combined).replace(/\s+/gu, ' ').slice(0, 300),
  };
}

function inspectDockerNetworks(execute, repositoryRoot) {
  const list = execute('docker', ['network', 'ls', '--quiet'], { cwd: repositoryRoot });
  if (list.status !== 0) return { error: list.stderr || 'docker network ls failed', overlaps: [] };
  const ids = list.stdout.split(/\s+/u).filter(Boolean);
  if (ids.length === 0) return { overlaps: [] };
  const inspect = execute('docker', ['network', 'inspect', ...ids], { cwd: repositoryRoot });
  if (inspect.status !== 0) return { error: inspect.stderr || 'docker network inspect failed', overlaps: [] };
  try {
    const networks = JSON.parse(inspect.stdout);
    const overlaps = [];
    for (const network of networks) {
      for (const config of network?.IPAM?.Config ?? []) {
        if (
          typeof config?.Subnet === 'string' &&
          cidrOverlaps(PERSONAL_SUBNET, config.Subnet) &&
          !(network.Name === PERSONAL_NETWORK && config.Subnet === PERSONAL_SUBNET)
        ) {
          overlaps.push({ name: network.Name, subnet: config.Subnet });
        }
      }
    }
    return { overlaps };
  } catch {
    return { error: 'Docker returned invalid network inspection JSON.', overlaps: [] };
  }
}

function inspectExistingResources(execute, repositoryRoot) {
  const commands = [
    ['containers', ['ps', '-a', '--filter', `label=com.docker.compose.project=${PERSONAL_PROJECT}`, '--format', '{{.Names}}']],
    ['volumes', ['volume', 'ls', '--filter', `name=${PERSONAL_PROJECT}`, '--format', '{{.Name}}']],
    ['networks', ['network', 'ls', '--filter', `name=${PERSONAL_PROJECT}`, '--format', '{{.Name}}']],
  ];
  const found = {};
  for (const [kind, args] of commands) {
    const result = execute('docker', args, { cwd: repositoryRoot });
    if (result.status !== 0) return { error: result.stderr || `Could not inspect Docker ${kind}.`, found };
    found[kind] = result.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  }
  return { found };
}

export function classifyTailscaleServeConfiguration(value, hostname, loopbackPort) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const populated = Object.entries(value).filter(([, item]) => item && typeof item === 'object' && Object.keys(item).length > 0);
  if (populated.length === 0) return 'empty';
  if (Object.keys(value.AllowFunnel ?? {}).length || Object.keys(value.Foreground ?? {}).length || Object.keys(value.Services ?? {}).length) {
    return 'invalid';
  }
  const tcpKeys = Object.keys(value.TCP ?? {});
  const tcp443 = value.TCP?.['443'];
  const hostPort = `${hostname}:443`;
  const webKeys = Object.keys(value.Web ?? {});
  const handlers = value.Web?.[hostPort]?.Handlers;
  if (
    tcpKeys.length !== 1 || tcpKeys[0] !== '443' || tcp443?.HTTPS !== true || tcp443?.HTTP === true || tcp443?.TCPForward ||
    webKeys.length !== 1 || webKeys[0] !== hostPort ||
    !handlers || Object.keys(handlers).length !== 1 || handlers['/']?.Proxy !== `http://127.0.0.1:${loopbackPort}`
  ) return 'invalid';
  return 'exact';
}

function inspectTailnetOrigin(origin, execute, repositoryRoot, checks, warnings, platform, loopbackPort) {
  const parsed = new URL(origin);
  if (!parsed.hostname.toLowerCase().endsWith('.ts.net')) {
    if (parsed.protocol === 'https:') {
      addCheck(checks, 'access.private-origin', false, 'Only the exact Tailscale .ts.net private HTTPS origin is supported.', 'Use this host Tailscale Self.DNSName or exact loopback HTTP.');
    }
    return;
  }
  const command = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const result = execute(command, ['status', '--json'], { cwd: repositoryRoot });
  let valid = false;
  let summary = 'Tailscale is missing, disconnected, or returned invalid status.';
  if (result.status === 0) {
    try {
      const status = JSON.parse(result.stdout);
      const dnsName = String(status?.Self?.DNSName ?? '').replace(/\.$/u, '').toLowerCase();
      const online = status?.Self?.Online === true || status?.BackendState === 'Running';
      valid = online && dnsName === parsed.hostname.toLowerCase();
      summary = valid
        ? `Tailscale is online and owns ${dnsName}.`
        : 'Tailscale status does not match the selected HTTPS hostname.';
    } catch {
      // Keep the safe summary above.
    }
  }
  addCheck(
    checks,
    'access.tailscale',
    valid,
    summary,
    'Install/sign in to Tailscale on this host, derive the exact Self.DNSName, and rerun preflight before initialization.',
  );
  if (!valid) return;

  const serveResult = execute(command, ['serve', 'status', '--json'], { cwd: repositoryRoot });
  let serveMode = 'invalid';
  if (serveResult.status === 0) {
    try {
      const text = serveResult.stdout.trim();
      serveMode = classifyTailscaleServeConfiguration(text ? JSON.parse(text) : {}, parsed.hostname.toLowerCase(), loopbackPort);
    } catch {
      // Keep fail-closed invalid mode.
    }
  }
  const serveSafe = serveMode === 'empty' || serveMode === 'exact';
  addCheck(
    checks,
    'access.tailscale-serve-safe',
    serveSafe,
    serveMode === 'empty'
      ? 'Tailscale Serve has no existing configuration; the installer can create the exact private proxy safely.'
      : serveMode === 'exact'
        ? 'Tailscale Serve already has the exact private CharityPilot proxy.'
        : 'Tailscale Serve contains an unreadable, public, or unrelated configuration.',
    'Use a dedicated Tailscale host. Review existing Serve/Funnel configuration before resetting it; the installer will not overwrite unrelated services.',
    { mode: serveMode },
  );
}

export async function runPersonalServerPreflight(options = {}, dependencies = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? dependencies.repositoryRoot ?? defaultRepositoryRoot);
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const execute = dependencies.execute ?? defaultExecute;
  const diskFreeBytes = dependencies.diskFreeBytes ?? defaultDiskFreeBytes;
  const canBindPort = dependencies.canBindPort ?? defaultCanBindPort;
  const now = dependencies.now ?? (() => new Date());
  const checks = [];
  const warnings = [];
  const resumeFailed = options.resumeFailed === true;
  const replacementRestore = options.replacementRestore === true;
  let port = 8080;
  let origin = 'http://localhost:8080';
  const requestedStateRoot = options.stateRoot ?? defaultStateRoot(environment);
  let stateRoot = resolve(requestedStateRoot);

  try {
    port = canonicalPort(options.port ?? 8080);
    origin = canonicalInstallOrigin(options.origin ?? `http://localhost:${port}`, port);
  } catch (error) {
    addCheck(checks, 'configuration.origin-port', false, error.message, 'Use an exact private HTTPS DNS origin, or http://localhost:<selected-port>.');
  }

  const requiredFilesPresent = REQUIRED_REPOSITORY_FILES.every((file) => existsSync(join(repositoryRoot, file)));
  addCheck(
    checks,
    'source.layout',
    requiredFilesPresent,
    requiredFilesPresent ? 'Required installation files are present.' : 'Required installation files are missing.',
    'Use a complete clean clone or extract the complete GitHub source archive.',
  );

  const configuredEnvironmentPointer = environment.CHARITYPILOT_PERSONAL_SERVER_ENV_FILE?.trim() ?? '';
  const locationPointerPath = environment.LOCALAPPDATA
    ? join(environment.LOCALAPPDATA, 'CharityPilot', 'personal-server-location.json')
    : null;
  const pointerAbsent = !configuredEnvironmentPointer && (!locationPointerPath || !existsSync(locationPointerPath));
  addCheck(
    checks,
    'state.existing-pointer-absent',
    resumeFailed || pointerAbsent,
    resumeFailed
      ? 'Failed-install resume retains its protected installation pointer.'
      : (pointerAbsent ? 'No user environment or protected location pointer identifies another installation.' : 'An existing user environment or protected location pointer identifies a personal-server installation.'),
    'Use the existing installation lifecycle. Replacement-host restore requires a genuinely blank host/profile and never overwrites another installation pointer.',
  );

  const windows = platform === 'win32';
  addCheck(
    checks,
    'system.windows',
    windows,
    windows ? 'Windows host detected.' : `Unsupported host platform: ${platform}.`,
    'Run this installer in Windows PowerShell on the intended Windows host.',
  );

  const stateAbsolute = isAbsolute(requestedStateRoot);
  const stateOutsideRepository = stateAbsolute && !isWithin(stateRoot, repositoryRoot);
  let statePathSafe = stateOutsideRepository;
  if (existsSync(stateRoot)) {
    try {
      const status = lstatSync(stateRoot);
      statePathSafe = statePathSafe && status.isDirectory() && !status.isSymbolicLink();
    } catch {
      statePathSafe = false;
    }
  }
  addCheck(
    checks,
    'state.external-path',
    statePathSafe,
    statePathSafe ? `Durable state root is outside the checkout: ${stateRoot}.` : 'State root must be an absolute real directory outside the checkout.',
    'Choose a protected path such as $env:LOCALAPPDATA\\CharityPilot\\personal-server or an encrypted data drive.',
  );
  const stateRecordExists = existsSync(join(stateRoot, 'install-state.json'));
  addCheck(
    checks,
    'state.new-install',
    resumeFailed ? stateRecordExists : !stateRecordExists,
    resumeFailed
      ? (stateRecordExists ? 'Failed-install resume state record is present.' : 'Failed-install resume state record is missing.')
      : (stateRecordExists ? 'An installation state record already exists.' : 'No prior installation state record exists.'),
    resumeFailed
      ? 'Use -ResumeFailed only with the protected state created by the same failed installer.'
      : 'Use the documented start/update/status commands for an existing installation; do not rerun the first installer.',
  );
  let stateRootEmpty = true;
  if (existsSync(stateRoot)) {
    try {
      stateRootEmpty = readdirSync(stateRoot).length === 0;
    } catch {
      stateRootEmpty = false;
    }
  }
  addCheck(
    checks,
    'state.empty-root',
    resumeFailed ? (existsSync(stateRoot) && !stateRootEmpty) : stateRootEmpty,
    resumeFailed
      ? (existsSync(stateRoot) && !stateRootEmpty ? 'Failed-install state root is present for guarded resume.' : 'Failed-install state root is absent or unexpectedly empty.')
      : (stateRootEmpty ? 'The proposed state root is absent or empty.' : 'The proposed state root already contains files.'),
    resumeFailed
      ? 'Preserve the failed installation state and use its exact configured StateRoot.'
      : 'Choose a new empty directory dedicated exclusively to this CharityPilot installation.',
  );

  const source = requiredFilesPresent
    ? inspectSource(repositoryRoot, execute, checks)
    : { kind: existsSync(join(repositoryRoot, '.git')) ? 'git' : 'archive', clean: false };

  const packageJson = requiredFilesPresent
    ? JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
    : {};

  const powerShell = execute('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$PSVersionTable.PSVersion.ToString() + '|' + $PSVersionTable.PSEdition",
  ], { cwd: repositoryRoot });
  const powerShellParts = powerShell.stdout.split('|');
  const powerShellComparison = compareVersions(powerShellParts[0], '5.1.0');
  const powerShellValid = powerShell.status === 0 && powerShellComparison !== null && powerShellComparison >= 0;
  addCheck(
    checks,
    'system.powershell',
    powerShellValid,
    powerShellValid ? `PowerShell ${powerShellParts[0]} (${powerShellParts[1] || 'unknown edition'}) is available.` : 'PowerShell 5.1 or later is required.',
    'Run Windows Update or install current PowerShell, then use the root installer script again.',
  );

  const nodeRange = packageJson?.engines?.node;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeValid = typeof nodeRange === 'string' && satisfiesNodeEngine(nodeVersion, nodeRange);
  addCheck(
    checks,
    'runtime.node',
    nodeValid,
    nodeValid ? `Node ${nodeVersion} satisfies ${nodeRange}.` : `Node ${nodeVersion} does not satisfy the repository engine ${nodeRange ?? '(missing)'}.`,
    `Install a supported Node release satisfying ${nodeRange ?? 'the package.json engines field'}.`,
  );

  const packageManager = String(packageJson?.packageManager ?? '');
  const expectedNpm = /^npm@(.+)$/u.exec(packageManager)?.[1] ?? null;
  const npmResult = platform === 'win32'
    ? execute('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '& npm.cmd --version',
    ], { cwd: repositoryRoot })
    : execute('npm', ['--version'], { cwd: repositoryRoot });
  const npmValid = npmResult.status === 0 && expectedNpm !== null && npmResult.stdout === expectedNpm;
  addCheck(
    checks,
    'runtime.npm',
    npmValid,
    npmValid ? `npm ${npmResult.stdout} matches ${packageManager}.` : `npm ${npmResult.stdout || '(unavailable)'} does not match ${packageManager || '(missing packageManager)'}.`,
    expectedNpm ? `Install the declared package manager with: npm install --global npm@${expectedNpm}` : 'Restore package.json packageManager metadata.',
  );

  const dockerVersion = execute('docker', [
    'version',
    '--format',
    '{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}',
  ], { cwd: repositoryRoot, timeout: 30_000 });
  const dockerParts = dockerVersion.stdout.split('|');
  const dockerValid = dockerVersion.status === 0 && dockerParts.length === 4 && dockerParts[0] && dockerParts[1] && dockerParts[2] === 'linux';
  addCheck(
    checks,
    'docker.engine',
    Boolean(dockerValid),
    dockerValid
      ? `Docker client ${dockerParts[0]} can reach Linux server ${dockerParts[1]} (${dockerParts[3]}).`
      : 'Docker client/server is unavailable or Docker is not running Linux containers.',
    'Start Docker Desktop, select Linux containers, wait for the engine to be ready, and rerun preflight.',
  );

  const composeVersion = execute('docker', ['compose', 'version', '--short'], { cwd: repositoryRoot });
  const composeHelp = execute('docker', ['compose', 'up', '--help'], { cwd: repositoryRoot });
  const composeValid = composeVersion.status === 0 && composeHelp.status === 0 && /--wait\b/u.test(composeHelp.stdout) && /--wait-timeout\b/u.test(composeHelp.stdout);
  addCheck(
    checks,
    'docker.compose',
    composeValid,
    composeValid ? `Docker Compose ${composeVersion.stdout} supports --wait and --wait-timeout.` : 'Docker Compose v2 with required wait capabilities is unavailable.',
    'Update Docker Desktop/Compose, then confirm `docker compose up --help` lists --wait and --wait-timeout.',
  );

  const dockerInfo = execute('docker', ['info', '--format', '{{.OperatingSystem}}'], { cwd: repositoryRoot, timeout: 30_000 });
  const usesDockerDesktop = /docker desktop/iu.test(dockerInfo.stdout);
  const wsl = detectWsl2(execute, repositoryRoot);
  const wslRequired = windows && usesDockerDesktop;
  const wslValid = !wslRequired || (wsl.available && wsl.versionTwo);
  addCheck(
    checks,
    'system.wsl2',
    wslValid,
    wslRequired
      ? (wslValid ? 'Docker Desktop is backed by WSL 2.' : 'Docker Desktop is present but WSL 2 could not be proven.')
      : 'WSL 2-specific validation is not required for the detected Docker engine.',
    'Enable WSL 2 (`wsl --set-default-version 2`) and Docker Desktop WSL integration, then rerun preflight.',
    wsl.summary || undefined,
  );

  const portAvailable = await canBindPort(port);
  addCheck(
    checks,
    'network.loopback-port',
    resumeFailed || portAvailable,
    resumeFailed
      ? `Resume will reclaim the installation's configured loopback port 127.0.0.1:${port}.`
      : (portAvailable ? `127.0.0.1:${port} is available.` : `127.0.0.1:${port} is already in use or cannot be bound.`),
    'Stop the owning application or choose a different --port and matching loopback origin. Do not publish on 0.0.0.0.',
  );

  const networks = inspectDockerNetworks(execute, repositoryRoot);
  const subnetValid = !networks.error && (resumeFailed
    ? networks.overlaps.every(({ name }) => name === PERSONAL_NETWORK)
    : networks.overlaps.length === 0);
  addCheck(
    checks,
    'network.personal-subnet',
    subnetValid,
    subnetValid ? `${PERSONAL_SUBNET} does not overlap an existing Docker network.` : `The reserved subnet cannot be used${networks.overlaps.length ? ` because of ${networks.overlaps.map((item) => `${item.name} (${item.subnet})`).join(', ')}` : ''}.`,
    'Choose a coordinated replacement subnet and update Compose, Caddy trust, API trusted proxy, tests and documentation together; do not broaden proxy trust.',
    networks.error || undefined,
  );

  let repositoryFreeBytes = 0;
  let stateFreeBytes = 0;
  let diskInspectionError = null;
  try {
    repositoryFreeBytes = diskFreeBytes(repositoryRoot);
    stateFreeBytes = diskFreeBytes(stateRoot);
  } catch (error) {
    diskInspectionError = error instanceof Error ? error.message : String(error);
  }
  const diskValid = repositoryFreeBytes >= MINIMUM_FREE_BYTES && stateFreeBytes >= MINIMUM_FREE_BYTES;
  addCheck(
    checks,
    'storage.free-space',
    diskValid,
    diskInspectionError
      ? 'Free space could not be inspected for the checkout and state volumes.'
      : `Free space: checkout volume ${(repositoryFreeBytes / 1024 ** 3).toFixed(1)} GiB; state volume ${(stateFreeBytes / 1024 ** 3).toFixed(1)} GiB; required minimum ${MINIMUM_FREE_GIB} GiB on each used volume.`,
    'Free disk space or select a state root on a larger encrypted drive. Also verify Docker Desktop virtual-disk capacity before building images.',
    diskInspectionError || undefined,
  );
  addWarning(
    warnings,
    'storage.docker-vhd',
    'Windows free-space checks cannot prove free capacity inside Docker Desktop\'s managed virtual disk.',
    'Open Docker Desktop storage settings and confirm adequate image/build/volume capacity before installation.',
  );

  const envPath = join(stateRoot, '.env.personal-server');
  const legacyEnvPath = join(repositoryRoot, '.env.personal-server');
  const environmentAbsent = !existsSync(envPath) && !existsSync(legacyEnvPath);
  addCheck(
    checks,
    'installation.environment-absent',
    resumeFailed ? existsSync(envPath) : environmentAbsent,
    resumeFailed
      ? (existsSync(envPath) ? 'Protected failed-install environment file is present.' : 'Protected failed-install environment file is missing.')
      : (environmentAbsent
        ? 'No existing personal-server environment file exists in protected state or the legacy checkout location.'
        : 'A personal-server environment file already exists in protected state or the legacy checkout location.'),
    resumeFailed
      ? 'Recover the exact protected environment file before resuming; never regenerate secrets over existing volumes.'
      : 'Use the normal start/status/update commands for an existing installation. Do not overwrite or delete its environment file casually.',
    environmentAbsent ? undefined : { envPath, legacyEnvPath },
  );

  const resources = inspectExistingResources(execute, repositoryRoot);
  const resourceItems = Object.values(resources.found ?? {}).flat();
  const resourcesAbsent = !resources.error && resourceItems.length === 0;
  addCheck(
    checks,
    'installation.resources-absent',
    resumeFailed ? !resources.error : resourcesAbsent,
    resumeFailed
      ? (!resources.error ? `Docker resources were inspected for guarded resume${resourceItems.length ? `: ${resourceItems.join(', ')}` : '; none were created before the failure'}.` : 'Docker resources could not be inspected for guarded resume.')
      : (resourcesAbsent ? 'No existing personal-server containers, volumes, or network exist.' : `Existing personal-server Docker resources were found${resourceItems.length ? `: ${resourceItems.join(', ')}` : ''}.`),
    'Treat existing resources as potentially containing real data. Use status/update/recovery guidance; never delete volumes to force a reinstall.',
    resources.error || undefined,
  );

  if (checks.every((check) => check.status === 'passed')) {
    inspectTailnetOrigin(origin, execute, repositoryRoot, checks, warnings, platform, port);
  } else if (origin.startsWith('https://') && new URL(origin).hostname.toLowerCase().endsWith('.ts.net')) {
    inspectTailnetOrigin(origin, execute, repositoryRoot, checks, warnings, platform, port);
  }

  const failures = checks.filter((check) => check.status === 'failed');
  return {
    format: PREFLIGHT_FORMAT,
    status: failures.length === 0 ? 'passed' : 'failed',
    mode: resumeFailed
      ? 'resume-preflight'
      : replacementRestore
        ? 'replacement-restore-preflight'
        : options.dryRun ? 'dry-run' : 'preflight',
    checkedAt: now().toISOString(),
    repositoryRoot,
    stateRoot,
    recoveryRoot: join(stateRoot, 'recovery'),
    origin,
    port,
    personalSubnet: PERSONAL_SUBNET,
    source,
    checks,
    warnings,
    failures,
  };
}

function humanReport(report) {
  const lines = [
    `CharityPilot personal-server preflight: ${report.status.toUpperCase()}`,
    `Source: ${report.source.kind}${report.source.revision ? ` ${report.source.revision}` : report.source.fingerprint ? ` sha256:${report.source.fingerprint}` : ''}`,
    `Origin: ${report.origin}`,
    `State root: ${report.stateRoot}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status === 'passed' ? 'PASS' : 'FAIL'}] ${check.id}: ${check.summary}`);
    if (check.status === 'failed' && check.remediation) lines.push(`       Fix: ${check.remediation}`);
  }
  for (const warning of report.warnings) {
    lines.push(`[WARN] ${warning.id}: ${warning.summary}`);
    if (warning.remediation) lines.push(`       Action: ${warning.remediation}`);
  }
  if (report.status === 'passed') {
    lines.push('', 'Preflight passed. No host state was changed.');
  } else {
    lines.push('', `${report.failures.length} blocking check(s) failed. No host state was changed.`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parsePreflightOptions(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(usage());
    } else {
      const report = await runPersonalServerPreflight({
        origin: parsed.origin,
        port: parsed.port,
        stateRoot: parsed.stateroot,
        dryRun: parsed.dryRun,
        resumeFailed: parsed.resumeFailed,
        replacementRestore: parsed.replacementRestore,
      });
      process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report));
      if (report.status !== 'passed') process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exitCode = 2;
  }
}
