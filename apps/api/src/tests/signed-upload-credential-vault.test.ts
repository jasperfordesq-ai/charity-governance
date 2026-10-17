import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, mock } from 'node:test';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GenerateDataKeyCommand,
  DecryptCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { S3SignedUploadCredentialVault } from '../services/signed-upload-credential-vault.js';
import {
  vaultFixture,
  syntheticAwsCredentials,
} from './fixtures/signed-upload-vault.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const token = 'a'.repeat(40) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(80);

test('maximum bounded token is encrypted and restored while malformed key responses are cleared', async () => {
  const large = 'a'.repeat(8188) + '.b.c',
    f = vaultFixture(),
    r = await f.vault().retain({ token: large, sha256: hash(large) });
  assert.ok(r.pin.byteLength <= 32768);
  assert.equal(
    await f
      .vault()
      .withCredential(r.pin, r.reference, async (s) => s.token.length),
    8192,
  );
  const bad = vaultFixture(),
    plain = Buffer.alloc(32, 7);
  bad.setFault((command) =>
    command instanceof GenerateDataKeyCommand
      ? {
          KeyId: bad.config.storageKeyArn,
          Plaintext: plain,
          CiphertextBlob: Buffer.alloc(48, 8),
        }
      : undefined,
  );
  await assert.rejects(bad.vault().retain({ token, sha256: hash(token) }));
  assert.ok(plain.every((v) => v === 0));
  assert.equal(bad.objects.size, 0);
});

test('late KMS plaintext after deadline is cleared and cannot trigger storage publication', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = vaultFixture(),
    plain = Buffer.alloc(32, 7);
  let reply!: (v: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setFault((command) => {
    if (command instanceof GenerateDataKeyCommand) {
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }
  });
  const result = assert.rejects(
    f.vault().retain({ token, sha256: hash(token) }),
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
  assert.equal(
    f.calls.some((c) => c instanceof PutObjectCommand),
    false,
  );
});

test('late S3 response bodies are destroyed without decrypting or releasing credentials', async (t) => {
  const f = vaultFixture(),
    r = await f.vault().retain({ token, sha256: hash(token) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (v: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setFault((command) => {
    if (command instanceof GetObjectCommand) {
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    }
  });
  const before = f.calls.filter((c) => c instanceof DecryptCommand).length,
    result = assert.rejects(
      f.vault().withCredential(r.pin, r.reference, async () => assert.fail()),
    );
  await started;
  t.mock.timers.tick(15001);
  await result;
  const body = Readable.from([Buffer.from([...f.objects.values()][0].body)]);
  reply({
    ...f.metadata(r.pin.versionId),
    Body: body,
    ContentLength: r.pin.byteLength,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(body.destroyed, true);
  assert.equal(
    f.calls.filter((c) => c instanceof DecryptCommand).length,
    before,
  );
});

test('default custody SDKs pin Ireland, explicit credentials and single attempts', async () => {
  const f = vaultFixture(),
    r = await f.vault().retain({ token, sha256: hash(token) });
  const key = mock.method(
    KMSClient.prototype,
    'send',
    async function (this: KMSClient) {
      assert.equal(await this.config.region(), 'eu-west-1');
      assert.equal(await this.config.maxAttempts(), 1);
      const endpoint = await this.config.endpoint!();
      assert.equal(endpoint.hostname, 'kms.eu-west-1.amazonaws.com');
      assert.equal(endpoint.protocol, 'https:');
      throw new Error('PRIVATE synthetic');
    },
  );
  try {
    await assert.rejects(
      new S3SignedUploadCredentialVault(
        f.config,
        syntheticAwsCredentials,
        syntheticAwsCredentials,
      ).retain({ token, sha256: hash(token) }),
    );
  } finally {
    key.mock.restore();
  }
  const storage = mock.method(
    S3Client.prototype,
    'send',
    async function (this: S3Client) {
      assert.equal(await this.config.region(), 'eu-west-1');
      assert.equal(await this.config.maxAttempts(), 1);
      assert.equal(this.config.followRegionRedirects, false);
      const endpoint = await this.config.endpoint!();
      assert.equal(endpoint.hostname, 's3.eu-west-1.amazonaws.com');
      assert.equal(endpoint.protocol, 'https:');
      throw new Error('PRIVATE synthetic');
    },
  );
  try {
    await assert.rejects(
      new S3SignedUploadCredentialVault(
        f.config,
        syntheticAwsCredentials,
        syntheticAwsCredentials,
      ).withCredential(r.pin, r.reference, async () => assert.fail()),
    );
  } finally {
    storage.mock.restore();
  }
});
test('encrypted custody acknowledges only exact-version decrypted readback and a fresh instance loads the same credential', async () => {
  const f = vaultFixture(),
    vault = f.vault(),
    receipt = await vault.retain({ token, sha256: hash(token) });
  assert.equal(receipt.tokenSha256, hash(token));
  assert.equal(receipt.reference, receipt.pin.reference);
  assert.equal([...f.objects.values()][0].body.includes(token), false);
  assert.equal(JSON.stringify(receipt).includes(token), false);
  const seen = await f
    .vault()
    .withCredential(receipt.pin, receipt.reference, async (secret) => ({
      reference: secret.reference,
      hash: hash(secret.token),
    }));
  assert.equal(seen.hash, hash(token));
  assert.equal(seen.reference, receipt.reference);
  assert.ok(f.plaintextResponses.every((bytes) => bytes.every((b) => b === 0)));
  const inspected = await f.vault().inspect();
  assert.equal(inspected.decryptable, true);
  assert.equal(inspected.originalAcknowledgementReconstructed, false);
  assert.equal(JSON.stringify(inspected).includes(token), false);
  const before = f.calls.length;
  await assert.rejects(vault.retain({ token, sha256: hash(token) }));
  assert.equal(f.calls.length, before);
});
test('context and authenticated ciphertext substitution fail even if the public body pin is recomputed', async () => {
  for (const mode of ['context', 'tag', 'wrapped'] as const) {
    const f = vaultFixture(),
      r = await f.vault().retain({ token, sha256: hash(token) }),
      row = [...f.objects.values()][0],
      body = JSON.parse(row.body);
    if (mode === 'context') body.context.maintenance.sourceSha = '8'.repeat(40);
    if (mode === 'tag') body.tag = Buffer.alloc(16, 9).toString('base64');
    if (mode === 'wrapped')
      body.wrappedKey = Buffer.alloc(48, 9).toString('base64');
    row.body = JSON.stringify(body);
    const pin = {
      ...r.pin,
      sha256: hash(row.body),
      byteLength: Buffer.byteLength(row.body),
    };
    await assert.rejects(
      f.vault().withCredential(pin, r.reference, async () => {
        throw new Error('must not reach consumer');
      }),
      (e) => e instanceof Error && !e.message.includes(token),
    );
  }
});
test('a lost publication ACK stays uncertain while read-only inspection can identify the retained object', async () => {
  const f = vaultFixture(),
    vault = f.vault();
  f.setFault((command) => {
    if (command instanceof PutObjectCommand) {
      f.commit(command);
      throw new Error('PRIVATE committed ACK lost');
    }
  });
  await assert.rejects(vault.retain({ token, sha256: hash(token) }));
  const before = f.calls.length;
  await assert.rejects(vault.retain({ token, sha256: hash(token) }));
  assert.equal(f.calls.length, before);
  f.setFault(undefined);
  const observedBefore = f.calls.length;
  const observed = await f.vault().inspect();
  assert.equal(observed.decryptable, true);
  assert.equal(observed.originalAcknowledgementReconstructed, false);
  assert.ok(
    f.calls
      .slice(observedBefore)
      .every(
        (c) => c instanceof GetObjectCommand || c instanceof DecryptCommand,
      ),
  );
  await assert.rejects(f.vault().retain({ token, sha256: hash(token) }));
  assert.equal(f.objects.size, 1);
});
test('scope, metadata and credential-reference mismatch refuse without releasing a credential', async () => {
  const f = vaultFixture();
  assert.throws(
    () =>
      new S3SignedUploadCredentialVault(
        { ...f.config, dataKeyArn: f.config.storageKeyArn },
        syntheticAwsCredentials,
        syntheticAwsCredentials,
      ),
  );
  assert.throws(
    () =>
      new S3SignedUploadCredentialVault(
        f.config,
        undefined as never,
        syntheticAwsCredentials,
      ),
  );
  const r = await f.vault().retain({ token, sha256: hash(token) });
  await assert.rejects(
    f
      .vault()
      .withCredential(r.pin, '55555555-5555-4555-8555-555555555555', async () =>
        assert.fail(),
      ),
  );
  f.setFault((command) => {
    if (command instanceof GetObjectCommand) {
      const row = [...f.objects.values()][0];
      return {
        ...f.metadata('wrong-version'),
        ContentLength: Buffer.byteLength(row.body),
        Body: undefined,
      };
    }
  });
  await assert.rejects(
    f.vault().withCredential(r.pin, r.reference, async () => assert.fail()),
  );
});
