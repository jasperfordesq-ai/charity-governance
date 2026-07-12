import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  AUTH_RECOVERY_KEY_VERSION,
  authRecoverySecretFingerprint,
  canonicalizePasswordRecoveryAddress,
  createPasswordRecoveryTokenMaterial,
  derivePasswordRecoveryRateDigest,
  derivePasswordRecoveryToken,
  hashPasswordRecoveryToken,
} = await import('../services/password-recovery-crypto.js');

const SECRET = Buffer.alloc(48, 0xa7).toString('base64url');
const OTHER_SECRET = Buffer.alloc(48, 0xb8).toString('base64url');
const REQUEST_ID = 'd8d9f463-67ce-49ef-a10f-8c9812ee7ac5';
const NONCE = '42'.repeat(32);

test('password recovery token derivation is deterministic, domain-separated, and stored only by hash', () => {
  const descriptor = {
    requestId: REQUEST_ID,
    tokenNonceHex: NONCE,
    tokenKeyVersion: AUTH_RECOVERY_KEY_VERSION,
  };
  const first = derivePasswordRecoveryToken(descriptor, SECRET);
  const second = derivePasswordRecoveryToken(descriptor, SECRET);
  const otherKey = derivePasswordRecoveryToken(descriptor, OTHER_SECRET);

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, otherKey);
  assert.match(hashPasswordRecoveryToken(first), /^[0-9a-f]{64}$/);
  assert.notEqual(hashPasswordRecoveryToken(first), first);
});

test('password recovery creates fresh nonce-bound material and accepts canonical 32-64 byte secrets', () => {
  const first = createPasswordRecoveryTokenMaterial(REQUEST_ID, SECRET);
  const second = createPasswordRecoveryTokenMaterial(REQUEST_ID, SECRET);

  assert.notEqual(first.tokenNonceHex, second.tokenNonceHex);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashPasswordRecoveryToken(first.token));
  assert.equal(first.tokenKeyVersion, AUTH_RECOVERY_KEY_VERSION);
  assert.throws(
    () => createPasswordRecoveryTokenMaterial(REQUEST_ID, 'recovery_not-canonical'),
    /AUTH_RECOVERY_SECRET/u,
  );
});

test('rate digests separate purposes and never expose canonical identifiers', () => {
  const identifier = 'owner@example.org';
  const identifierDigest = derivePasswordRecoveryRateDigest('forgot-identifier', identifier, SECRET);
  const tokenDigest = derivePasswordRecoveryRateDigest('reset-token', identifier, SECRET);

  assert.match(identifierDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(identifierDigest, tokenDigest);
  assert.equal(identifierDigest.includes(identifier), false);
});

test('root-key fingerprints are deterministic, domain-separated bindings without key disclosure', () => {
  const fingerprint = authRecoverySecretFingerprint(SECRET);
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(fingerprint, authRecoverySecretFingerprint(SECRET));
  assert.notEqual(fingerprint, authRecoverySecretFingerprint(OTHER_SECRET));
  assert.equal(fingerprint.includes(SECRET), false);
});

test('address canonicalization normalizes IPv4-mapped addresses and limits IPv6 at /64', () => {
  const mappedIpv4 = {
    exactAddress: '203.0.113.9',
    networkAddress: '203.0.113.9',
  };
  assert.deepEqual(canonicalizePasswordRecoveryAddress('::ffff:203.0.113.9'), mappedIpv4);
  assert.deepEqual(canonicalizePasswordRecoveryAddress('::ffff:cb00:7109'), mappedIpv4);
  assert.deepEqual(
    canonicalizePasswordRecoveryAddress('0000:0000:0000:0000:0000:ffff:cb00:7109'),
    mappedIpv4,
  );
  assert.deepEqual(canonicalizePasswordRecoveryAddress('2001:db8:12:34::99'), {
    exactAddress: '2001:0db8:0012:0034:0000:0000:0000:0099',
    networkAddress: '2001:0db8:0012:0034:0000:0000:0000:0000',
  });
  assert.throws(() => canonicalizePasswordRecoveryAddress('not-an-ip'), /valid IP address/u);
});
