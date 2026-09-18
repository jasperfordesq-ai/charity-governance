import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decodeIntegrationKey,
  integrationKeyFingerprint,
  openIntegrationSecret,
  sealIntegrationSecret,
  type SecretContext,
} from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);

const context: SecretContext = {
  organisationId: 'org_1',
  provider: 'atlassian',
  kind: 'oauth_refresh_token',
};

const otherContext: SecretContext = {
  organisationId: 'org_2',
  provider: 'atlassian',
  kind: 'oauth_refresh_token',
};

function assertUnreadable(err: unknown): true {
  assert.equal(err instanceof AppError, true);
  const appError = err as AppError;
  assert.equal(appError.code, 'INTEGRATION_SECRET_UNREADABLE');
  // The whole point of the swallowed catch is that nothing about the
  // failure — including the underlying Node/OpenSSL error — ever rides
  // along on the thrown error. A future `cause: err` would still pass a
  // test that only checks `.message`, so pin both `cause` and `details`.
  assert.equal(appError.cause, undefined);
  assert.equal(appError.details, undefined);
  return true;
}

test('a sealed secret round-trips through the same key and context', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.equal(openIntegrationSecret(sealed, key, context), 'atlassian-refresh-token');
});

test('the envelope records its generation and never contains the plaintext', () => {
  const sealed = sealIntegrationSecret('super-secret-value', key, 7, context);
  assert.equal(sealed.generation, 7);
  const serialised = JSON.stringify(sealed);
  assert.equal(serialised.includes('super-secret-value'), false);
});

test('sealing the same plaintext twice produces different ciphertext', () => {
  const a = sealIntegrationSecret('same', key, 1, context);
  const b = sealIntegrationSecret('same', key, 1, context);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.iv, b.iv);
});

test('opening with the wrong key fails and does not leak the material', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.throws(() => openIntegrationSecret(sealed, otherKey, context), (err) => {
    assertUnreadable(err);
    assert.equal((err as AppError).message.includes('atlassian-refresh-token'), false);
    return true;
  });
});

test('opening with a mismatched AAD context fails closed', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.throws(() => openIntegrationSecret(sealed, key, otherContext), assertUnreadable);
});

test('a tampered ciphertext is rejected rather than decrypted', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  const flipped = Buffer.from(sealed.ciphertext, 'base64');
  flipped[0] ^= 0xff;
  const tampered = { ...sealed, ciphertext: flipped.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
});

test('a tampered auth tag is rejected', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  const flipped = Buffer.from(sealed.tag, 'base64');
  flipped[0] ^= 0xff;
  const tampered = { ...sealed, tag: flipped.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
});

test('a tampered iv is rejected', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  const flipped = Buffer.from(sealed.iv, 'base64');
  flipped[0] ^= 0xff;
  const tampered = { ...sealed, iv: flipped.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
});

test('a tampered generation is rejected because it is bound into the AAD', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  const tampered = { ...sealed, generation: 2 };
  assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
});

test('a truncated auth tag is rejected rather than silently authenticating', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  const truncated = Buffer.from(sealed.tag, 'base64').subarray(0, 4);
  const tampered = { ...sealed, tag: truncated.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
});

test('sealing and opening with a key of the wrong length fail distinctly from a corrupted envelope', () => {
  const shortKey = randomBytes(16);

  assert.throws(
    () => sealIntegrationSecret('atlassian-refresh-token', shortKey, 1, context),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      return true;
    },
  );

  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.throws(
    () => openIntegrationSecret(sealed, shortKey, context),
    (err) => {
      // Must not be misreported as a corrupted/tampered credential.
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      assert.notEqual((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      return true;
    },
  );
});

test('sealIntegrationSecret rejects an empty plaintext', () => {
  assert.throws(
    () => sealIntegrationSecret('', key, 1, context),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_SECRET_PLAINTEXT_REQUIRED');
      return true;
    },
  );
});

test('sealIntegrationSecret rejects a generation that is not a non-negative integer', () => {
  for (const badGeneration of [-1, 1.5, NaN]) {
    assert.throws(
      () => sealIntegrationSecret('atlassian-refresh-token', key, badGeneration, context),
      (err) => {
        assert.equal((err as AppError).code, 'INTEGRATION_SECRET_GENERATION_INVALID');
        return true;
      },
    );
  }
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

test('decodeIntegrationKey rejects a 65-character hex string instead of silently truncating it', () => {
  const sixtyFiveChars = `${key.toString('hex')}a`;
  assert.equal(sixtyFiveChars.length, 65);
  assert.throws(
    () => decodeIntegrationKey(sixtyFiveChars),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      return true;
    },
  );
});

test('decodeIntegrationKey rejects a non-canonical base64url string with injected characters', () => {
  const canonical = key.toString('base64url');
  const withJunk = `${canonical.slice(0, 10)}!!${canonical.slice(10)}`;
  // Node's base64url decoder skips characters outside the alphabet, so this
  // still decodes to 32 bytes on length alone -- the round-trip check must
  // be what catches it.
  assert.equal(Buffer.from(withJunk, 'base64url').length, 32);
  assert.throws(
    () => decodeIntegrationKey(withJunk),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      return true;
    },
  );
});
