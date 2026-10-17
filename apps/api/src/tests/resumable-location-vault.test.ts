import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { locationVaultFixture } from './fixtures/resumable-location-vault.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const location = (format = 'PATH_V1') =>
  'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/' +
  Buffer.from(
    'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/synthetic/33333333-3333-4333-8333-333333333333/old.txt' +
      (format === 'PATH_V1' ? '/' : '-$v-') +
      '44444444-4444-4444-8444-444444444444',
  ).toString('base64url');
test('original location is encrypted, exact-version decrypted before ACK and usable by fresh instances without exposing its URL', async () => {
  for (const format of ['PATH_V1', 'FILE_VERSION_V1']) {
    const f = locationVaultFixture({ uploadIdFormat: format }),
      url = location(format),
      r = await f.vault().retain({ location: url, sha256: hash(url) });
    assert.equal(r.pin.kind, 'RESUMABLE_LOCATION_PIN_V1');
    assert.equal(r.locationSha256, hash(url));
    assert.equal([...f.objects.values()][0].body.includes(url), false);
    assert.equal(JSON.stringify(r).includes(url), false);
    const result = await f
      .vault()
      .withLocation(r.pin, r.reference, async (secret) => ({
        reference: secret.reference,
        sha256: hash(secret.location),
      }));
    assert.deepEqual(result, { reference: r.reference, sha256: hash(url) });
    const before = f.calls.length,
      observed = await f.vault().inspect(r.pin);
    assert.equal(observed.locationSha256, hash(url));
    assert.equal(observed.originalAcknowledgementReconstructed, false);
    assert.equal(observed.actionAuthorized, false);
    assert.ok(
      f.calls
        .slice(before)
        .every(
          (c) => c instanceof GetObjectCommand || c instanceof DecryptCommand,
        ),
    );
    assert.ok(f.plaintextResponses.every((b) => b.every((v) => v === 0)));
  }
});
test('untrusted wrong-attempt control-slot malformed or changed-format locations refuse before KMS or storage', async () => {
  for (const url of [
    location().replace(
      'abcdefghijklmnopqrst.storage.supabase.co',
      'other.example',
    ),
    location() + '?token=secret',
    location().replace('https://', 'http://'),
    location('FILE_VERSION_V1'),
    'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/' +
      Buffer.from(
        'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/synthetic/' +
          randomUUID() +
          '/old.txt/' +
          randomUUID(),
      ).toString('base64url'),
    'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable/' +
      Buffer.from(
        'charitypilot-recovery-resumable-probes/charitypilot-recovery-resumable-probe/synthetic/33333333-3333-4333-8333-333333333333/control-before.txt/' +
          randomUUID(),
      ).toString('base64url'),
  ]) {
    const f = locationVaultFixture();
    await assert.rejects(
      f.vault().retain({ location: url, sha256: hash(url) }),
    );
    assert.equal(f.calls.length, 0);
  }
});
test('context tags wrapped-key and ciphertext substitutions cannot release plaintext even with recomputed public pin hashes', async () => {
  for (const field of ['context', 'tag', 'wrappedKey', 'ciphertext', 'kind']) {
    const f = locationVaultFixture(),
      url = location(),
      r = await f.vault().retain({ location: url, sha256: hash(url) }),
      row = [...f.objects.values()][0],
      e = JSON.parse(row.body);
    if (field === 'context') e.context.maintenance.sourceSha = '0'.repeat(40);
    else if (field === 'kind') e.kind = 'SIGNED_UPLOAD_CREDENTIAL_ENVELOPE_V1';
    else
      e[field] = Buffer.alloc(
        Buffer.from(e[field], 'base64').length,
        3,
      ).toString('base64');
    row.body = JSON.stringify(e);
    let consumed = false;
    await assert.rejects(
      f
        .vault()
        .withLocation(
          {
            ...r.pin,
            sha256: hash(row.body),
            byteLength: Buffer.byteLength(row.body),
          },
          r.reference,
          async () => {
            consumed = true;
          },
        ),
    );
    assert.equal(consumed, false);
    assert.ok(f.plaintextResponses.every((b) => b.every((v) => v === 0)));
  }
});
test('committed location PUT with lost ACK stays consumed and inspection cannot reconstruct action authority', async () => {
  const f = locationVaultFixture(),
    vault = f.vault(),
    url = location();
  f.setFault((command) => {
    if (command instanceof PutObjectCommand) {
      f.commit(command);
      throw new Error('synthetic lost location ACK');
    }
  });
  await assert.rejects(vault.retain({ location: url, sha256: hash(url) }));
  const n = f.calls.length;
  await assert.rejects(vault.retain({ location: url, sha256: hash(url) }));
  assert.equal(f.calls.length, n);
  f.setFault(undefined);
  const before = f.calls.length,
    observed = await f.vault().inspect();
  assert.equal(observed.originalAcknowledgementReconstructed, false);
  assert.equal(observed.actionAuthorized, false);
  assert.ok(
    f.calls
      .slice(before)
      .every(
        (c) => c instanceof GetObjectCommand || c instanceof DecryptCommand,
      ),
  );
  await assert.rejects(f.vault().retain({ location: url, sha256: hash(url) }));
  assert.equal(f.objects.size, 1);
});
test('wrong scope reference and storage metadata refuse without invoking the plaintext consumer', async () => {
  const f = locationVaultFixture(),
    url = location(),
    r = await f.vault().retain({ location: url, sha256: hash(url) });
  let consumed = false;
  const consumer = async () => {
    consumed = true;
  };
  await assert.rejects(
    f
      .vault()
      .withLocation(
        { ...r.pin, custodyDigest: '0'.repeat(64) },
        r.reference,
        consumer,
      ),
  );
  await assert.rejects(f.vault().withLocation(r.pin, randomUUID(), consumer));
  f.setFault((command) =>
    command instanceof GetObjectCommand
      ? {
          ...f.metadata(r.pin.versionId),
          SSEKMSKeyId: f.config.dataKeyArn,
          ContentLength: r.pin.byteLength,
          Body: Readable.from([Buffer.from([...f.objects.values()][0].body)]),
        }
      : undefined,
  );
  await assert.rejects(f.vault().withLocation(r.pin, r.reference, consumer));
  assert.equal(consumed, false);
});
test('late KMS plaintext is cleared and a deadline cannot resume location publication', async (t) => {
  const f = locationVaultFixture(),
    plain = Buffer.alloc(32, 7);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (r: unknown) => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.setFault((command) => {
    if (command instanceof GenerateDataKeyCommand) {
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }
  });
  const url = location(),
    result = assert.rejects(
      f.vault().retain({ location: url, sha256: hash(url) }),
    );
  await started;
  t.mock.timers.tick(15001);
  await result;
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
