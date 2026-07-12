import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  certify,
  exactLoopbackOrigin,
  parseComposePs,
  parseEnvironment,
  parseOptions,
  validateBundleIdentity,
  validateComposeRuntime,
  validateEnvironment,
  validatePersonalServerRuntimeNetwork,
  validatePersonalServerServiceNetworkAttachments,
  validateTailscalePrivateAccess,
} from './personal-server-certify.mjs';

const validEnvironment = {
  CHARITYPILOT_PERSONAL_SERVER_ORIGIN: 'http://localhost:8080',
  CHARITYPILOT_PERSONAL_SERVER_PORT: '8080',
  POSTGRES_DB: 'charitypilot',
  POSTGRES_USER: 'charitypilot',
  POSTGRES_PASSWORD: 'database-secret-value',
  JWT_SECRET: 'jwt-secret-value',
  READINESS_API_KEY: 'readiness-secret-value',
};

function service(Service, Publishers = []) {
  return { Service, State: 'running', Health: 'healthy', Publishers };
}

test('certification options are bounded and reject duplicates', () => {
  assert.deepEqual(parseOptions(['--local-only', '--env-file=state.env']), {
    'local-only': true,
    'env-file': 'state.env',
  });
  assert.throws(() => parseOptions(['--local-only', '--local-only']), /Duplicate/u);
  assert.throws(() => parseOptions(['--invented']), /Unknown/u);
  assert.throws(() => parseOptions(['--report-file']), /Missing/u);
});

test('environment parser rejects malformed and duplicate state', () => {
  assert.deepEqual(parseEnvironment('A=one\nB="two"\n'), { A: 'one', B: 'two' });
  assert.throws(() => parseEnvironment('A=one\nA=two\n'), /Duplicate/u);
  assert.throws(() => parseEnvironment('not-an-env-line\n'), /malformed/u);
});

test('local-only runtime health accepts only exact loopback HTTP with a matching port', () => {
  assert.equal(exactLoopbackOrigin('http://localhost:8080'), true);
  assert.equal(exactLoopbackOrigin('http://127.0.0.1:8080'), true);
  assert.equal(exactLoopbackOrigin('http://[::1]:8080'), false);
  assert.equal(exactLoopbackOrigin('http://localhost:8080/extra'), false);
  assert.deepEqual(validateEnvironment(validEnvironment, { localOnly: true }), {
    origin: 'http://localhost:8080',
    port: 8080,
    loopback: true,
  });
  assert.throws(
    () => validateEnvironment({ ...validEnvironment, CHARITYPILOT_PERSONAL_SERVER_ORIGIN: 'https://host.tail.example' }, { localOnly: true }),
    /local-only/u,
  );
  assert.throws(
    () => validateEnvironment({ ...validEnvironment, CHARITYPILOT_PERSONAL_SERVER_PORT: '8081' }, { localOnly: true }),
    /must match/u,
  );
  assert.throws(
    () => validateEnvironment({ ...validEnvironment, CHARITYPILOT_PERSONAL_SERVER_ORIGIN: 'https://public.example.com' }),
    /Tailscale/u,
  );
});

test('private access requires the exact Tailscale node, one HTTPS proxy, and no Funnel', () => {
  const node = { BackendState: 'Running', Self: { DNSName: 'charity-host.example.ts.net.' } };
  const serve = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      'charity-host.example.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } },
      },
    },
  };
  const result = validateTailscalePrivateAccess(node, serve, 'https://charity-host.example.ts.net', 8080);
  assert.equal(result.funnelDisabled, true);
  assert.match(result.hostnameSha256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => validateTailscalePrivateAccess(node, { ...serve, AllowFunnel: { 'charity-host.example.ts.net:443': true } }, 'https://charity-host.example.ts.net', 8080),
    /Funnel/u,
  );
  const wrongProxy = structuredClone(serve);
  wrongProxy.Web['charity-host.example.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
  assert.throws(
    () => validateTailscalePrivateAccess(node, wrongProxy, 'https://charity-host.example.ts.net', 8080),
    /proxy only/u,
  );
});

test('compose runtime validation requires four healthy services and only one exact Caddy loopback port', () => {
  const rows = [
    service('db'),
    service('api'),
    service('web'),
    service('caddy', [{ URL: '127.0.0.1', TargetPort: 8080, PublishedPort: 8080 }]),
  ];
  assert.equal(validateComposeRuntime(rows, 8080).length, 4);
  assert.equal(parseComposePs(rows.map((row) => JSON.stringify(row)).join('\n')).length, 4);
  assert.throws(() => validateComposeRuntime(rows.filter(({ Service }) => Service !== 'api'), 8080), /Missing/u);
  assert.throws(
    () => validateComposeRuntime(rows.map((row) => row.Service === 'db' ? service('db', [{ URL: '0.0.0.0' }]) : row), 8080),
    /unexpectedly publishes/u,
  );
  assert.throws(
    () => validateComposeRuntime(rows.map((row) => row.Service === 'caddy' ? service('caddy', [{ URL: '0.0.0.0', TargetPort: 8080, PublishedPort: 8080 }]) : row), 8080),
    /exactly 127\.0\.0\.1/u,
  );
});

test('runtime network validation requires an internal application bridge and Caddy-only edge bridge', () => {
  const internalContainers = Object.fromEntries(
    ['api', 'caddy', 'db', 'web'].map((service) => [service, { Name: `charitypilot-personal-server-${service}-1` }]),
  );
  const network = ({ edge = false, containers = {} } = {}) => ({
    Name: edge ? 'charitypilot-personal-server-edge' : 'charitypilot-personal-server-internal',
    Driver: 'bridge',
    Internal: !edge,
    Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.network': edge ? 'personal-server-edge' : 'personal-server-internal',
    },
    IPAM: {
      Config: [{
        Subnet: edge ? '172.30.251.0/24' : '172.30.250.0/24',
        Gateway: edge ? '172.30.251.1' : '172.30.250.1',
      }],
    },
    Containers: containers,
  });
  assert.deepEqual(validatePersonalServerRuntimeNetwork(network({ containers: internalContainers }), 'internal'), {
    name: 'charitypilot-personal-server-internal', internal: true, subnet: '172.30.250.0/24',
  });
  const edge = network({ edge: true, containers: { caddy: { Name: 'charitypilot-personal-server-caddy-1' } } });
  assert.deepEqual(validatePersonalServerRuntimeNetwork(edge, 'edge'), {
    name: 'charitypilot-personal-server-edge', internal: false, subnet: '172.30.251.0/24',
  });
  assert.throws(
    () => validatePersonalServerRuntimeNetwork({ ...edge, Containers: {} }, 'edge'),
    /exact reviewed service attachments/u,
  );
  assert.throws(
    () => validatePersonalServerRuntimeNetwork({ ...edge, Containers: [] }, 'edge'),
    /malformed attachment metadata/u,
  );
  assert.throws(
    () => validatePersonalServerRuntimeNetwork({ ...edge, Internal: true }, 'edge'),
    /exact reviewed/u,
  );
  assert.throws(
    () => validatePersonalServerRuntimeNetwork({
      ...edge,
      Containers: {
        caddy: { Name: 'charitypilot-personal-server-caddy-1' },
        api: { Name: 'charitypilot-personal-server-api-1' },
      },
    }, 'edge'),
    /exact reviewed service attachments/u,
  );
  assert.throws(
    () => validatePersonalServerRuntimeNetwork(network({
      containers: { ...internalContainers, foreign: { Name: 'foreign-container' } },
    }), 'internal'),
    /exact reviewed service attachments/u,
  );
  assert.throws(
    () => validatePersonalServerRuntimeNetwork(network({
      containers: Object.fromEntries(Object.entries(internalContainers).filter(([service]) => service !== 'web')),
    }), 'internal'),
    /exact reviewed service attachments/u,
  );
  for (const invalid of [
    { ...edge, Labels: { ...edge.Labels, 'com.docker.compose.network': 'other' } },
    { ...edge, IPAM: { Config: [{ Subnet: '172.30.252.0/24', Gateway: '172.30.251.1' }] } },
    { ...edge, IPAM: { Config: [{ Subnet: '172.30.251.0/24', Gateway: '172.30.251.254' }] } },
  ]) {
    assert.throws(() => validatePersonalServerRuntimeNetwork(invalid, 'edge'), /exact reviewed/u);
  }
});

test('runtime service containers reject missing, extra, or expanded network attachments', () => {
  const container = (service, networks) => ({
    Name: `/charitypilot-personal-server-${service}-1`,
    Config: { Labels: { 'com.docker.compose.project': 'charitypilot-personal-server', 'com.docker.compose.service': service } },
    NetworkSettings: { Networks: networks },
  });
  const internal = { IPAddress: '172.30.250.2', GwPriority: 0 };
  assert.deepEqual(validatePersonalServerServiceNetworkAttachments(container('api', {
    'charitypilot-personal-server-internal': internal,
  }), 'api'), ['charitypilot-personal-server-internal']);
  assert.deepEqual(validatePersonalServerServiceNetworkAttachments(container('caddy', {
    'charitypilot-personal-server-internal': { IPAddress: '172.30.250.10', GwPriority: 0 },
    'charitypilot-personal-server-edge': { IPAddress: '172.30.251.2', GwPriority: 1 },
  }), 'caddy'), ['charitypilot-personal-server-edge', 'charitypilot-personal-server-internal']);
  assert.throws(() => validatePersonalServerServiceNetworkAttachments(container('api', {
    'charitypilot-personal-server-internal': internal,
    'charitypilot-personal-server-edge': { IPAddress: '172.30.251.3', GwPriority: 1 },
  }), 'api'), /exact reviewed network set/u);
  assert.throws(() => validatePersonalServerServiceNetworkAttachments(container('caddy', {
    'charitypilot-personal-server-internal': { IPAddress: '172.30.250.10', GwPriority: 0 },
    'charitypilot-personal-server-edge': { IPAddress: '172.30.251.2', GwPriority: 1 },
    'personal-server-extra': { IPAddress: '172.30.252.2', GwPriority: 0 },
  }), 'caddy'), /exact reviewed network set/u);
  assert.throws(() => validatePersonalServerServiceNetworkAttachments(container('caddy', {
    'charitypilot-personal-server-internal': { IPAddress: '172.30.250.9', GwPriority: 0 },
    'charitypilot-personal-server-edge': { IPAddress: '172.30.251.2', GwPriority: 1 },
  }), 'caddy'), /internal IPv4/u);
  assert.throws(() => validatePersonalServerServiceNetworkAttachments(container('caddy', {
    'charitypilot-personal-server-internal': { IPAddress: '172.30.250.10', GwPriority: 0 },
    'charitypilot-personal-server-edge': { IPAddress: '172.30.251.2', GwPriority: 0 },
  }), 'caddy'), /malformed .*edge/u);
});

test('release bundle identities are exact and source-bound', () => {
  assert.deepEqual(validateBundleIdentity({
    format: 'charitypilot-personal-server-bundle/v1',
    profile: 'personal-server',
    tag: 'personal-v1.2.3',
    commitSha: 'a'.repeat(40),
    commitTime: '2026-07-12T00:00:00Z',
  }), {
    kind: 'release-bundle',
    tag: 'personal-v1.2.3',
    commitSha: 'a'.repeat(40),
    commitTime: '2026-07-12T00:00:00Z',
  });
  assert.throws(() => validateBundleIdentity({
    format: 'charitypilot-personal-server-bundle/v1',
    profile: 'personal-server',
    tag: 'v1.2.3',
    commitSha: 'a'.repeat(40),
    commitTime: '2026-07-12T00:00:00Z',
  }), /tag/u);
});

test('live certification orchestration inspects both networks and every exact service container', async () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-certify-live-'));
  const envPath = join(root, '.env.personal-server');
  writeFileSync(envPath, `${Object.entries(validEnvironment).map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  const calls = [];
  const composeEnvironments = [];
  const services = ['api', 'caddy', 'db', 'web'];
  const internalContainers = Object.fromEntries(
    services.map((service) => [service, { Name: `charitypilot-personal-server-${service}-1` }]),
  );
  const network = (edge) => ({
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
    Containers: edge ? { caddy: internalContainers.caddy } : internalContainers,
  });
  const container = (service) => ({
    Name: `/charitypilot-personal-server-${service}-1`,
    Config: { Labels: {
      'com.docker.compose.project': 'charitypilot-personal-server',
      'com.docker.compose.service': service,
    } },
    NetworkSettings: { Networks: service === 'caddy' ? {
      'charitypilot-personal-server-internal': { IPAddress: '172.30.250.10', GwPriority: 0 },
      'charitypilot-personal-server-edge': { IPAddress: '172.30.251.2', GwPriority: 1 },
    } : {
      'charitypilot-personal-server-internal': {
        IPAddress: `172.30.250.${service === 'db' ? 2 : service === 'api' ? 3 : 4}`,
        GwPriority: 0,
      },
    } },
  });
  const runImpl = (command, args, options) => {
    calls.push([command, ...args]);
    if (command !== 'docker') throw new Error(`Unexpected command ${command}`);
    if (args[0] === 'context') {
      return { stdout: 'npipe:////./pipe/dockerDesktopLinuxEngine|false\n' };
    }
    if (args[0] === 'info') return { stdout: 'Docker Desktop|linux\n' };
    if (args[0] === 'version') return { stdout: '1.54\n' };
    if (args[0] === 'compose') composeEnvironments.push(options.env);
    if (args[0] === 'compose' && args.includes('ps')) {
      return { stdout: [
        service('db'), service('api'), service('web'),
        service('caddy', [{ URL: '127.0.0.1', TargetPort: 8080, PublishedPort: 8080 }]),
      ].map((row) => JSON.stringify(row)).join('\n') };
    }
    if (args[0] === 'compose') return { stdout: '' };
    if (args[0] === 'network' && args[1] === 'inspect') {
      return { stdout: JSON.stringify([network(args[2].endsWith('-edge'))]) };
    }
    if (args[0] === 'inspect') {
      const selected = services.find((candidate) => args[1] === `charitypilot-personal-server-${candidate}-1`);
      if (!selected) throw new Error(`Unexpected container ${args[1]}`);
      return { stdout: JSON.stringify([container(selected)]) };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return { stdout: JSON.stringify([{ Name: args[2], Driver: 'local' }]) };
    }
    throw new Error(`Unexpected Docker arguments: ${args.join(' ')}`);
  };
  const privateHeaders = {
    'x-charitypilot-deployment': 'personal-server',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'content-security-policy': "default-src 'self'",
  };
  const fetchImpl = async (url) => url.endsWith('/api/v1/health/readiness')
    ? new Response(JSON.stringify({
      status: 'ready',
      checks: { database: true, storageConfigured: true, storageBucketReachable: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('login', { status: 200, headers: privateHeaders });
  try {
    const report = await certify({ 'env-file': envPath, 'local-only': true }, {
      repoRoot: root,
      processEnv: {
        COMPOSE_PROFILES: 'maintenance,personal-init',
        COMPOSE_PROJECT_NAME: 'hostile-project',
        compose_file: 'hostile-compose.yml',
        DOCKER_CONTEXT: 'desktop-linux',
      },
      runImpl,
      fetchImpl,
      sourceIdentityImpl: () => ({
        kind: 'clean-git', tag: null, commitSha: 'a'.repeat(40), commitTime: null,
        branch: 'master', canonicalRemote: true,
      }),
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });
    assert.equal(report.result, 'pass');
    assert.deepEqual(report.docker, { localDesktop: true, serverOs: 'linux', engineApi: '1.54' });
    assert.equal(report.generatedAt, '2026-07-12T12:00:00.000Z');
    assert.equal(report.services.length, 4);
    assert.equal(report.network.name, 'charitypilot-personal-server-internal');
    assert.equal(report.edgeNetwork.name, 'charitypilot-personal-server-edge');
    assert.equal(calls.filter((args) => args[1] === 'network' && args[2] === 'inspect').length, 2);
    assert.equal(calls.filter((args) => args[1] === 'inspect').length, 4);
    assert.ok(calls.filter((args) => args[1] === 'compose').every((args) => (
      args.includes('--project-name') && args.includes('charitypilot-personal-server')
    )));
    assert.ok(composeEnvironments.every((environment) => (
      Object.keys(environment).every((name) => !name.toUpperCase().startsWith('COMPOSE_')) &&
      environment.DOCKER_HOST === 'npipe:////./pipe/dockerDesktopLinuxEngine' &&
      !Object.hasOwn(environment, 'DOCKER_CONTEXT')
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime certification never contacts a remote endpoint discovered from context metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'charitypilot-certify-remote-boundary-'));
  const envPath = join(root, '.env.personal-server');
  writeFileSync(envPath, `${Object.entries(validEnvironment).map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  const calls = [];
  try {
    await assert.rejects(
      () => certify({ 'env-file': envPath, 'local-only': true }, {
        repoRoot: root,
        processEnv: {},
        runImpl: (command, args) => {
          calls.push([command, ...args]);
          if (command === 'docker' && args[0] === 'context') {
            return { stdout: 'ssh://remote.example|false\n' };
          }
          throw new Error(`Unexpected post-boundary command: ${command} ${args.join(' ')}`);
        },
        sourceIdentityImpl: () => ({
          kind: 'clean-git', tag: null, commitSha: 'a'.repeat(40), commitTime: null,
          branch: 'master', canonicalRemote: true,
        }),
      }),
      /local Windows Docker Desktop Linux named pipe/u,
    );
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['docker', 'context']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime-health dry-run is non-mutating and does not require an environment file', async () => {
  const result = await certify({ 'dry-run': true }, { repoRoot: 'Z:\\missing' });
  assert.equal(result.dryRun, true);
  assert.equal(result.format, 'charitypilot-personal-server-runtime-health/v1');
  assert.ok(result.planned.some((value) => value.includes('readiness')));
  assert.ok(result.planned.some((value) => value.includes('Caddy-only edge')));
  await assert.rejects(
    () => certify({ 'dry-run': true, 'report-file': 'relative.json' }, { repoRoot: 'Z:\\missing' }),
    /absolute/u,
  );
});
