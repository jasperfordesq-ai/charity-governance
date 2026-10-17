import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { S3CapabilityVault } from '../services/s3-capability-vault.js';
import { assertOriginalS3PresignedUrl } from '../services/s3-capability-target.js';
import { s3ProbeHash as hash } from '../services/s3-capability-contract.js';
import { s3CapabilityProbeFixture } from './fixtures/s3-capability-proof.js';
import {
  maintenanceSecretVaultFixture,
  syntheticAwsCredentials,
} from './fixtures/resumable-location-vault.js';
const fixture = (endpoint = 'DIRECT', probeDigest = '9'.repeat(64)) => {
  const f = maintenanceSecretVaultFixture(
    { probeDigest },
    's3-capability/' +
      endpoint +
      '/eu-west-1/' +
      hash('SYNTHETIC_S3_KEY') +
      '/' +
      probeDigest +
      '.json',
    'charitypilot-s3-capability-v1',
  );
  const { uploadIdFormat, ...storage } = f.config;
  const config = {
    ...storage,
    endpoint,
    region: 'eu-west-1',
    accessKeyIdSha256: hash('SYNTHETIC_S3_KEY'),
  };
  return {
    ...f,
    config,
    vault: (raw: unknown = config) =>
      new S3CapabilityVault(
        raw,
        syntheticAwsCredentials,
        syntheticAwsCredentials,
        { storage: f.storage, kms: f.kms },
      ),
  };
};
function secret(endpoint = 'DIRECT', date = '20000101T000000Z') {
  const q = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential':
      'SYNTHETIC_S3_KEY/' + date.slice(0, 8) + '/eu-west-1/s3/aws4_request',
    'X-Amz-Date': date,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'host',
    'X-Amz-Signature': 'a'.repeat(64),
    'x-id': 'PutObject',
  });
  const presignedUrl =
    'https://abcdefghijklmnopqrst' +
    (endpoint === 'DIRECT' ? '.storage.supabase.co' : '.supabase.co') +
    '/storage/v1/s3/charitypilot-recovery-s3-probes/charitypilot-recovery-s3-probe/synthetic/33333333-3333-4333-8333-333333333333/presigned.bin?' +
    q;
  const uploadId = 'synthetic-upload-' + randomUUID();
  return {
    presignedUrl,
    uploadId,
    presignedUrlSha256: hash(presignedUrl),
    uploadIdSha256: hash(uploadId),
  };
}
for (const endpoint of ['DIRECT', 'GATEWAY'])
  test(
    'actual SDK ' +
      endpoint +
      ' original S3 pair requires encrypted exact-version readback before use',
    async () => {
      const probe = s3CapabilityProbeFixture(endpoint),
        p = probe.factory(),
        f = fixture(endpoint, p.configurationDigest()),
        vault = f.vault(),
        custody = vault.configurationDigest();
      const baseline = await p.baseline(async (input, signal) => {
        const pin = await vault.retain(input, signal);
        assert.equal(probe.calls.filter((c) => c.presigned).length, 0);
        assert.equal(probe.uploads.get(input.uploadId)!.parts.size, 0);
        assert.ok(f.calls.some((c) => c instanceof GetObjectCommand));
        assert.ok(f.calls.some((c) => c instanceof DecryptCommand));
        return pin;
      }, custody);
      const saved = JSON.parse(baseline.body),
        pin = saved.capabilityPin,
        row = [...f.objects.values()][0];
      await f.vault().withCredential(pin, pin.reference, async (value) => {
        assert.ok(!row.body.includes(value.presignedUrl));
        assert.ok(!row.body.includes(value.uploadId));
        assert.ok(!baseline.body.includes(value.presignedUrl));
        assert.ok(!baseline.body.includes(value.uploadId));
        assert.equal(hash(value.presignedUrl), pin.presignedUrlSha256);
        assert.equal(hash(value.uploadId), pin.uploadIdSha256);
      });
      probe.mode.disabled = true;
      const report = await f
        .vault()
        .withCredential(pin, pin.reference, (value, signal) =>
          probe.factory().verifyRefusal(baseline, custody, value, signal),
        );
      assert.equal(report.testedS3FeatureRefusalsObserved, true);
      assert.equal(report.wholeStorageQuiesced, false);
      const before = f.calls.length,
        observed = await f.vault().inspect(pin);
      assert.equal(observed.originalAcknowledgementReconstructed, false);
      assert.equal(observed.actionAuthorized, false);
      assert.ok(
        f.calls
          .slice(before)
          .every(
            (c) => c instanceof GetObjectCommand || c instanceof DecryptCommand,
          ),
      );
      assert.ok(f.plaintextResponses.every((v) => v.every((b) => b === 0)));
      for (const c of f.calls)
        if (
          c instanceof GenerateDataKeyCommand ||
          c instanceof DecryptCommand
        ) {
          assert.ok(
            !JSON.stringify(c.input.EncryptionContext).includes('/storage/v1/'),
          );
          assert.equal(
            c.input.EncryptionContext?.presignedUrlSha256,
            pin.presignedUrlSha256,
          );
          assert.equal(
            c.input.EncryptionContext?.uploadIdSha256,
            pin.uploadIdSha256,
          );
        }
    },
  );

test('historical original S3 secrets remain inspectable after expiry without current authority', async () => {
  const f = fixture(),
    pin = await f.vault().retain(secret());
  const observed = await f.vault().inspect(pin);
  assert.equal(observed.decryptable, true);
  assert.equal(observed.actionAuthorized, false);
});

test('wrong endpoint, attempt, key, lifetime, ambiguous query or target refuses before KMS/storage', async () => {
  const good = secret();
  const change = (fn: (u: URL) => void) => {
    const u = new URL(good.presignedUrl);
    fn(u);
    return u.href;
  };
  const urls = [
    good.presignedUrl.replace('.storage.supabase.co', '.supabase.co'),
    good.presignedUrl.replace('/presigned.bin', '/multipart.bin'),
    good.presignedUrl.replace('/synthetic/', '/other/'),
    change((u) => {
      u.username = 'other';
    }),
    change((u) => {
      u.hash = 'fragment';
    }),
    change((u) => {
      u.searchParams.append('X-Amz-Date', '20000101T000000Z');
    }),
    change((u) => {
      u.searchParams.set('X-Amz-Date', '20000230T000000Z');
    }),
    change((u) => {
      u.searchParams.set('X-Amz-Expires', '901');
    }),
    change((u) => {
      u.searchParams.set(
        'X-Amz-Credential',
        'OTHER/20000101/eu-west-1/s3/aws4_request',
      );
    }),
    change((u) => {
      u.searchParams.set('X-Amz-Security-Token', 'session');
    }),
    good.presignedUrl.replace('/presigned.bin', '/x/../presigned.bin'),
    change((u) => {
      u.searchParams.set('X-Amz-SignedHeaders', 'host;other');
    }),
  ];
  for (const presignedUrl of urls) {
    const f = fixture();
    await assert.rejects(
      f.vault().retain({
        ...good,
        presignedUrl,
        presignedUrlSha256: hash(presignedUrl),
      }),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const input of [
    { ...good, presignedUrlSha256: '0'.repeat(64) },
    { ...good, uploadIdSha256: '0'.repeat(64) },
    { ...good, uploadId: 'bad space' },
  ]) {
    const f = fixture();
    await assert.rejects(f.vault().retain(input));
    assert.equal(f.calls.length, 0);
  }
});

test('target validator permits historical exact lifetime but verifies canonical date and scope', () => {
  const f = fixture(),
    v = secret();
  const scope = {
    installationId: f.config.installationId,
    projectRef: f.config.projectRef,
    endpoint: f.config.endpoint,
    region: f.config.region,
    attemptId: f.config.maintenance.attemptId,
    accessKeyIdSha256: f.config.accessKeyIdSha256,
  };
  assert.equal(
    assertOriginalS3PresignedUrl(v.presignedUrl, scope).expiresAt,
    '2000-01-01T00:15:00.000Z',
  );
  for (const change of [
    { attemptId: randomUUID() },
    { region: 'eu-central-1' },
    { accessKeyIdSha256: '0'.repeat(64) },
  ])
    assert.throws(() =>
      assertOriginalS3PresignedUrl(v.presignedUrl, { ...scope, ...change }),
    );
});

test('recomputed outer hashes cannot substitute S3 context, purpose, ciphertext or either original secret hash', async () => {
  for (const field of [
    'context',
    'purpose',
    'kind',
    'tag',
    'wrappedKey',
    'ciphertext',
    'presignedUrlSha256',
    'uploadIdSha256',
  ]) {
    const f = fixture(),
      pin = await f.vault().retain(secret()),
      row = [...f.objects.values()][0],
      e = JSON.parse(row.body);
    let altered = pin;
    if (field === 'context') e.context.maintenance.sourceSha = '0'.repeat(40);
    else if (field === 'purpose')
      e.context.purpose = 'charitypilot-signed-resumable-credential-v1';
    else if (field === 'kind')
      e.kind = 'SIGNED_RESUMABLE_CREDENTIAL_ENVELOPE_V1';
    else if (field.endsWith('Sha256')) {
      e.context[field] = '0'.repeat(64);
      altered = { ...pin, [field]: '0'.repeat(64) };
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

test('different endpoint/credential cohort configs and wrong pins cannot open original custody', async () => {
  const f = fixture(),
    pin = await f.vault().retain(secret());
  for (const patch of [
    { endpoint: 'GATEWAY' },
    { probeDigest: '0'.repeat(64) },
    { accessKeyIdSha256: '0'.repeat(64) },
    { maintenance: { ...f.config.maintenance, maintenanceEpoch: 2 } },
  ]) {
    let consumed = false;
    await assert.rejects(
      f
        .vault({ ...f.config, ...patch })
        .withCredential(pin, pin.reference, async () => {
          consumed = true;
        }),
    );
    assert.equal(consumed, false);
  }
  const before = f.calls.length;
  await assert.rejects(
    f
      .vault()
      .withCredential(
        { ...pin, kind: 'SIGNED_RESUMABLE_CREDENTIAL_PIN_V1' },
        pin.reference,
        async () => {},
      ),
  );
  await assert.rejects(
    f.vault().withCredential(pin, randomUUID(), async () => {}),
  );
  assert.equal(f.calls.length, before);
});

test('lost committed PUT or decrypted readback acknowledgement cannot be retried or reconstructed', async () => {
  for (const stage of ['put', 'get']) {
    const f = fixture(),
      vault = f.vault(),
      v = secret();
    f.setFault((c) => {
      if (stage === 'put' && c instanceof PutObjectCommand) {
        f.commit(c);
        throw new Error('synthetic lost PUT');
      }
      if (stage === 'get' && c instanceof GetObjectCommand)
        throw new Error('synthetic lost readback');
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

test('wrong object version, SSE key or deleted object never releases either original S3 secret', async () => {
  for (const mode of ['version', 'sse', 'deleted']) {
    const f = fixture(),
      pin = await f.vault().retain(secret());
    f.setFault((c) =>
      c instanceof GetObjectCommand
        ? {
            ...f.metadata(pin.versionId),
            ...(mode === 'version'
              ? { VersionId: 'wrong-version' }
              : mode === 'sse'
                ? { SSEKMSKeyId: f.config.dataKeyArn }
                : { DeleteMarker: true }),
            ContentLength: pin.byteLength,
            Body: Readable.from([Buffer.from([...f.objects.values()][0].body)]),
          }
        : undefined,
    );
    let consumed = false;
    await assert.rejects(
      f.vault().withCredential(pin, pin.reference, async () => {
        consumed = true;
      }),
    );
    assert.equal(consumed, false);
  }
});

test('late KMS key after cancellation is erased without publishing S3 custody', async () => {
  const f = fixture(),
    controller = new AbortController(),
    plain = Buffer.alloc(32, 7);
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
  const pending = assert.rejects(f.vault().retain(secret(), controller.signal));
  await started;
  controller.abort();
  await pending;
  reply({
    KeyId: f.config.dataKeyArn,
    Plaintext: plain,
    CiphertextBlob: Buffer.alloc(48, 8),
  });
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(plain.every((v) => v === 0));
  assert.equal(f.objects.size, 0);
});

test('same-attempt endpoint cohorts retain distinct objects even with the same declared probe digest', async () => {
  const keys = [];
  for (const endpoint of ['DIRECT', 'GATEWAY']) {
    const f = fixture(endpoint);
    await f.vault().retain(secret(endpoint));
    const put = f.calls.find(
      (c) => c instanceof PutObjectCommand,
    ) as PutObjectCommand;
    keys.push(put.input.Key);
  }
  assert.notEqual(keys[0], keys[1]);
});

test('lost encrypted original S3 readback acknowledgement prevents first original part and presigned use', async () => {
  const probe = s3CapabilityProbeFixture(),
    p = probe.factory(),
    f = fixture('DIRECT', p.configurationDigest());
  f.setFault((c) => {
    if (c instanceof GetObjectCommand)
      throw new Error('synthetic lost custody readback');
  });
  await assert.rejects(
    p.baseline(
      (value, signal) => f.vault().retain(value, signal),
      f.vault().configurationDigest(),
    ),
  );
  assert.equal(f.objects.size, 1);
  assert.equal(probe.calls.filter((c) => c.presigned).length, 0);
  assert.ok([...probe.uploads.values()].every((v) => v.parts.size === 0));
  f.setFault(() => undefined);
  const observed = await f.vault().inspect();
  assert.equal(observed.originalAcknowledgementReconstructed, false);
  assert.equal(observed.actionAuthorized, false);
});
