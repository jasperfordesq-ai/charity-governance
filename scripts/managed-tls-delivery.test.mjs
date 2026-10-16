import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayTlsFixture } from './managed-gateway-tls-fixture.mjs';
import {
  prepareManagedTlsBundle,
  stageManagedTlsDelivery,
} from '../packages/shared/runtime/managed-tls-delivery.mjs';

import {
  mkdtempSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedRegularDescriptor } from '../packages/shared/runtime/protected-tls-material.mjs';
test('service bundles contain only their own pinned identities; malformed or cross-service material refuses', () => {
  const f = gatewayTlsFixture();
  try {
    for (const service of ['gateway', 'api', 'web']) {
      const bundle = {
        format: 1,
        service,
        meshSha256: f.binding.sha256,
        issuerCertPem: f.issuer,
      };
      if (service !== 'gateway')
        Object.assign(bundle, {
          serverCertPem: f[service].cert,
          serverKeyPem: f[service].key,
        });
      if (service !== 'api') {
        const leaf = service === 'gateway' ? f.gateway : f.webClient;
        Object.assign(bundle, {
          clientCertPem: leaf.cert,
          clientKeyPem: leaf.key,
        });
      }
      const raw = JSON.stringify(bundle) + '\n';
      for (const field of [
        'issuerCertPem',
        'serverCertPem',
        'serverKeyPem',
        'clientCertPem',
        'clientKeyPem',
      ]) {
        if (typeof bundle[field] === 'string')
          assert.throws(() =>
            prepareManagedTlsBundle(
              JSON.stringify({
                ...bundle,
                [field]: bundle[field] + f.foreign.key,
              }) + '\n',
              service,
              f.binding.record,
            ),
          );
      }
      assert.ok(prepareManagedTlsBundle(raw, service, f.binding.record));
      for (const value of [
        JSON.stringify(bundle),
        JSON.stringify({ ...bundle, extra: true }) + '\n',
        JSON.stringify({ ...bundle, service: 'scheduler' }) + '\n',
        JSON.stringify({ ...bundle, meshSha256: '0'.repeat(64) }) + '\n',
        JSON.stringify({ ...bundle, issuerCertPem: f.foreign.cert }) + '\n',
      ])
        assert.throws(() =>
          prepareManagedTlsBundle(value, service, f.binding.record),
        );
      if (service !== 'api')
        assert.throws(() =>
          prepareManagedTlsBundle(
            JSON.stringify({
              ...bundle,
              clientCertPem: f.foreign.cert,
              clientKeyPem: f.foreign.key,
            }) + '\n',
            service,
            f.binding.record,
          ),
        );
    }
    assert.equal(stageManagedTlsDelivery('api', {}), null);
    assert.throws(() =>
      stageManagedTlsDelivery('api', { CHARITYPILOT_MANAGED_TLS_DELIVERY: '' }),
    );
  } finally {
    f.cleanup();
  }
});
test('delivery readers reject malformed UTF-8 instead of changing the secret bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-delivery-utf8-')),
    path = join(root, 'invalid');
  let fd;
  try {
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    fd = openSync(path, 'r');
    assert.throws(() => readBoundedRegularDescriptor(fd, 100));
    closeSync(fd);
    fd = undefined;
    writeFileSync(
      path,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')]),
    );
    fd = openSync(path, 'r');
    const decoded = readBoundedRegularDescriptor(fd, 100);
    assert.equal(decoded.charCodeAt(0), 0xfeff);
    assert.throws(() => JSON.parse(decoded));
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkSync(path);
    rmdirSync(root);
  }
});
