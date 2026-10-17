import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { StorageSignedUploadIssuer } from '../services/storage-signed-upload-issuer.js';
import { publicSigningKeyFingerprint } from '../services/supabase-signing-key-control.js';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  jwk = pair.publicKey.export({ format: 'jwk' }),
  kid = 'storage:11111111-1111-4111-8111-111111111111';
const issuer = {
  providerKeyId: '11111111-1111-4111-8111-111111111111',
  tokenKid: kid,
  algorithm: 'ES256',
  fingerprint: publicSigningKeyFingerprint('ES256', jwk),
  publicJwk: jwk,
};
const path =
  'charitypilot-recovery-signed-probes/charitypilot-recovery-signed-probe/synthetic/test/old.txt';
const sign = (claims: object, options: jwt.SignOptions = {}) =>
  jwt.sign(claims, pair.privateKey, {
    algorithm: 'ES256',
    keyid: kid,
    expiresIn: 7200,
    ...options,
  });
test('signed-upload issuer verifies the pinned key, explicit upload scope, target and lifetime without returning credentials', () => {
  const service = new StorageSignedUploadIssuer(issuer),
    token = sign({ url: path, scope: 'upload', upsert: true });
  const result = service.verify(token, path);
  assert.equal(result.providerKeyId, issuer.providerKeyId);
  assert.equal(result.tokenKid, kid);
  assert.equal(result.issuerFingerprint, issuer.fingerprint);
  assert.equal(JSON.stringify(result).includes(token), false);
});
test('signature, algorithm, key identifier, scope, path and expired capabilities cannot masquerade as issuer proof', () => {
  const service = new StorageSignedUploadIssuer(issuer);
  for (const claims of [
    { url: path, scope: 'download', upsert: true },
    { url: path, upsert: true },
    { url: 'other/file.txt', scope: 'upload', upsert: true },
    { url: path, scope: 'upload', upsert: false },
    { url: path, scope: 'upload', upsert: true, role: 'service_role' },
  ])
    assert.throws(() => service.verify(sign(claims), path));
  const good = { url: path, scope: 'upload', upsert: true };
  for (const token of [
    sign(good, { keyid: 'unreviewed' }),
    sign(good, { expiresIn: 30 }),
    sign(good, { expiresIn: -1 }),
    sign(good, { expiresIn: 7201 }),
    jwt.sign(good, 'synthetic-secret', {
      algorithm: 'HS256',
      keyid: kid,
      expiresIn: 7200,
    }),
  ])
    assert.throws(
      () => service.verify(token, path),
      (e) => e instanceof Error && !e.message.includes(token),
    );
  const another = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() =>
    service.verify(
      jwt.sign(good, another.privateKey, {
        algorithm: 'ES256',
        keyid: kid,
        expiresIn: 7200,
      }),
      path,
    ),
  );
});
