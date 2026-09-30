import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { prepareComplaintCancellationFacts } from '../services/complaint-recovery-cancellation.js';
import { sealCancellation, openCancellation, preserveCancellation, readVerifiedCancellation } from '../services/cancellation-envelope.js';
import { openHoldOutcome } from '../services/hold-outcome-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

function fixture(operationKind: 'PRIMARY' | 'HOLD') {
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const body = prepareComplaintCancellationFacts({ format: 1, action: 'COMPLAINT_OPERATION_CANCELLED',
    organisationId: 'charity', installationId: 'install', operationId: 'operation', operationKind,
    writerEpoch: 1, writerId: 'host', preparationSourceRevision: context.sourceRevision,
    preparationId: 'preparation', preparationDigest: 'b'.repeat(64), cancellationId: 'cancel',
    complaintId: 'complaint', actorUserId: 'owner', reasonCode: 'OPERATOR_CANCELLED', evidenceRef: 'CANCEL-001',
    transactionId: '123', recordedAt: '2026-09-30T20:00:01Z' }).body;
  const delivered: Buffer[] = [];
  const key = () => { const value = Buffer.alloc(32, 7); delivered.push(value); return value; };
  const keys: RecoveryDataKeys = { async generate() { return { key: key(), keyId: context.keyId, wrappedKey: 'c3ludGhldGlj' }; },
    async unwrap() { return { key: key(), keyId: context.keyId }; } };
  return { context, body, keys, delivered };
}

test('cancellation envelope binds operation kind, original context and ciphertext while clearing keys', async () => {
  for (const operationKind of ['PRIMARY', 'HOLD'] as const) {
    const f = fixture(operationKind), sealed = await sealCancellation(f.body, f.context, f.keys);
    assert.equal((await openCancellation(sealed.envelope, f.context, operationKind, f.keys)).body, f.body);
    const count = f.delivered.length;
    await assert.rejects(openCancellation(sealed.envelope, f.context, operationKind === 'PRIMARY' ? 'HOLD' : 'PRIMARY', f.keys));
    for (const [name, value] of Object.entries({ installationId: 'other', organisationId: 'other', operationId: 'other',
      writerEpoch: 2, sourceRevision: 'b'.repeat(40) })) {
      await assert.rejects(openCancellation(sealed.envelope, { ...f.context, [name]: value }, operationKind, f.keys));
    }
    assert.equal(f.delivered.length, count);
    await assert.rejects(openHoldOutcome(sealed.envelope, f.context, f.keys));
    const altered = JSON.parse(sealed.envelope); altered.operationKind = operationKind === 'PRIMARY' ? 'HOLD' : 'PRIMARY';
    await assert.rejects(openCancellation(JSON.stringify(altered), f.context, altered.operationKind, f.keys));
    assert.ok(f.delivered.every(value => value.every(byte => byte === 0)));
    const wrongKey: RecoveryDataKeys = { ...f.keys, async unwrap() { return { key: Buffer.alloc(32, 8), keyId: f.context.keyId }; } };
    await assert.rejects(openCancellation(sealed.envelope, f.context, operationKind, wrongKey));
  }
});

test('S3 cancellation candidates preserve original bytes after lost acknowledgement and cannot replace published loss', async () => {
  const f = fixture('PRIMARY'), objects = new Map<string, string>(); let loseAck = true;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const config = { bucket: 'synthetic-cancellation-test', accountId: '123456789012', installationId: 'install', organisationId: 'charity',
    kmsKeyArn: f.context.keyId.replaceAll('1111', '2222'), replayKeyArn: f.context.keyId };
  const metadata = { VersionId: 'version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    assert.equal(command.input.Key, 'cancellations/install/charity/operation.json');
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (!body) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, ContentLength: Buffer.byteLength(body), Body: Readable.from([Buffer.from(body)]) };
    }
    assert.equal(command.input.IfNoneMatch, '*');
    if (objects.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } };
    objects.set(command.input.Key!, String(command.input.Body));
    if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
    return metadata;
  }) as typeof client.send;
  const store = new S3AuthorityObjectStore(config, credentials, client);
  await assert.rejects(preserveCancellation(f.body, f.context, f.keys, store));
  const original = [...objects.values()][0]!;
  const retry = await preserveCancellation(f.body, f.context, f.keys, store);
  assert.equal(retry.replayed, true); assert.equal([...objects.values()][0], original);
  assert.equal((await readVerifiedCancellation(retry.digest, f.context, 'PRIMARY', f.keys, store)).body, f.body);
  await assert.rejects(readVerifiedCancellation(retry.digest, f.context, 'HOLD', f.keys, store));
  await assert.rejects(preserveCancellation(fixture('HOLD').body, f.context, f.keys, store));
  await assert.rejects(store.createHoldOutcome('operation', original));
  await assert.rejects(store.createOutcome('operation', original));
  await assert.rejects(store.createReplay('operation', original));
  await assert.rejects(store.createCancellation('other', original));
  objects.clear();
  await assert.rejects(readVerifiedCancellation(retry.digest, f.context, 'PRIMARY', f.keys, store), /unresolved/);
  assert.equal(objects.size, 0);
});
