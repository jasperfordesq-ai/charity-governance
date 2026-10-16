import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedServiceMeshBinding } from '../packages/shared/runtime/managed-service-mesh.mjs';
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
test('one canonical v2 record binds all four services and five distinct TLS identities', () => {
  const a = createManagedServiceMeshBinding(record),
    b = createManagedServiceMeshBinding(
      Object.fromEntries(Object.entries(record).reverse()),
    );
  assert.equal(a.json, b.json);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.record.apiOrigin, record.apiOrigin);
  assert.ok(Object.isFrozen(a.record));
});
test('HTTP, old records, ambiguous identities and config injection cannot produce a mesh pin', () => {
  for (const change of [
    { format: 1 },
    { apiOrigin: record.apiOrigin.replace('https:', 'http:') },
    { webOrigin: record.webOrigin + '/' },
    { webCertSha256: record.apiCertSha256 },
    { webServiceId: record.apiServiceId },
    { apiOrigin: 'https://127.0.0.1:3002' },
    { webOrigin: 'https://charitypilot-review-web-cd34.attacker.example:3003' },
    { publicOrigin: 'https://user:pass@managed.charitypilot.test' },
    { apiServiceName: 'charitypilot-review-api\nadmin :2019' },
    { extra: 'ignored' },
  ])
    assert.throws(() =>
      createManagedServiceMeshBinding({ ...record, ...change }),
    );
});
