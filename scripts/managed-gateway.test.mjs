import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGatewayTlsMaterial } from '../caddy/managed/tls.mjs';
import { gatewayTlsFixture } from './managed-gateway-tls-fixture.mjs';
import { readFileSync } from 'node:fs';
import {
  createGatewayBinding,
  gatewayConfiguration,
} from '../caddy/managed/config.mjs';

function fixture() {
  const record = {
    format: 2,
    provider: 'render',
    region: 'frankfurt',
    installationId: 'synthetic',
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
    webServiceName: 'charitypilot-review-web',
    webOrigin: 'https://charitypilot-review-web-cd34:3003',
    issuerCertSha256: '2'.repeat(64),
    apiCertSha256: '3'.repeat(64),
    webCertSha256: '4'.repeat(64),
    gatewayClientCertSha256: '5'.repeat(64),
    webClientCertSha256: '6'.repeat(64),
  };
  const binding = createGatewayBinding(record);
  const env = {
    NODE_ENV: 'production',
    CHARITYPILOT_MANAGED_PROVIDER: 'render',
    CHARITYPILOT_MANAGED_GATEWAY_BINDING: binding.json,
    RENDER_SERVICE_ID: record.gatewayServiceId,
    RENDER_SERVICE_TYPE: 'web',
    CHARITYPILOT_BUILD_COMMIT: record.sourceSha,
    PORT: '10000',
  };
  return {
    record,
    binding,
    env,
    build: { sourceSha: record.sourceSha, bindingSha256: binding.sha256 },
  };
}

test('managed gateway generates exact API/web routes and canonical host headers', () => {
  const f = fixture(),
    config = gatewayConfiguration(
      f.env,
      f.build,
      '/tmp/charitypilot-gateway-synthetic',
    );
  assert.match(config, /path \/api\/v1 \/api\/v1\/\*/);
  assert.match(
    config,
    /reverse_proxy https:\/\/charitypilot-review-api-ab12:3002/,
  );
  assert.match(
    config,
    /reverse_proxy https:\/\/charitypilot-review-web-cd34:3003/,
  );
  assert.match(config, /host managed\.charitypilot\.test/);
  assert.match(config, /header_up Host managed\.charitypilot\.test/);
  assert.match(config, /respond "Not found" 404/);
  assert.doesNotMatch(config, /handle_path|trusted_proxies/);
});

test('gateway discards incoming proxy claims, logs no request object and has no admin listener', () => {
  const config = gatewayConfiguration(
    fixture().env,
    fixture().build,
    '/tmp/charitypilot-gateway-synthetic',
  );
  for (const header of [
    'Forwarded',
    'X-Forwarded-*',
    'X-Real-IP',
    'CF-Connecting-IP',
    'True-Client-IP',
    'X-CharityPilot-*',
  ]) {
    assert.ok(config.includes('request_header -' + header));
  }
  assert.ok(
    config.includes('header_up X-Forwarded-For {http.request.remote.host}'),
  );
  assert.ok(config.includes('header_up X-Forwarded-Proto https'));
  assert.match(config, /admin off/);
  assert.match(config, /request delete/);
  assert.doesNotMatch(config, /\n\s*log \{/); // no access logger added
});

test('gateway rejects altered identities, source and compiled pin before returning a config', () => {
  const f = fixture();
  for (const patch of [
    { NODE_ENV: 'development' },
    { CHARITYPILOT_MANAGED_PROVIDER: '' },
    { RENDER_SERVICE_ID: f.record.webServiceId },
    { RENDER_SERVICE_TYPE: 'pserv' },
    { CHARITYPILOT_BUILD_COMMIT: '2'.repeat(40) },
    { PORT: '10001' },
    { CHARITYPILOT_MANAGED_GATEWAY_BINDING: f.binding.json + ' ' },
    {
      CHARITYPILOT_MANAGED_GATEWAY_BINDING: f.binding.json.replace(
        'ab12',
        'ef56',
      ),
    },
    {
      CHARITYPILOT_MANAGED_GATEWAY_BINDING: f.binding.json.replace(
        '"format":2',
        '"format":2,"format":2',
      ),
    },
  ]) {
    assert.throws(
      () =>
        gatewayConfiguration(
          { ...f.env, ...patch },
          f.build,
          '/tmp/charitypilot-gateway-synthetic',
        ),
      /^Error: Managed gateway configuration refused$/,
    );
  }
  assert.throws(() =>
    gatewayConfiguration(
      f.env,
      { ...f.build, bindingSha256: '2'.repeat(64) },
      '/tmp/charitypilot-gateway-synthetic',
    ),
  );
});

test('gateway refuses incomplete or ambiguous topologies and network/config injection', () => {
  const f = fixture();
  for (const patch of [
    { webServiceId: f.record.apiServiceId },
    { format: 1 },
    { region: 'oregon' },
    { extra: 'ignored' },
    { apiOrigin: 'https://127.0.0.1:3002' },
    { apiOrigin: 'https://charitypilot-review-api-ab12.attacker.example:3002' },
    { apiOrigin: f.record.apiOrigin + '/' },
    { webOrigin: f.record.webOrigin + '/path' },
    { webOrigin: 'https://charitypilot-review-web-cd34:3002' },
    { webOrigin: 'https://user:password@charitypilot-review-web-cd34:3003' },
    { webServiceName: 'charitypilot-review-web\nrespond evil' },
    { publicOrigin: 'https://managed.charitypilot.test\nadmin :2019' },
    { publicOrigin: 'https://user:password@managed.charitypilot.test' },
  ]) {
    assert.throws(() => createGatewayBinding({ ...f.record, ...patch }));
  }
});

test('managed gateway image pins bases, uses unprivileged Node and copies only explicit source', () => {
  const image = readFileSync(
    new URL('../caddy/managed/Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(image, /FROM caddy:2-alpine@sha256:[a-f0-9]{64}/);
  assert.match(image, /FROM node:22-alpine@sha256:[a-f0-9]{64}/);
  assert.match(image, /USER node/);
  assert.match(image, /EXPOSE 10000/);
  assert.doesNotMatch(image, /npm install|apk add|COPY \. /);
});

test('gateway startup verifies the pinned issuer, client leaf and private key before using TLS files', () => {
  const f = gatewayTlsFixture();
  try {
    const files = {
      'issuer.pem': f.issuer,
      'client.pem': f.gateway.cert,
      'client.key': f.gateway.key,
    };
    assert.equal(verifyGatewayTlsMaterial(f.binding.record, files), files);
    for (const patch of [
      { 'client.key': f.api.key },
      { 'client.pem': f.api.cert },
      { 'issuer.pem': f.foreign.cert },
    ]) {
      assert.throws(
        () =>
          verifyGatewayTlsMaterial(f.binding.record, { ...files, ...patch }),
        /^Error: Managed gateway TLS material refused$/,
      );
    }
  } finally {
    f.cleanup();
  }
});
