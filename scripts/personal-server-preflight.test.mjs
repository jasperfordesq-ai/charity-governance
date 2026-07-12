import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalInstallOrigin,
  classifyTailscaleServeConfiguration,
  cidrOverlaps,
  parsePreflightOptions,
  runPersonalServerPreflight,
  satisfiesNodeEngine,
  supportedWindowsBuild,
} from './personal-server-preflight.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ampleDisk = 30 * 1024 ** 3;

function passingDependencies(customResponse = null) {
  const calls = [];
  const execute = (command, args, options = {}) => {
    calls.push([command, [...args], options]);
    const custom = customResponse?.(command, args);
    if (custom) return custom;

    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { status: 0, stdout: repositoryRoot, stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'branch') return { status: 0, stdout: 'master', stderr: '' };
    if (command === 'git' && args[0] === 'remote') {
      return { status: 0, stdout: 'https://github.com/jasperfordesq-ai/charity-governance.git', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
      return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    }
    if (command === 'powershell.exe' && args.at(-1) === '& npm.cmd --version') {
      return { status: 0, stdout: '11.11.0', stderr: '' };
    }
    if (command === 'powershell.exe') return { status: 0, stdout: '5.1.22621.4391|Desktop', stderr: '' };
    if (command === 'docker' && args[0] === 'version') {
      return { status: 0, stdout: '29.5.2|29.5.2|linux|amd64|1.54', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'compose' && args[1] === 'version') {
      return { status: 0, stdout: '2.40.3', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'compose' && args[1] === 'up') {
      return { status: 0, stdout: 'Options:\n  --wait\n  --wait-timeout seconds', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'info') {
      return { status: 0, stdout: 'Docker Desktop', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'context' && args[1] === 'show') {
      return { status: 0, stdout: 'desktop-linux', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'context' && args[1] === 'inspect') {
      return { status: 0, stdout: 'npipe:////./pipe/dockerDesktopLinuxEngine|false', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
    if (command === 'docker' && args[0] === 'volume') return { status: 0, stdout: '', stderr: '' };
    if (command === 'wsl.exe' && args[0] === '--status') {
      return { status: 0, stdout: 'Default Distribution: Ubuntu\nDefault Version: 2', stderr: '' };
    }
    if (command === 'wsl.exe') {
      return { status: 0, stdout: '  NAME      STATE    VERSION\n* Ubuntu    Stopped  2', stderr: '' };
    }
    if (command === 'tailscale.exe' && args[0] === 'serve') {
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (command === 'tailscale.exe') {
      return {
        status: 0,
        stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'charitypilot.example.ts.net.', Online: true } }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`);
  };

  return {
    dependencies: {
      platform: 'win32',
      osRelease: '10.0.26200',
      repositoryRoot,
      environment: { LOCALAPPDATA: join(tmpdir(), 'charitypilot-preflight-base') },
      nodeVersion: '24.14.1',
      execute,
      diskFreeBytes: () => ampleDisk,
      canBindPort: async () => true,
      now: () => new Date('2026-07-12T08:00:00.000Z'),
    },
    calls,
  };
}

test('origin, version and CIDR helpers enforce exact contracts', () => {
  assert.equal(canonicalInstallOrigin('http://localhost:8080', 8080), 'http://localhost:8080');
  assert.equal(canonicalInstallOrigin('https://charitypilot.example.ts.net', 8080), 'https://charitypilot.example.ts.net');
  assert.throws(() => canonicalInstallOrigin('http://localhost:8081', 8080));
  assert.throws(() => canonicalInstallOrigin('https://example.org/path', 8080));
  assert.throws(() => canonicalInstallOrigin('https://example.org', 8080));
  assert.throws(() => canonicalInstallOrigin('http://[::1]:8080', 8080));
  assert.equal(satisfiesNodeEngine('24.14.1', '>=22.0.0'), true);
  assert.equal(satisfiesNodeEngine('20.17.0', '>=22.0.0'), false);
  assert.deepEqual(supportedWindowsBuild('win32', '10.0.26100'), { build: 26100, supported: true });
  assert.deepEqual(supportedWindowsBuild('win32', '10.0.26099'), { build: 26099, supported: false });
  assert.equal(supportedWindowsBuild('win32', '6.3.9600'), null);
  assert.equal(supportedWindowsBuild('linux', '10.0.26200'), null);
  assert.equal(cidrOverlaps('172.30.250.0/24', '172.30.250.128/25'), true);
  assert.equal(cidrOverlaps('172.30.250.0/24', '172.30.251.0/24'), false);
  assert.equal(classifyTailscaleServeConfiguration({}, 'charitypilot.example.ts.net', 8080), 'empty');
  assert.equal(classifyTailscaleServeConfiguration({
    TCP: { 443: { HTTPS: true } },
    Web: { 'charitypilot.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
  }, 'charitypilot.example.ts.net', 8080), 'exact');
  assert.equal(classifyTailscaleServeConfiguration({
    AllowFunnel: { 'charitypilot.example.ts.net:443': true },
  }, 'charitypilot.example.ts.net', 8080), 'invalid');
});

test('CLI option parsing preserves dry-run and rejects duplicates', () => {
  assert.deepEqual(
    parsePreflightOptions(['--origin=http://localhost:9090', '--port', '9090', '--state-root=C:\\Data\\CharityPilot', '--dry-run', '--json']),
    {
      json: true,
      dryRun: true,
      origin: 'http://localhost:9090',
      port: '9090',
      stateroot: 'C:\\Data\\CharityPilot',
    },
  );
  assert.throws(() => parsePreflightOptions(['--json', '--json']), /only once/u);
  assert.equal(parsePreflightOptions(['--resume-failed']).resumeFailed, true);
  assert.throws(() => parsePreflightOptions(['--unknown']), /Unknown option/u);
  assert.equal(parsePreflightOptions(['--replacement-restore']).replacementRestore, true);
  assert.throws(
    () => parsePreflightOptions(['--replacement-restore', '--resume-failed']),
    /mutually exclusive/u,
  );
});

test('replacement-host preflight requires a blank pointer profile and reports its distinct mode', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-replacement`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies } = passingDependencies();
  const report = await runPersonalServerPreflight({
    repositoryRoot,
    stateRoot,
    replacementRestore: true,
  }, dependencies);
  assert.equal(report.status, 'passed');
  assert.equal(report.mode, 'replacement-restore-preflight');
  assert.equal(report.checks.find(({ id }) => id === 'state.existing-pointer-absent')?.status, 'passed');

  const blocked = await runPersonalServerPreflight({
    repositoryRoot,
    stateRoot,
    replacementRestore: true,
  }, {
    ...dependencies,
    environment: {
      LOCALAPPDATA: join(tmpdir(), 'charitypilot-preflight-base'),
      CHARITYPILOT_PERSONAL_SERVER_ENV_FILE: join(tmpdir(), 'another-install', '.env.personal-server'),
    },
  });
  assert.ok(blocked.failures.some(({ id }) => id === 'state.existing-pointer-absent'));
});

test('CLI entry point forwards failed-install resume mode into the preflight engine', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts/personal-server-preflight.mjs'), 'utf8');
  assert.match(source, /resumeFailed:\s*parsed\.resumeFailed/u);
});

test('complete Windows, Node, npm, Docker, WSL2, network and storage preflight passes read-only', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-passing`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies, calls } = passingDependencies();
  dependencies.environment = {
    ...dependencies.environment,
    DOCKER_CONTEXT: 'desktop-linux',
    compose_profiles: 'maintenance',
  };
  const report = await runPersonalServerPreflight(
    { repositoryRoot, stateRoot, origin: 'http://localhost:8080', port: 8080, dryRun: true },
    dependencies,
  );

  assert.equal(report.status, 'passed');
  assert.equal(report.mode, 'dry-run');
  assert.equal(existsSync(stateRoot), false);
  assert.equal(report.source.revision, 'a'.repeat(40));
  assert.equal(report.source.originMasterRevision, 'a'.repeat(40));
  assert.equal(report.source.canonicalTrackingRef, true);
  assert.ok(report.checks.length >= 17);
  assert.ok(report.checks.every((check) => check.status === 'passed'));
  assert.ok(calls.some(([command, args]) => command === 'docker' && args[0] === 'version'));
  assert.ok(calls.some(([command]) => command === 'wsl.exe'));
  const daemonCalls = calls.filter(([command, args]) => command === 'docker' && args[0] !== 'context');
  assert.ok(daemonCalls.length > 0);
  for (const [, , callOptions] of daemonCalls) {
    assert.equal(callOptions.env.DOCKER_HOST, 'npipe:////./pipe/dockerDesktopLinuxEngine');
    assert.equal(
      Object.keys(callOptions.env).some((name) => (
        /^(?:DOCKER_CONTEXT|DOCKER_TLS|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|DOCKER_API_VERSION|DOCKER_BUILDKIT|DOCKER_DEFAULT_PLATFORM|DOCKER_CONFIG)$/iu.test(name) ||
        /^(?:BUILDKIT_|BUILDX_|COMPOSE_)/iu.test(name)
      )),
      false,
    );
  }
});

test('preflight rejects Windows builds below the explicit supported host baseline', async () => {
  const { dependencies } = passingDependencies();
  dependencies.osRelease = '10.0.26099';
  const report = await runPersonalServerPreflight({
    repositoryRoot,
    stateRoot: join(tmpdir(), 'charitypilot-unsupported-windows-build'),
  }, dependencies);
  const check = report.checks.find((item) => item.id === 'system.windows-version');
  assert.equal(check?.status, 'failed');
  assert.match(check?.summary ?? '', /below the supported Windows 11 24H2 baseline/u);
  assert.ok(report.failures.some((failure) => failure.id === 'system.windows-version'));
});

test('Compose older than gw_priority support fails even when wait flags exist', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-old-compose`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies } = passingDependencies((command, args) => (
    command === 'docker' && args[0] === 'compose' && args[1] === 'version'
      ? { status: 0, stdout: '2.32.4', stderr: '' }
      : null
  ));
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  assert.equal(report.checks.find(({ id }) => id === 'docker.compose')?.status, 'failed');
});

test('Engine API older than gateway-priority support fails before installation', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-old-engine`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies } = passingDependencies((command, args) => (
    command === 'docker' && args[0] === 'version'
      ? { status: 0, stdout: '27.5.1|27.5.1|linux|amd64|1.47', stderr: '' }
      : null
  ));
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  assert.equal(report.checks.find(({ id }) => id === 'docker.engine')?.status, 'failed');
});

test('remote Docker endpoints and daemon environment overrides fail closed', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-remote-docker`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies, calls } = passingDependencies((command, args) => (
    command === 'docker' && args[0] === 'context' && args[1] === 'inspect'
      ? { status: 0, stdout: 'ssh://remote.example|false', stderr: '' }
      : null
  ));
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  assert.equal(report.checks.find(({ id }) => id === 'docker.local-desktop')?.status, 'failed');
  assert.equal(
    calls.some(([command, args]) => command === 'docker' && args[0] !== 'context'),
    false,
  );

  for (const override of [
    { DOCKER_HOST: 'tcp://remote.example:2376' },
    { docker_api_version: '1.47' },
    { DOCKER_DEFAULT_PLATFORM: 'linux/arm64' },
    { docker_config: 'C:\\remote-docker-config' },
    { BUILDKIT_HOST: 'tcp://remote-builder.example:1234' },
    { buildx_builder: 'remote-builder' },
  ]) {
    const { dependencies: overriddenDependencies, calls: overrideCalls } = passingDependencies();
    overriddenDependencies.environment = { ...overriddenDependencies.environment, ...override };
    const overridden = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, overriddenDependencies);
    assert.equal(overridden.checks.find(({ id }) => id === 'docker.local-desktop')?.status, 'failed');
    assert.equal(
      overrideCalls.some(([command, args]) => command === 'docker' && args[0] !== 'context'),
      false,
    );
  }
});

test('invalid local Docker runtime stops before Compose and resource inspection', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-invalid-runtime`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies, calls } = passingDependencies((command, args) => (
    command === 'docker' && args[0] === 'version'
      ? { status: 0, stdout: '29.5.2|29.5.2|windows|amd64|1.54', stderr: '' }
      : null
  ));
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  assert.equal(report.checks.find(({ id }) => id === 'docker.local-desktop')?.status, 'failed');
  assert.equal(
    calls.some(([command, args]) => (
      command === 'docker' && ['compose', 'network', 'ps', 'volume'].includes(args[0])
    )),
    false,
  );
});

test('dirty source, non-Linux Docker and unavailable port are blocking failures', async () => {
  const { dependencies } = passingDependencies((command, args) => {
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: ' M unsafe-change.txt', stderr: '' };
    if (command === 'docker' && args[0] === 'version') {
      return { status: 0, stdout: '29.5.2|29.5.2|windows|amd64|1.54', stderr: '' };
    }
    return null;
  });
  dependencies.canBindPort = async () => false;
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-failed`);
  rmSync(stateRoot, { recursive: true, force: true });
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  const failedIds = report.failures.map((failure) => failure.id);

  assert.equal(report.status, 'failed');
  assert.ok(failedIds.includes('source.clean'));
  assert.ok(failedIds.includes('docker.engine'));
  assert.ok(failedIds.includes('network.loopback-port'));
});

test('forks, non-master branches, and credential-bearing remotes fail without leaking the remote', async () => {
  const secretRemote = 'https://operator:github_pat_do_not_log@github.com/fork/charity-governance.git';
  const { dependencies } = passingDependencies((command, args) => {
    if (command === 'git' && args[0] === 'branch') return { status: 0, stdout: 'feature', stderr: '' };
    if (command === 'git' && args[0] === 'remote') return { status: 0, stdout: secretRemote, stderr: '' };
    return null;
  });
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-source-identity`);
  rmSync(stateRoot, { recursive: true, force: true });
  const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
  assert.ok(report.failures.some(({ id }) => id === 'source.branch'));
  assert.ok(report.failures.some(({ id }) => id === 'source.canonical-remote'));
  assert.equal(JSON.stringify(report).includes('github_pat_do_not_log'), false);
  assert.equal(Object.hasOwn(report.source, 'remote'), false);
});

test('clean Git install fails closed when origin/master is missing or diverges from HEAD without fetching', async () => {
  for (const [label, response] of [
    ['missing', { status: 128, stdout: '', stderr: 'missing ref' }],
    ['diverged', { status: 0, stdout: 'b'.repeat(40), stderr: '' }],
  ]) {
    const { dependencies, calls } = passingDependencies((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') return response;
      return null;
    });
    const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-origin-master-${label}`);
    rmSync(stateRoot, { recursive: true, force: true });
    const report = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
    assert.ok(report.failures.some(({ id }) => id === 'source.origin-master'));
    assert.equal(report.source.canonicalTrackingRef, false);
    assert.equal(calls.some(([command, args]) => command === 'git' && args[0] === 'fetch'), false);
  }
});

test('relative or occupied state roots and overlapping Docker subnet fail closed', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-occupied-'));
  writeFileSync(join(stateRoot, 'unrelated.txt'), 'do not take over this directory');
  try {
    const { dependencies } = passingDependencies((command, args) => {
      if (command === 'docker' && args[0] === 'network' && args[1] === 'ls' && args.includes('--quiet')) {
        return { status: 0, stdout: 'network-id', stderr: '' };
      }
      if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
        return {
          status: 0,
          stdout: JSON.stringify([
            { Name: 'internal-conflict', IPAM: { Config: [{ Subnet: '172.30.250.128/25' }] } },
            { Name: 'edge-conflict', IPAM: { Config: [{ Subnet: '172.30.251.128/25' }] } },
          ]),
          stderr: '',
        };
      }
      return null;
    });
    const occupied = await runPersonalServerPreflight({ repositoryRoot, stateRoot }, dependencies);
    assert.ok(occupied.failures.some((failure) => failure.id === 'state.empty-root'));
    assert.ok(occupied.failures.some((failure) => failure.id === 'network.personal-subnet'));
    assert.equal(occupied.personalSubnet, '172.30.250.0/24');
    assert.equal(occupied.personalEdgeSubnet, '172.30.251.0/24');

    const relative = await runPersonalServerPreflight({ repositoryRoot, stateRoot: 'relative-state' }, dependencies);
    assert.ok(relative.failures.some((failure) => failure.id === 'state.external-path'));
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('failed-install resume preflight requires and preserves the existing protected state', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-resume-'));
  writeFileSync(join(stateRoot, 'install-state.json'), JSON.stringify({
    format: 'charitypilot-personal-server-install-state/v1',
    phase: 'failed',
  }));
  writeFileSync(join(stateRoot, '.env.personal-server'), 'protected test environment');
  try {
    const { dependencies } = passingDependencies();
    dependencies.canBindPort = async () => false;
    const report = await runPersonalServerPreflight({
      repositoryRoot,
      stateRoot,
      resumeFailed: true,
    }, dependencies);
    assert.equal(report.status, 'passed');
    assert.equal(report.mode, 'resume-preflight');
    assert.equal(report.checks.find(({ id }) => id === 'state.new-install')?.status, 'passed');
    assert.equal(report.checks.find(({ id }) => id === 'installation.environment-absent')?.status, 'passed');
    assert.equal(report.checks.find(({ id }) => id === 'network.loopback-port')?.status, 'passed');
    assert.equal(existsSync(join(stateRoot, 'install-state.json')), true);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('failed-install resume accepts only exact preserved internal and edge network identities', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'charitypilot-preflight-resume-networks-'));
  writeFileSync(join(stateRoot, 'install-state.json'), JSON.stringify({
    format: 'charitypilot-personal-server-install-state/v1', phase: 'failed',
  }));
  writeFileSync(join(stateRoot, '.env.personal-server'), 'protected test environment');
  const network = (edge, overrides = {}) => ({
    Name: edge ? 'charitypilot-personal-server-edge' : 'charitypilot-personal-server-internal',
    Driver: 'bridge',
    Internal: !edge,
    Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.network': edge ? 'personal-server-edge' : 'personal-server-internal',
    },
    IPAM: { Config: [{
      Subnet: edge ? '172.30.251.0/24' : '172.30.250.0/24',
      Gateway: edge ? '172.30.251.1' : '172.30.250.1',
    }] },
    ...overrides,
  });
  const dependenciesFor = (networks) => passingDependencies((command, args) => {
    if (command === 'docker' && args[0] === 'network' && args[1] === 'ls' && args.includes('--quiet')) {
      return { status: 0, stdout: networks.map((_, index) => `network-${index}`).join('\n'), stderr: '' };
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
      return { status: 0, stdout: JSON.stringify(networks), stderr: '' };
    }
    return null;
  }).dependencies;
  try {
    const preservedBeforeEdgeRepair = await runPersonalServerPreflight(
      { repositoryRoot, stateRoot, resumeFailed: true },
      dependenciesFor([network(false)]),
    );
    assert.equal(
      preservedBeforeEdgeRepair.checks.find(({ id }) => id === 'network.personal-subnet')?.status,
      'passed',
    );

    const valid = await runPersonalServerPreflight({ repositoryRoot, stateRoot, resumeFailed: true }, dependenciesFor([network(false), network(true)]));
    assert.equal(valid.checks.find(({ id }) => id === 'network.personal-subnet')?.status, 'passed');

    const invalid = await runPersonalServerPreflight({ repositoryRoot, stateRoot, resumeFailed: true }, dependenciesFor([
      network(false), network(true, { Internal: true }),
    ]));
    assert.equal(invalid.checks.find(({ id }) => id === 'network.personal-subnet')?.status, 'failed');
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('Tailscale HTTPS origin must exactly match the connected local identity', async () => {
  const stateRoot = join(tmpdir(), `charitypilot-preflight-${process.pid}-tailnet`);
  rmSync(stateRoot, { recursive: true, force: true });
  const { dependencies } = passingDependencies();
  const passed = await runPersonalServerPreflight({
    repositoryRoot,
    stateRoot,
    origin: 'https://charitypilot.example.ts.net',
  }, dependencies);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.checks.find((check) => check.id === 'access.tailscale')?.status, 'passed');
  assert.equal(passed.checks.find((check) => check.id === 'access.tailscale-serve-safe')?.details.mode, 'empty');

  const { dependencies: mismatchDependencies } = passingDependencies((command) => (
    command === 'tailscale.exe'
      ? { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'other.example.ts.net.', Online: true } }), stderr: '' }
      : null
  ));
  const failed = await runPersonalServerPreflight({
    repositoryRoot,
    stateRoot,
    origin: 'https://charitypilot.example.ts.net',
  }, mismatchDependencies);
  assert.ok(failed.failures.some((failure) => failure.id === 'access.tailscale'));
});
