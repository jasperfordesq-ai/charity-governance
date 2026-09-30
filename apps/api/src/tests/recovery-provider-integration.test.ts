import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test, mock } from 'node:test';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { KmsRecoveryDataKeys } from '../services/recovery-data-keys-kms.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { preserveRecoveryPreparation, openRecoveryPreparation } from '../services/recovery-preparation-envelope.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';

test('recreated KMS and S3 adapters recover original encrypted bytes after lost write acknowledgement', async () => {
  // Synthetic external stores outlive the local adapter instances. This is not
  // live AWS custody or a VM-loss recovery acceptance test.
  const objects = new Map<string, string>();
  const wrapping = new Map<string, { key: Buffer; context: unknown }>();
  const returnedKeys: Uint8Array[] = [];
  let generations = 0, lostAck = true, keyUnavailable = false;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const replayKeyArn = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
  const config = { bucket: 'synthetic-provider-proof', accountId: '123456789012',
    installationId: 'install', organisationId: 'charity', replayKeyArn,
    kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222' };
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId: replayKeyArn };
  function clients() {
    const kms = new KMSClient({ region: 'eu-west-1', credentials });
    const s3 = new S3Client({ region: 'eu-west-1', credentials });
    mock.method(kms, 'send', async (command: GenerateDataKeyCommand | DecryptCommand) => {
      if (keyUnavailable) throw new Error('synthetic key disabled');
      assert.equal(command.input.KeyId, replayKeyArn);
      if (command instanceof GenerateDataKeyCommand) {
        generations++;
        const wrapped = randomBytes(48); const key = randomBytes(32);
        wrapping.set(wrapped.toString('base64'), { key: Buffer.from(key), context: command.input.EncryptionContext });
        returnedKeys.push(key);
        return { KeyId: replayKeyArn, Plaintext: key, CiphertextBlob: wrapped };
      }
      const saved = wrapping.get(Buffer.from(command.input.CiphertextBlob!).toString('base64'));
      assert.ok(saved); assert.deepEqual(command.input.EncryptionContext, saved.context);
      const key = Buffer.from(saved.key); returnedKeys.push(key);
      return { KeyId: replayKeyArn, Plaintext: key, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
    });
    mock.method(s3, 'send', async (command: GetObjectCommand | PutObjectCommand) => {
      assert.equal(command.input.ExpectedBucketOwner, config.accountId);
      assert.equal(command.input.Key, 'replay/install/charity/operation.json');
      const metadata = { VersionId: 'external-version-1', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
      if (command instanceof GetObjectCommand) {
        const body = objects.get(command.input.Key!);
        if (!body) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
        return { ...metadata, ContentLength: Buffer.byteLength(body), Body: Readable.from([Buffer.from(body)]) };
      }
      assert.equal(command.input.IfNoneMatch, '*');
      if (objects.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(command.input.Key!, String(command.input.Body));
      if (lostAck) { lostAck = false; throw new Error('synthetic acknowledgement loss'); }
      return metadata;
    });
    return { keys: new KmsRecoveryDataKeys(replayKeyArn, credentials, kms),
      store: new S3AuthorityObjectStore(config, credentials, s3), close() { kms.destroy(); s3.destroy(); } };
  }
  const body = prepareComplaintRecoveryFacts(complaintPreparationFixture()).body;
  const first = clients();
  try { await assert.rejects(() => preserveRecoveryPreparation(body, context, first.keys, first.store), /unresolved/); }
  finally { first.close(); }
  const original = [...objects.values()][0]!;
  assert.ok(original); assert.equal(generations, 1);
  assert.ok(!original.includes('Synthetic reviewed reason'));
  const restarted = clients();
  try {
    const receipt = await preserveRecoveryPreparation(body, context, restarted.keys, restarted.store);
    assert.equal(receipt.replayed, true); assert.equal(receipt.actionAuthorized, false);
    assert.equal(receipt.digest, createHash('sha256').update(original).digest('hex'));
    assert.equal(generations, 1); assert.equal([...objects.values()][0], original);
    assert.equal((await openRecoveryPreparation(original, context, restarted.keys)).body, body);
    keyUnavailable = true;
    await assert.rejects(() => preserveRecoveryPreparation(body, context, restarted.keys, restarted.store), /unresolved/);
    assert.equal(generations, 1); assert.equal([...objects.values()][0], original);
    assert.ok(returnedKeys.every(key => key.every(byte => byte === 0)));
  } finally {
    restarted.close();
    for (const record of wrapping.values()) record.key.fill(0);
  }
});
