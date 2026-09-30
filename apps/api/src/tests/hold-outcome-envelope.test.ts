import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { prepareComplaintHoldOutcomeFacts } from '../services/complaint-hold-recovery-outcome.js';
import { openHoldOutcome, sealHoldOutcome, preserveHoldOutcome, readVerifiedHoldOutcome } from '../services/hold-outcome-envelope.js';
import { openRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { openRecoveryOutcome } from '../services/recovery-outcome-envelope.js';
import { openHoldPreparation } from '../services/hold-recovery-envelope.js';

function fixture() {
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'operation',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const body = prepareComplaintHoldOutcomeFacts({ format: 1, action: 'COMPLAINT_HOLD_COMMITTED',
    organisationId: 'charity', installationId: 'install', operationId: 'operation', writerEpoch: 1,
    preparationSourceRevision: context.sourceRevision, preparationId: 'preparation', preparationDigest: 'b'.repeat(64),
    outcomeId: 'outcome', holdEventId: 'hold', holdRevision: 1, recordRevision: 2, held: true, complaintId: 'complaint', actorUserId: 'owner',
    transactionId: '123', occurredAt: '2026-09-30T20:00:00Z', recordedAt: '2026-09-30T20:00:01Z' }).body;
  const delivered: Buffer[] = [];
  const key = () => { const value = Buffer.alloc(32, 7); delivered.push(value); return value; };
  const keys: RecoveryDataKeys = { async generate() { return { key: key(), keyId: context.keyId, wrappedKey: 'c3ludGhldGlj' }; },
    async unwrap() { return { key: key(), keyId: context.keyId }; } };
  return { context, body, keys, delivered };
}

test('hold outcome envelopes bind kind, context and original bytes, and clear delivered keys', async () => {
  const f = fixture(), sealed = await sealHoldOutcome(f.body, f.context, f.keys);
  assert.equal((await openHoldOutcome(sealed.envelope, f.context, f.keys)).body, f.body);
  await assert.rejects(() => openRecoveryPreparation(sealed.envelope, f.context, f.keys));
  await assert.rejects(() => openRecoveryOutcome(sealed.envelope, f.context, f.keys));
  await assert.rejects(() => openHoldPreparation(sealed.envelope, f.context, f.keys));
  for (const [name, value] of Object.entries({ organisationId: 'other', operationId: 'other', writerEpoch: 2,
    installationId: 'other', sourceRevision: 'b'.repeat(40) })) {
    const before = f.delivered.length;
    await assert.rejects(() => openHoldOutcome(sealed.envelope, { ...f.context, [name]: value }, f.keys));
    assert.equal(f.delivered.length, before);
  }
  const altered = JSON.parse(sealed.envelope); altered.sealed.ciphertext = 'AAAA' + altered.sealed.ciphertext.slice(4);
  await assert.rejects(() => openHoldOutcome(JSON.stringify(altered), f.context, f.keys));
  assert.ok(f.delivered.every(value => value.every(byte => byte === 0)));
  assert.throws(() => prepareComplaintHoldOutcomeFacts({ ...JSON.parse(f.body), reason: 'private content' }));
  assert.throws(() => prepareComplaintHoldOutcomeFacts({ ...JSON.parse(f.body), transactionId: 'private invalid value' }),
    { message: 'Invalid complaint hold outcome facts' });
});

test('S3 hold outcome retries retain winning ciphertext in a separate create-only namespace', async () => {
  const f = fixture(), objects = new Map<string, string>(); let loseAck = true;
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const config = { bucket: 'synthetic-outcome-test', accountId: '123456789012', installationId: 'install', organisationId: 'charity',
    kmsKeyArn: f.context.keyId.replaceAll('1111', '2222'), replayKeyArn: f.context.keyId };
  const metadata = { VersionId: 'version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    assert.equal(command.input.Key, 'hold-outcomes/install/charity/operation.json');
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
  await assert.rejects(() => preserveHoldOutcome(f.body, f.context, f.keys, store));
  const original = [...objects.values()][0]!;
  const retry = await preserveHoldOutcome(f.body, f.context, f.keys, store);
  assert.equal(retry.replayed, true); assert.equal(retry.actionAuthorized, false);
  assert.equal([...objects.values()][0], original);
  assert.equal((await readVerifiedHoldOutcome(retry.digest, f.context, f.keys, store)).body, f.body);
  await assert.rejects(() => store.createReplay('operation', original));
  await assert.rejects(() => store.createOutcome('operation', original));
  await assert.rejects(() => store.createHoldPreparation('operation', original));
  await assert.rejects(() => store.createHoldOutcome('other', original));
  const changed = prepareComplaintHoldOutcomeFacts({ ...JSON.parse(f.body), holdEventId: 'different' }).body;
  await assert.rejects(() => preserveHoldOutcome(changed, f.context, f.keys, store));
  assert.equal([...objects.values()][0], original);
  objects.clear();
  await assert.rejects(() => readVerifiedHoldOutcome(retry.digest, f.context, f.keys, store), /unresolved/);
  assert.equal(objects.size, 0);
});

test('hold outcome facts reject extra content, invalid revisions, chronology and transaction overflow', () => {
  const facts = JSON.parse(fixture().body);
  for (const altered of [{ ...facts, reason: 'PRIVATE_SENTINEL' }, { ...facts, held: 'true' },
    { ...facts, holdRevision: 0 }, { ...facts, recordRevision: 2147483648 },
    { ...facts, transactionId: '9223372036854775808' }, { ...facts, transactionId: '01' },
    { ...facts, recordedAt: '2000-01-01T00:00:00Z' }, { ...facts, action: 'COMPLAINT_PRIMARY_PURGE_COMMITTED' }]) {
    assert.throws(() => prepareComplaintHoldOutcomeFacts(altered), { message: 'Invalid complaint hold outcome facts' });
  }
  assert.equal(prepareComplaintHoldOutcomeFacts({ ...facts, held: false }).actionAuthorized, false);
});
