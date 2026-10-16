import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  linkSync,
  unlinkSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  loadManagedApiRuntime,
  parseManagedApiImagePin,
  readManagedApiTlsMaterial,
} from '../services/managed-api-runtime.js';

test('legacy API startup has no managed file dependency; partial opt-in never falls back', () => {
  assert.equal(loadManagedApiRuntime({ NODE_ENV: 'production' }), null);
  for (const env of [
    { CHARITYPILOT_MANAGED_PROVIDER: '' },
    { CHARITYPILOT_MANAGED_PROVIDER: 'render' },
    { CHARITYPILOT_MANAGED_API_PEER_BINDING: '{}' },
    { CHARITYPILOT_MANAGED_API_TLS_DIRECTORY: '/missing' },
  ]) {
    assert.throws(
      () => loadManagedApiRuntime({ NODE_ENV: 'production', ...env }),
      /^Error: Managed API runtime refused$/,
    );
  }
});
test('image metadata rejects disabled, malformed, duplicate and extra fields for managed startup', () => {
  const pin = {
    format: 1,
    sourceSha: '1'.repeat(40),
    bindingSha256: '2'.repeat(64),
  };
  assert.deepEqual(parseManagedApiImagePin(JSON.stringify(pin) + '\n'), pin);
  for (const value of [
    JSON.stringify({ ...pin, bindingSha256: null }),
    JSON.stringify({ ...pin, format: 2 }),
    JSON.stringify({ ...pin, sourceSha: 'main' }),
    JSON.stringify({ ...pin, extra: true }),
    JSON.stringify(pin) + ' ',
    JSON.stringify(pin).replace('"format":1', '"format":1,"format":1'),
    'x'.repeat(513),
  ])
    assert.throws(() => parseManagedApiImagePin(value));
});
test(
  'Linux protected material reader refuses writable, shared, linked or oversized keys',
  {
    skip:
      process.platform !== 'linux'
        ? 'requires actual Linux ownership/mode semantics'
        : false,
  },
  () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'charitypilot-managed-material-'),
    );
    const material = join(directory, 'tls');
    try {
      mkdirSync(material, { mode: 0o700 });
      for (const file of ['issuer.pem', 'server.pem', 'server.key'])
        writeFileSync(join(material, file), 'synthetic-only', { mode: 0o400 });
      assert.equal(
        readManagedApiTlsMaterial(material).serverKeyPem,
        'synthetic-only',
      );
      const key = join(material, 'server.key'),
        backup = join(material, 'key-backup');
      linkSync(key, backup);
      assert.throws(() => readManagedApiTlsMaterial(material));
      unlinkSync(backup);
      renameSync(key, backup);
      symlinkSync(backup, key);
      assert.throws(() => readManagedApiTlsMaterial(material));
      unlinkSync(key);
      renameSync(backup, key);
      chmodSync(join(material, 'server.key'), 0o644);
      assert.throws(() => readManagedApiTlsMaterial(material));
      chmodSync(join(material, 'server.key'), 0o400);
      chmodSync(material, 0o755);
      assert.throws(() => readManagedApiTlsMaterial(material));
      chmodSync(material, 0o700);
      const link = join(directory, 'linked');
      symlinkSync(material, link);
      assert.throws(() => readManagedApiTlsMaterial(link));
      chmodSync(join(material, 'server.key'), 0o600);
      writeFileSync(join(material, 'server.key'), 'x'.repeat(16385));
      chmodSync(join(material, 'server.key'), 0o400);
      assert.throws(() => readManagedApiTlsMaterial(material));
    } finally {
      const target = resolve(directory);
      assert.ok(
        target.startsWith(resolve(tmpdir()) + sep) &&
          basename(target).startsWith('charitypilot-managed-material-'),
      );
      rmSync(target, { recursive: true, force: true });
    }
  },
);
