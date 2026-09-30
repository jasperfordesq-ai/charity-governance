import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { prepareComplaintOutcomeFacts } from '../services/complaint-recovery-outcome.js';
import { openRecoveryOutcome, sealRecoveryOutcome, preserveRecoveryOutcome, readVerifiedRecoveryOutcome } from '../services/recovery-outcome-envelope.js';
import { openRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

function fixture() {
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const body = prepareComplaintOutcomeFacts({ format: 1, action: 'COMPLAINT_PRIMARY_PURGE_COMMITTED',
    organisationId: 'charity', installationId: 'install', operationId: 'operation', writerEpoch: 1,
    preparationSourceRevision: context.sourceRevision, preparationId: 'preparation', preparationDigest: 'b'.repeat(64),
    outcomeId: 'outcome', claimId: 'claim', authorizationId: 'authority', complaintId: 'complaint', actorUserId: 'owner',
    transactionId: '123', claimedAt: '2026-09-30T20:00:00Z', recordedAt: '2026-09-30T20:00:01Z' }).body;
  const delivered: Buffer[] = [];
  const key = () => { const value = Buffer.alloc(32, 7); delivered.push(value); return value; };
  const keys: RecoveryDataKeys = { async generate() { return { key: key(), keyId: context.keyId, wrappedKey: 'c3ludGhldGlj' }; },
    async unwrap() { return { key: key(), keyId: context.keyId }; } };
  return { context, body, keys, delivered };
}

test('outcome envelopes bind kind, context and original bytes, and clear delivered keys', async () => {
  const f = fixture(), sealed = await sealRecoveryOutcome(f.body, f.context, f.keys);
  assert.equal((await openRecoveryOutcome(sealed.envelope, f.context, f.keys)).body, f.body);
  await assert.rejects(() => openRecoveryPreparation(sealed.envelope, f.context, f.keys));
  for (const [name, value] of Object.entries({ organisationId: 'other', operationId: 'other', writerEpoch: 2,
    installationId: 'other', sourceRevision: 'b'.repeat(40) })) {
    const before = f.delivered.length;
    await assert.rejects(() => openRecoveryOutcome(sealed.envelope, { ...f.context, [name]: value }, f.keys));
    assert.equal(f.delivered.length, before);
  }
  const altered = JSON.parse(sealed.envelope); altered.sealed.ciphertext = 'AAAA' + altered.sealed.ciphertext.slice(4);
  await assert.rejects(() => openRecoveryOutcome(JSON.stringify(altered), f.context, f.keys));
  assert.ok(f.delivered.every(value => value.every(byte => byte === 0)));
  assert.throws(() => prepareComplaintOutcomeFacts({ ...JSON.parse(f.body), reason: 'private content' }));
  assert.throws(() => prepareComplaintOutcomeFacts({ ...JSON.parse(f.body), transactionId: 'private invalid value' }),
    { message: 'Invalid complaint outcome facts' });
});

test('S3 outcome retries retain winning ciphertext in a separate create-only namespace', async () => {
  const f = fixture(), objects = new Map<string, string>(); let loseAck = true;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const config = { bucket: 'synthetic-outcome-test', accountId: '123456789012', installationId: 'install', organisationId: 'charity',
    kmsKeyArn: f.context.keyId.replaceAll('1111', '2222'), replayKeyArn: f.context.keyId };
  const metadata = { VersionId: 'version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    assert.equal(command.input.Key, 'outcomes/install/charity/operation.json');
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
  await assert.rejects(() => preserveRecoveryOutcome(f.body, f.context, f.keys, store));
  const original = [...objects.values()][0]!;
  const retry = await preserveRecoveryOutcome(f.body, f.context, f.keys, store);
  assert.equal(retry.replayed, true); assert.equal(retry.actionAuthorized, false);
  assert.equal([...objects.values()][0], original);
  assert.equal((await readVerifiedRecoveryOutcome(retry.digest, f.context, f.keys, store)).body, f.body);
  await assert.rejects(() => store.createReplay('operation', original));
  await assert.rejects(() => store.createOutcome('other', original));
  const changed = prepareComplaintOutcomeFacts({ ...JSON.parse(f.body), claimId: 'different' }).body;
  await assert.rejects(() => preserveRecoveryOutcome(changed, f.context, f.keys, store));
  assert.equal([...objects.values()][0], original);
  objects.clear();
  await assert.rejects(() => readVerifiedRecoveryOutcome(retry.digest, f.context, f.keys, store), /unresolved/);
  assert.equal(objects.size, 0);
});
