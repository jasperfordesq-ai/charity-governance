import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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

// Each of these differs from `context` in exactly ONE field, so each one
// proves that field is actually framed into the AAD. `otherContext` alone
// only exercises organisationId: drop the provider and kind frames from
// buildAad entirely and every other test in this file still passes.
const otherProviderContext: SecretContext = {
  organisationId: 'org_1',
  provider: 'xero',
  kind: 'oauth_refresh_token',
};

const otherKindContext: SecretContext = {
  organisationId: 'org_1',
  provider: 'atlassian',
  kind: 'oauth_access_token',
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

test('opening under a different provider fails closed', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.throws(() => openIntegrationSecret(sealed, key, otherProviderContext), assertUnreadable);
});

test('opening under a different credential kind fails closed', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  assert.throws(() => openIntegrationSecret(sealed, key, otherKindContext), assertUnreadable);
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

test('an iv of the wrong length is rejected', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);
  // The tampered-iv test above flips a byte but keeps the length at 12, so it
  // never reaches the `iv.length !== IV_BYTES` branch. These do.
  const iv = Buffer.from(sealed.iv, 'base64');
  assert.equal(iv.length, 12);
  for (const resized of [iv.subarray(0, 11), Buffer.concat([iv, Buffer.alloc(1)]), Buffer.alloc(0)]) {
    assert.notEqual(resized.length, 12);
    const tampered = { ...sealed, iv: resized.toString('base64') };
    assert.throws(() => openIntegrationSecret(tampered, key, context), assertUnreadable);
  }
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

// The `authTagLength: 16` option passed to createDecipheriv in
// openIntegrationSecret is NOT reachable through the public API: the explicit
// `tag.length !== TAG_BYTES` check strictly dominates it. Every tag that is not
// 16 bytes is rejected before createDecipheriv is ever called, and every tag
// that is 16 bytes satisfies `authTagLength: 16`, so no input can make that
// option the layer that decides. The test above therefore proves only that
// *something* rejected the short tag. This test pins the premise that makes the
// option worth keeping anyway — that without it, this Node/OpenSSL build really
// does authenticate against a truncated tag — so a future refactor that removes
// the explicit check cannot quietly also remove the option.
test('the authTagLength option is what stops a truncated tag once the explicit check is gone', () => {
  const iv = randomBytes(12);
  const aad = Buffer.from('aad');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update('atlassian-refresh-token', 'utf8'), cipher.final()]);
  const truncatedTag = cipher.getAuthTag().subarray(0, 4);

  // Without the option: the 4-byte tag is accepted and the plaintext recovered,
  // collapsing forgery resistance from 2^128 to roughly 2^32.
  const permissive = createDecipheriv('aes-256-gcm', key, iv);
  permissive.setAAD(aad);
  permissive.setAuthTag(truncatedTag);
  assert.equal(
    Buffer.concat([permissive.update(ciphertext), permissive.final()]).toString('utf8'),
    'atlassian-refresh-token',
  );

  // With the option — exactly how openIntegrationSecret builds its decipher —
  // the short tag is refused outright.
  assert.throws(() => {
    const strict = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    strict.setAAD(aad);
    strict.setAuthTag(truncatedTag);
  }, /authentication tag length/i);
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

test('an invalid context fails the same, loud way in both seal and open', () => {
  const invalidContexts = [
    { organisationId: '', provider: 'atlassian', kind: 'oauth_refresh_token' },
    { organisationId: 'org_1', provider: undefined, kind: 'oauth_refresh_token' },
    { organisationId: 'org_1', provider: 'atlassian', kind: 42 },
  ] as unknown as SecretContext[];

  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);

  for (const invalid of invalidContexts) {
    for (const call of [
      () => sealIntegrationSecret('atlassian-refresh-token', key, 1, invalid),
      () => openIntegrationSecret(sealed, key, invalid),
    ]) {
      assert.throws(call, (err) => {
        // A programming error, never a raw TypeError from seal and never
        // misreported as a charity's credential being corrupt from open.
        assert.equal(err instanceof AppError, true);
        assert.equal((err as AppError).code, 'INTEGRATION_SECRET_CONTEXT_INVALID');
        assert.notEqual((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
        return true;
      });
    }
  }
});

test('openIntegrationSecret rejects a generation that is not a non-negative integer', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1, context);

  // Includes the string-vs-number case, which the AAD's String(generation)
  // would otherwise let through unnoticed.
  for (const badGeneration of [-1, 1.5, NaN, '1']) {
    assert.throws(
      () => openIntegrationSecret({ ...sealed, generation: badGeneration } as never, key, context),
      (err) => {
        assert.equal((err as AppError).code, 'INTEGRATION_SECRET_GENERATION_INVALID');
        assert.notEqual((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
        return true;
      },
    );
  }
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
