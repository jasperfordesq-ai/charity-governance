import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedWebApiBinding,
  getManagedWebApiContext,
  getServerApiBaseUrl,
} from './server-api-config.server';

function fixture() {
  const record = {
    format: 2,
    provider: 'render',
    region: 'frankfurt',
    installationId: 'synthetic-installation',
    ownerId: 'tea-synthetic',
    environmentId: 'env-synthetic',
    sourceSha: '1'.repeat(40),
    publicOrigin: 'https://managed.charitypilot.test',
    gatewayServiceId: 'srv-' + 'a'.repeat(20),
    webServiceId: 'srv-' + 'b'.repeat(20),
    apiServiceId: 'srv-' + 'c'.repeat(20),
    schedulerServiceId: 'srv-' + 'd'.repeat(20),
    apiServiceName: 'charitypilot-review-api',
    apiOrigin: 'https://charitypilot-review-api-ab12:3002',
    webServiceName:'charitypilot-review-web',webOrigin:'https://charitypilot-review-web-cd34:3003',issuerCertSha256:'2'.repeat(64),apiCertSha256:'3'.repeat(64),webCertSha256:'4'.repeat(64),gatewayClientCertSha256:'5'.repeat(64),webClientCertSha256:'6'.repeat(64),
  };
  const binding = createManagedWebApiBinding(record);
  const env = {
    NODE_ENV: 'production', PORT:'3003',
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'public-production',
    NEXT_PUBLIC_API_URL: record.publicOrigin,
    NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN: record.publicOrigin,
    NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256: binding.sha256,
    CHARITYPILOT_MANAGED_PROVIDER: 'render',
    CHARITYPILOT_MANAGED_WEB_BINDING: binding.json,
    CHARITYPILOT_INTERNAL_API_URL: record.apiOrigin,
    CHARITYPILOT_BUILD_COMMIT: record.sourceSha,
    RENDER_SERVICE_ID: record.webServiceId,
    RENDER_SERVICE_TYPE: 'pserv',
  };
  const built = {
    apiOrigin: record.publicOrigin,
    canonicalApiOrigin: record.publicOrigin,
    deploymentMode: 'public-production',
    bindingSha256: binding.sha256,
  };
  return { record, binding, env, built };
}

test('managed server origin requires the exact build-pinned record and private web identity', () => {
  const f = fixture();
  assert.equal(getServerApiBaseUrl(f.env, f.built), f.record.apiOrigin);
  assert.equal(
    getManagedWebApiContext(f.env, f.built)?.publicOrigin,
    f.record.publicOrigin,
  );
  assert.throws(() => getServerApiBaseUrl(f.env));
});

test('managed identity, source, profile, runtime URL and compiled public values cannot diverge', () => {
  const f = fixture();
  for (const change of [
    { NODE_ENV: 'development' },
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' },
    { NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: 'local-disposable' },
    { CHARITYPILOT_MANAGED_PROVIDER: 'other' },
    { RENDER_SERVICE_ID: f.record.apiServiceId },
    { RENDER_SERVICE_TYPE: 'web' },
    { CHARITYPILOT_BUILD_COMMIT: '2'.repeat(40) },
    {
      CHARITYPILOT_INTERNAL_API_URL: 'http://charitypilot-review-api-ef34:3002',
    },
    { NEXT_PUBLIC_API_URL: 'https://other.example' },
    { NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256: '2'.repeat(64) },
  ]) {
    assert.throws(() => getServerApiBaseUrl({ ...f.env, ...change }, f.built));
  }
  for (const change of [
    { apiOrigin: 'https://other.example' },
    { canonicalApiOrigin: 'https://other.example' },
    { deploymentMode: 'personal-server' },
    { bindingSha256: '2'.repeat(64) },
  ]) {
    assert.throws(() => getServerApiBaseUrl(f.env, { ...f.built, ...change }));
  }
});

test('partial, noncanonical, tampered and oversized managed records never fall back to a public origin', () => {
  const f = fixture();
  for (const value of [
    '',
    f.binding.json + ' ',
    f.binding.json.replace('ab12', 'ef34'),
    '{}',
    'x'.repeat(8193),
    f.binding.json.replace('"format":2', '"format":2,"format":2'),
  ]) {
    assert.throws(
      () =>
        getServerApiBaseUrl(
          { ...f.env, CHARITYPILOT_MANAGED_WEB_BINDING: value },
          f.built,
        ),
      (error) =>
        error instanceof Error &&
        !error.message.includes('synthetic') &&
        !error.message.includes('ab12') &&
        error.cause === undefined,
    );
  }
  const missing = { ...f.env };
  delete (missing as Partial<typeof missing>).CHARITYPILOT_MANAGED_WEB_BINDING;
  assert.throws(() => getServerApiBaseUrl(missing, f.built));
  assert.throws(() =>
    getServerApiBaseUrl({
      NODE_ENV: 'production',
      CHARITYPILOT_MANAGED_PROVIDER: 'render',
    }),
  );
});

test('managed record creation refuses network destinations and incomplete/ambiguous topology', () => {
  const f = fixture();
  for (const apiOrigin of [
    'http://127.0.0.1:3002',
    'http://169.254.169.254:3002',
    'http://api-blue:3002',
    'http://charitypilot-review-api-ab12.attacker.example:3002',
    'http://charitypilot-review-api-ab12:3002',
    'http://user:password@charitypilot-review-api-ab12:3002',
    'http://charitypilot-review-api-ab12:3002/path',
    'http://charitypilot-review-api-ab12:3002/',
    'http://charitypilot-review-api-ab12:3002?query=1',
    'http://charitypilot-review-api-ab12:3002#hash',
    'http://charitypilot-review-api-ab12-discovery:3002',
  ]) {
    assert.throws(() => createManagedWebApiBinding({ ...f.record, apiOrigin }));
  }
  for (const change of [
    { format: 1 },
    { provider: 'other' },
    { region: 'oregon' },
    { webServiceId: f.record.apiServiceId },
    { publicOrigin: 'http://localhost:3003' },
    { publicOrigin: 'https://user:password@managed.charitypilot.test' },
    { sourceSha: 'main' },
    { unknown: 'ignored' },
  ]) {
    assert.throws(() => createManagedWebApiBinding({ ...f.record, ...change }));
  }
});

test('unconfigured existing server origins keep their established profile contracts', () => {
  assert.equal(
    getServerApiBaseUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
    }),
    'https://api.charitypilot.ie',
  );
  assert.equal(getManagedWebApiContext({ NODE_ENV: 'development' }), null);
  assert.throws(() =>
    getServerApiBaseUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
      CHARITYPILOT_INTERNAL_API_URL: 'http://charitypilot-review-api-ab12:3002',
    }),
  );
});
