import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { S3SignedResumableCredentialVault } from '../services/signed-resumable-credential-vault.js';
import { S3ResumableLocationVault } from '../services/resumable-location-vault.js';
import { signedTusHash as hash } from '../services/signed-resumable-upload-contract.js';
import {
  maintenanceSecretVaultFixture,
  syntheticAwsCredentials,
} from './fixtures/resumable-location-vault.js';
import { signedResumableProbeFixture } from './fixtures/signed-resumable-upload.js';
const fixture = (
  overrides: Parameters<typeof maintenanceSecretVaultFixture>[0] = {},
) => {
  const f = maintenanceSecretVaultFixture(
    overrides,
    'signed-resumable-credential.json',
    'charitypilot-signed-resumable-credential-v1',
  );
  return {
    ...f,
    vault: () =>
      new S3SignedResumableCredentialVault(
        f.config,
        syntheticAwsCredentials,
        syntheticAwsCredentials,
        { storage: f.storage, kms: f.kms },
      ),
  };
};
const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
function secret(format = 'PATH_V1', patch: Record<string, unknown> = {}) {
  const path =
    'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/synthetic/33333333-3333-4333-8333-333333333333/old.txt';
  const token = jwt.sign(
      { url: path, scope: 'upload', upsert: true, ...patch },
      key.privateKey,
      {
        algorithm: 'ES256',
        keyid: 'synthetic-issuer',
        ...(Object.hasOwn(patch, 'exp') ? {} : { expiresIn: 7200 }),
      },
    ),
    location =
      'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/sign/' +
      Buffer.from(
        path + (format === 'PATH_V1' ? '/' : '-$v-') + randomUUID(),
      ).toString('base64url');
  return {
    token,
    location,
    tokenSha256: hash(token),
    locationSha256: hash(location),
  };
}
for (const format of ['PATH_V1', 'FILE_VERSION_V1'])
  test(
    'actual signed ' +
      format +
      ' probe requires combined ciphertext readback and uses the original decrypted pair',
    async () => {
      const probe = signedResumableProbeFixture(format),
        p = probe.factory(),
        f = fixture({
          uploadIdFormat: format,
          probeDigest: p.configurationDigest(),
        }),
        vault = f.vault(),
        custody = vault.configurationDigest();
      const baseline = await p.baseline(async (input, signal) => {
        const pin = await vault.retain(input, signal);
        assert.equal(probe.calls.filter((c) => c.method === 'PATCH').length, 0);
        assert.ok(f.calls.some((c) => c instanceof GetObjectCommand));
        assert.ok(f.calls.some((c) => c instanceof DecryptCommand));
        return pin;
      }, custody);
      const saved = JSON.parse(baseline.body),
        row = [...f.objects.values()][0];
      assert.equal(
        saved.credentialPin.kind,
        'SIGNED_RESUMABLE_CREDENTIAL_PIN_V1',
      );
      const hashes = await f
        .vault()
        .withCredential(
          saved.credentialPin,
          saved.credentialPin.reference,
          async (value) => {
            assert.ok(!row.body.includes(value.token));
            assert.ok(!row.body.includes(value.location));
            assert.ok(!baseline.body.includes(value.token));
            assert.ok(!baseline.body.includes(value.location));
            return { token: hash(value.token), location: hash(value.location) };
          },
        );
      assert.equal(hashes.token, saved.tokenProof.tokenSha256);
      assert.equal(hashes.location, saved.credentialPin.locationSha256);
      probe.mode.revoked = true;
      const report = await f
        .vault()
        .withCredential(
          saved.credentialPin,
          saved.credentialPin.reference,
          (value, signal) =>
            probe.factory().verifyRefusal(baseline, custody, value, signal),
        );
      assert.equal(report.testedSignedResumablePatchRefusalObserved, true);
      assert.equal(report.tokenSha256, hashes.token);
      assert.equal(report.locationSha256, hashes.location);
      const before = f.calls.length,
        observation = await f.vault().inspect(saved.credentialPin);
      assert.equal(observation.originalAcknowledgementReconstructed, false);
      assert.equal(observation.actionAuthorized, false);
      assert.ok(
        f.calls
          .slice(before)
          .every(
            (c) => c instanceof GetObjectCommand || c instanceof DecryptCommand,
          ),
      );
      assert.ok(f.plaintextResponses.every((v) => v.every((b) => b === 0)));
      const env = JSON.parse(row.body);
      assert.equal(
        env.context.purpose,
        'charitypilot-signed-resumable-credential-v1',
      );
      assert.ok(
        f.calls
          .filter(
            (c) =>
              c instanceof GenerateDataKeyCommand ||
              c instanceof DecryptCommand,
          )
          .every(
            (c) =>
              !JSON.stringify(c.input.EncryptionContext).includes(
                '/storage/v1/',
              ),
          ),
      );
    },
  );
test('historical combined secrets remain inspectable after token expiry without claiming current authority', async () => {
  const f = fixture(),
    v = secret('PATH_V1', { iat: 946684800, exp: 946688400 });
  const claims = jwt.decode(v.token) as jwt.JwtPayload;
  assert.ok(claims);
  const pin = await f.vault().retain(v),
    observed = await f.vault().inspect(pin);
  assert.equal(observed.decryptable, true);
  assert.equal(observed.actionAuthorized, false);
});
test('wrong token target/scope, unsigned location and pair hash mismatches fail before KMS/storage', async () => {
  const good = secret();
  for (const input of [
    secret('PATH_V1', { scope: 'download' }),
    secret('PATH_V1', { url: 'other/object' }),
    { ...good, tokenSha256: '0'.repeat(64) },
    {
      ...good,
      location: good.location.replace('/sign/', '/'),
      locationSha256: hash(good.location.replace('/sign/', '/')),
    },
    secret('FILE_VERSION_V1'),
  ]) {
    const f = fixture();
    await assert.rejects(f.vault().retain(input));
    assert.equal(f.calls.length, 0);
  }
});
test('context, purpose, tag, wrapped key, ciphertext and pin substitutions cannot release either secret', async () => {
  for (const field of [
    'context',
    'purpose',
    'tag',
    'wrappedKey',
    'ciphertext',
    'kind',
    'tokenHash',
    'locationHash',
  ] as const) {
    const f = fixture(),
      pin = await f.vault().retain(secret()),
      row = [...f.objects.values()][0],
      e = JSON.parse(row.body);
    let altered = pin;
    if (field === 'context') e.context.maintenance.sourceSha = '0'.repeat(40);
    else if (field === 'purpose')
      e.context.purpose = 'charitypilot-resumable-location-v1';
    else if (field === 'kind') e.kind = 'RESUMABLE_LOCATION_ENVELOPE_V1';
    else if (field === 'tokenHash') {
      e.context.tokenSha256 = '0'.repeat(64);
      altered = { ...pin, tokenSha256: '0'.repeat(64) };
    } else if (field === 'locationHash') {
      e.context.locationSha256 = '0'.repeat(64);
      altered = { ...pin, locationSha256: '0'.repeat(64) };
    } else
      e[field] = Buffer.alloc(
        Buffer.from(e[field], 'base64').length,
        3,
      ).toString('base64');
    row.body = JSON.stringify(e);
    altered = {
      ...altered,
      sha256: hash(row.body),
      byteLength: Buffer.byteLength(row.body),
    };
    let consumed = false;
    await assert.rejects(
      f.vault().withCredential(altered, pin.reference, async () => {
        consumed = true;
      }),
    );
    assert.equal(consumed, false);
  }
});
test('lost committed PUT/readback ACK stays unknown and cannot authorise replacement or reconstruct execution', async () => {
  for (const stage of ['put', 'get'] as const) {
    const f = fixture(),
      vault = f.vault(),
      v = secret();
    f.setFault((c) => {
      if (stage === 'put' && c instanceof PutObjectCommand) {
        f.commit(c);
        throw new Error('synthetic lost PUT acknowledgement');
      }
      if (stage === 'get' && c instanceof GetObjectCommand)
        throw new Error('synthetic lost readback acknowledgement');
    });
    await assert.rejects(vault.retain(v));
    assert.equal(f.objects.size, 1);
    const before = f.calls.length;
    await assert.rejects(vault.retain(v));
    assert.equal(f.calls.length, before);
    f.setFault(() => undefined);
    const observed = await f.vault().inspect();
    assert.equal(observed.originalAcknowledgementReconstructed, false);
    assert.equal(observed.actionAuthorized, false);
    await assert.rejects(f.vault().retain(v));
    assert.equal(f.objects.size, 1);
  }
});
test('ordinary-location pins/envelopes cannot become combined signed custody, or vice versa', async () => {
  const f = fixture(),
    pin = await f.vault().retain(secret());
  await assert.rejects(
    f
      .vault()
      .withCredential(
        { ...pin, kind: 'RESUMABLE_LOCATION_PIN_V1' },
        pin.reference,
        async () => {},
      ),
  );
  const ordinary = new S3ResumableLocationVault(
    f.config,
    syntheticAwsCredentials,
    syntheticAwsCredentials,
    { storage: f.storage, kms: f.kms },
  );
  const before = f.calls.length;
  await assert.rejects(
    ordinary.withLocation(pin, pin.reference, async () => {}),
  );
  assert.equal(f.calls.length, before);
  const row = [...f.objects.values()][0],
    e = JSON.parse(row.body);
  e.kind = 'RESUMABLE_LOCATION_ENVELOPE_V1';
  row.body = JSON.stringify(e);
  await assert.rejects(
    f
      .vault()
      .inspect({
        ...pin,
        sha256: hash(row.body),
        byteLength: Buffer.byteLength(row.body),
      }),
  );
});
test('wrong reference/version/SSE, deleted or oversized objects do not call the secret consumer', async () => {
  for (const mode of [
    'reference',
    'version',
    'sse',
    'deleted',
    'oversize',
  ] as const) {
    const f = fixture(),
      pin = await f.vault().retain(secret());
    let consumed = false;
    if (mode !== 'reference')
      f.setFault((c) =>
        c instanceof GetObjectCommand
          ? {
              ...f.metadata(pin.versionId),
              ...(mode === 'version'
                ? { VersionId: 'wrong-version' }
                : mode === 'sse'
                  ? { SSEKMSKeyId: f.config.dataKeyArn }
                  : mode === 'deleted'
                    ? { DeleteMarker: true }
                    : {}),
              ContentLength: mode === 'oversize' ? 32769 : pin.byteLength,
              Body: Readable.from([
                Buffer.from([...f.objects.values()][0].body),
              ]),
            }
          : undefined,
      );
    await assert.rejects(
      f
        .vault()
        .withCredential(
          pin,
          mode === 'reference' ? randomUUID() : pin.reference,
          async () => {
            consumed = true;
          },
        ),
    );
    assert.equal(consumed, false);
  }
});
test('late data key after deadline is cleared and never publishes a combined envelope', async (t) => {
  const f = fixture(),
    plain = Buffer.alloc(32, 7);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void, reply!: (v: unknown) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.setFault((c) => {
    if (c instanceof GenerateDataKeyCommand) {
      entered();
      return new Promise((r) => {
        reply = r;
      });
    }
  });
  const pending = assert.rejects(f.vault().retain(secret()));
  await started;
  t.mock.timers.tick(15001);
  await pending;
  reply({
    KeyId: f.config.dataKeyArn,
    Plaintext: plain,
    CiphertextBlob: Buffer.alloc(48, 8),
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(plain.every((v) => v === 0));
  assert.equal(f.objects.size, 0);
});
