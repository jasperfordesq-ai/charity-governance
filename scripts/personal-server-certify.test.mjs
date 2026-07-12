import assert from 'node:assert/strict';
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

test('runtime-health dry-run is non-mutating and does not require an environment file', async () => {
  const result = await certify({ 'dry-run': true }, { repoRoot: 'Z:\\missing' });
  assert.equal(result.dryRun, true);
  assert.equal(result.format, 'charitypilot-personal-server-runtime-health/v1');
  assert.ok(result.planned.some((value) => value.includes('readiness')));
  await assert.rejects(
    () => certify({ 'dry-run': true, 'report-file': 'relative.json' }, { repoRoot: 'Z:\\missing' }),
    /absolute/u,
  );
});
