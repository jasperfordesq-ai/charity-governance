#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  composeSafeEnvironment,
  pinnedLocalDockerEnvironment,
  validateLocalDockerEndpoint,
  validateLocalDockerRuntime,
} from './personal-server-docker-boundary.mjs';
import { cidrOverlaps } from './personal-server-preflight.mjs';

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_DOCKER_API = [1, 48];
const MINIMUM_COMPOSE = [2, 33, 1];
const MINIMUM_FREE_BYTES = 20 * 1024 ** 3;
const CANONICAL_REMOTE = 'https://github.com/jasperfordesq-ai/charity-governance.git';

function execute(command, args, { cwd, env = process.env, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, windowsHide: true });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? result.error?.message ?? '').trim(),
  };
}

function versionAtLeast(value, minimum) {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function pathWithin(candidate, parent) {
  const value = relative(resolve(parent), resolve(candidate));
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function add(checks, name, passed, summary, fix) {
  checks.push({ name, passed: Boolean(passed), summary, ...(passed || !fix ? {} : { fix }) });
}

async function portAvailable(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

function freeBytes(path) {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = resolve(candidate, '..');
    if (parent === candidate) break;
    candidate = parent;
  }
  const stats = statfsSync(candidate);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function runLinuxPreflight({
  repositoryRoot,
  stateRoot,
  port = 8080,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  executeImpl = execute,
  portAvailableImpl = portAvailable,
} = {}) {
  const repo = resolve(repositoryRoot);
  const state = resolve(stateRoot);
  const checks = [];
  add(checks, 'system.linux', platform === 'linux', `Host platform: ${platform}.`, 'Use a supported 64-bit Linux VM.');
  add(checks, 'system.architecture', architecture === 'x64', `Host architecture: ${architecture}.`, 'The first Linux profile supports x86-64 only; ARM acceptance remains open.');
  add(checks, 'system.operator', uid !== 0 && Number.isInteger(uid), uid === 0 ? 'Root is not a supported routine operator.' : `Dedicated operator UID: ${uid}.`, 'Sign in as a dedicated non-root operator who can access Docker.');
  const stateSafe = isAbsolute(stateRoot) && state !== repo && !pathWithin(state, repo) && !pathWithin(repo, state);
  add(checks, 'state.external', stateSafe, `State root: ${state}.`, 'Choose an absolute state directory outside the source checkout.');
  let stateEmpty = true;
  if (existsSync(state)) {
    const status = lstatSync(state);
    stateEmpty = status.isDirectory() && !status.isSymbolicLink() && readdirSync(state).length === 0;
  }
  add(checks, 'state.empty', stateEmpty, stateEmpty ? 'State root is absent or empty.' : 'State root is occupied or unsafe.', 'Use a new empty state root; never delete an existing installation to force this check.');
  const pointerPath = join(environment.XDG_STATE_HOME?.trim() || join(environment.HOME ?? '', '.local', 'state'), 'charitypilot', 'personal-server-location.json');
  add(checks, 'state.pointer-absent', !existsSync(pointerPath), !existsSync(pointerPath) ? 'No Linux installation pointer exists.' : 'A Linux installation pointer already exists.', 'Use status/recovery guidance for the existing installation; do not overwrite its pointer.');

  const node = executeImpl('node', ['--version'], { cwd: repo, env: environment });
  add(checks, 'runtime.node', node.status === 0 && versionAtLeast(node.stdout.replace(/^v/u, ''), [MINIMUM_NODE_MAJOR]), `Node: ${node.stdout || 'unavailable'}.`, 'Install Node.js 22 or later.');
  const expectedNpm = JSON.parse(await import('node:fs').then(({ readFileSync }) => readFileSync(resolve(repo, 'package.json'), 'utf8'))).packageManager;
  const npm = executeImpl('npm', ['--version'], { cwd: repo, env: environment });
  add(checks, 'runtime.npm', npm.status === 0 && `npm@${npm.stdout}` === expectedNpm, `npm: ${npm.stdout || 'unavailable'}; required ${expectedNpm}.`, `Install ${expectedNpm}.`);

  const status = executeImpl('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, env: environment });
  const branch = executeImpl('git', ['branch', '--show-current'], { cwd: repo, env: environment });
  const head = executeImpl('git', ['rev-parse', 'HEAD'], { cwd: repo, env: environment });
  const upstream = executeImpl('git', ['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}'], { cwd: repo, env: environment });
  const remote = executeImpl('git', ['remote', 'get-url', 'origin'], { cwd: repo, env: environment });
  const sourceSafe = status.status === 0 && status.stdout === '' && branch.stdout === 'master' && head.stdout === upstream.stdout && remote.stdout === CANONICAL_REMOTE;
  add(checks, 'source.identity', sourceSafe, sourceSafe ? `Clean canonical master at ${head.stdout}.` : 'Source is not clean canonical origin/master.', 'Use a clean canonical release checkout; do not install from a dirty development tree.');

  const dockerContext = executeImpl('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}|{{.Endpoints.docker.SkipTLSVerify}}'], { cwd: repo, env: environment });
  const [endpoint = '', skipTlsVerify = ''] = dockerContext.stdout.split('|');
  let endpointSafe = false;
  try {
    validateLocalDockerEndpoint({ endpoint, skipTlsVerify, platform: 'linux' }, environment);
    endpointSafe = dockerContext.status === 0;
  } catch { endpointSafe = false; }
  add(checks, 'docker.local', endpointSafe, endpointSafe ? `Local Docker socket: ${endpoint}.` : 'Local Linux Docker socket validation failed.', 'Use the local unix:///var/run/docker.sock context and clear Docker/BuildKit overrides.');
  const dockerEnv = endpointSafe ? composeSafeEnvironment(pinnedLocalDockerEnvironment(environment, endpoint)) : environment;
  const info = executeImpl('docker', ['info', '--format', '{{.OperatingSystem}}|{{.OSType}}'], { cwd: repo, env: dockerEnv });
  const api = executeImpl('docker', ['version', '--format', '{{.Server.APIVersion}}'], { cwd: repo, env: dockerEnv });
  let runtimeSafe = false;
  try {
    const [operatingSystem = '', serverOs = ''] = info.stdout.split('|');
    validateLocalDockerRuntime({ endpoint, skipTlsVerify, operatingSystem, serverOs, apiVersion: api.stdout, platform: 'linux' }, environment);
    runtimeSafe = info.status === 0 && api.status === 0 && versionAtLeast(api.stdout, MINIMUM_DOCKER_API);
  } catch { runtimeSafe = false; }
  add(checks, 'docker.engine', runtimeSafe, runtimeSafe ? `Local Linux Docker Engine API ${api.stdout}.` : 'Supported local Linux Docker Engine is unavailable.', 'Install Docker Engine with API 1.48 or later and grant the dedicated operator access.');
  const compose = executeImpl('docker', ['compose', 'version', '--short'], { cwd: repo, env: dockerEnv });
  const composeHelp = executeImpl('docker', ['compose', 'up', '--help'], { cwd: repo, env: dockerEnv });
  const composeSafe = compose.status === 0 && versionAtLeast(compose.stdout, MINIMUM_COMPOSE) && /--wait\b/u.test(composeHelp.stdout) && /--wait-timeout\b/u.test(composeHelp.stdout);
  add(checks, 'docker.compose', composeSafe, `Compose: ${compose.stdout || 'unavailable'}.`, 'Install Docker Compose 2.33.1 or later with --wait and --wait-timeout.');
  const projectContainers = executeImpl('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project=charitypilot-personal-server', '--format', '{{.ID}}'], { cwd: repo, env: dockerEnv });
  const exactResources = [
    ['network', 'charitypilot-personal-server-internal'],
    ['network', 'charitypilot-personal-server-edge'],
    ['volume', 'charitypilot-personal-server-db'],
    ['volume', 'charitypilot-personal-server-documents'],
  ];
  const existingResources = exactResources.filter(([kind, name]) => executeImpl('docker', [kind, 'inspect', name], { cwd: repo, env: dockerEnv }).status === 0);
  const resourcesAbsent = projectContainers.status === 0 && projectContainers.stdout === '' && existingResources.length === 0;
  add(checks, 'docker.resources-absent', resourcesAbsent, resourcesAbsent ? 'No personal-server Docker resources exist.' : 'Existing personal-server Docker resources were found.', 'Preserve existing resources and use status/recovery guidance; do not delete them to force a new install.');
  const networkIds = executeImpl('docker', ['network', 'ls', '-q'], { cwd: repo, env: dockerEnv });
  let subnetSafe = networkIds.status === 0;
  for (const networkId of networkIds.stdout.split(/\s+/u).filter(Boolean)) {
    const inspected = executeImpl('docker', ['network', 'inspect', networkId, '--format', '{{json .IPAM.Config}}'], { cwd: repo, env: dockerEnv });
    if (inspected.status !== 0) { subnetSafe = false; break; }
    let configurations;
    try { configurations = JSON.parse(inspected.stdout); } catch { subnetSafe = false; break; }
    for (const configuration of Array.isArray(configurations) ? configurations : []) {
      if (typeof configuration?.Subnet === 'string' && (
        cidrOverlaps(configuration.Subnet, '172.30.250.0/24') ||
        cidrOverlaps(configuration.Subnet, '172.30.251.0/24')
      )) subnetSafe = false;
    }
  }
  add(checks, 'docker.subnets', subnetSafe, subnetSafe ? 'Reserved personal-server subnets are available.' : 'A Docker network overlaps a reserved personal-server subnet.', 'Choose a host without an overlap; coordinated subnet changes require code, proxy-policy, tests and documentation changes.');
  add(checks, 'network.loopback-port', await portAvailableImpl(Number(port)), `Loopback port 127.0.0.1:${port}.`, 'Select an unused loopback port.');
  const available = Math.min(freeBytes(repo), freeBytes(state));
  add(checks, 'storage.free', available >= MINIMUM_FREE_BYTES, `Minimum available host space: ${(available / 1024 ** 3).toFixed(1)} GiB.`, 'Provide at least 20 GiB free on source and state volumes, plus Docker storage capacity.');
  return { format: 'charitypilot-personal-server-linux-preflight/v1', status: checks.every((check) => check.passed) ? 'passed' : 'failed', repositoryRoot: repo, stateRoot: state, checks };
}

function parse(argv) {
  const options = {};
  for (const token of argv) {
    const match = /^--(repository-root|state-root|port)=(.+)$/u.exec(token);
    if (!match || options[match[1]] !== undefined) throw new Error(`Invalid or duplicate option: ${token}`);
    options[match[1]] = match[2];
  }
  if (!options['repository-root'] || !options['state-root']) throw new Error('--repository-root and --state-root are required');
  const port = Number(options.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
  return { repositoryRoot: options['repository-root'], stateRoot: options['state-root'], port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runLinuxPreflight(parse(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
