import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decodeIntegrationKey,
  integrationKeyFingerprint,
  openIntegrationSecret,
  sealIntegrationSecret,
} from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);

test('a sealed secret round-trips through the same key', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  assert.equal(openIntegrationSecret(sealed, key), 'atlassian-refresh-token');
});

test('the envelope records its generation and never contains the plaintext', () => {
  const sealed = sealIntegrationSecret('super-secret-value', key, 7);
  assert.equal(sealed.generation, 7);
  const serialised = JSON.stringify(sealed);
  assert.equal(serialised.includes('super-secret-value'), false);
});

test('sealing the same plaintext twice produces different ciphertext', () => {
  const a = sealIntegrationSecret('same', key, 1);
  const b = sealIntegrationSecret('same', key, 1);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.iv, b.iv);
});

test('opening with the wrong key fails and does not leak the material', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  assert.throws(
    () => openIntegrationSecret(sealed, otherKey),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      assert.equal((err as AppError).message.includes('atlassian-refresh-token'), false);
      return true;
    },
  );
});

test('a tampered ciphertext is rejected rather than decrypted', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  const flipped = Buffer.from(sealed.ciphertext, 'base64');
  flipped[0] ^= 0xff;
  const tampered = { ...sealed, ciphertext: flipped.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key), (err) => {
    assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
    return true;
  });
});

test('a tampered auth tag is rejected', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  const flipped = Buffer.from(sealed.tag, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(
    () => openIntegrationSecret({ ...sealed, tag: flipped.toString('base64') }, key),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      return true;
    },
  );
});

test('the fingerprint is stable, 64 hex characters, and differs per key', () => {
  const fingerprint = integrationKeyFingerprint(key);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, integrationKeyFingerprint(key));
  assert.notEqual(fingerprint, integrationKeyFingerprint(otherKey));
});

test('decodeIntegrationKey accepts hex and base64url, and rejects short keys', () => {
  assert.equal(decodeIntegrationKey(key.toString('hex')).equals(key), true);
  assert.equal(decodeIntegrationKey(key.toString('base64url')).equals(key), true);
  assert.throws(
    () => decodeIntegrationKey(randomBytes(16).toString('hex')),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      return true;
    },
  );
});
