import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { prepareComplaintSourceFact } from '../services/complaint-source-fact.js';
import { openComplaintSourceFact, preserveComplaintSourceCandidate,
  readVerifiedComplaintSourceFact, sealComplaintSourceFact } from '../services/complaint-source-envelope.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
function fixture() {
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'snapshot-1',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId };
  const body = prepareComplaintSourceFact({ format: 1, kind: 'COMPLAINT_SOURCE_FACT',
    installationId: context.installationId, organisationId: context.organisationId,
    operationId: context.operationId, writerEpoch: context.writerEpoch,
    sourceRevision: context.sourceRevision, mode: 'BASELINE', previousRecordRevision: null,
    recordedAt: '2026-10-09T02:00:00.000Z', record: {
      id: 'case-1', organisationId: 'charity', receivedDate: '2026-10-01T00:00:00.000Z',
      source: 'Synthetic form', summary: 'Synthetic private complaint narrative',
      actionTaken: null, outcome: null, status: 'OPEN', reviewedByBoard: false,
      boardMinuteReference: null, revision: 3, removedAt: null, removalId: null,
      createdAt: '2026-10-09T01:00:00.000Z', updatedAt: '2026-10-09T01:00:00.000Z',
    } }).body;
  const retained = new Map<string, Buffer>(); const delivered: Buffer[] = [];
  const keys: RecoveryDataKeys = {
    async generate() { const key = randomBytes(32), wrappedKey = randomBytes(48).toString('base64');
      retained.set(wrappedKey, Buffer.from(key)); delivered.push(key); return { key, keyId, wrappedKey }; },
    async unwrap(wrappedKey) { const key = Buffer.from(retained.get(wrappedKey)!);
      delivered.push(key); return { key, keyId }; },
  };
  return { context, body, keys, delivered };
}

test('synthetic complaint source envelope hides narrative and binds exact context', async () => {
  const f = fixture();
  const sealed = await sealComplaintSourceFact(f.body, f.context, f.keys);
  assert.equal(sealed.bindingAuthorized, false);
  assert.ok(!sealed.envelope.includes('Synthetic private complaint narrative'));
  assert.equal((await openComplaintSourceFact(sealed.envelope, f.context, f.keys)).body, f.body);
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
  await assert.rejects(() => openComplaintSourceFact(sealed.envelope,
    { ...f.context, organisationId: 'other' }, f.keys), /could not be decrypted/);
  const altered = JSON.parse(sealed.envelope);
  altered.sealed.ciphertext = 'AAAA' + altered.sealed.ciphertext.slice(4);
  await assert.rejects(() => openComplaintSourceFact(JSON.stringify(altered), f.context, f.keys), /could not be decrypted/);
});

test('unknown candidate write retries same identity and a trusted digest selects exact bytes', async () => {
  const f = fixture(); let saved: string | null = null; let loseAck = true;
  const store = { async readSourceFact() { return saved; },
    async createSourceFact(_id: string, envelope: string) {
      if (saved !== null) return false;
      saved = envelope;
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
      return true;
    } };
  await assert.rejects(() => preserveComplaintSourceCandidate(f.body, f.context, f.keys, store), /unresolved/);
  const original = saved!;
  const retry = await preserveComplaintSourceCandidate(f.body, f.context, f.keys, store);
  assert.equal(retry.replayed, true);
  assert.equal(retry.bindingAuthorized, false);
  assert.equal(saved, original);
  assert.equal((await readVerifiedComplaintSourceFact(retry.digest, f.context, f.keys, store)).body, f.body);
  await assert.rejects(() => readVerifiedComplaintSourceFact('0'.repeat(64), f.context, f.keys, store), /unresolved/);
  const changed = JSON.parse(f.body); changed.record.summary = 'Different synthetic complaint';
  await assert.rejects(() => preserveComplaintSourceCandidate(
    prepareComplaintSourceFact(changed).body, f.context, f.keys, store), /unresolved/);
  assert.equal(saved, original);
  saved = null;
  await assert.rejects(() => readVerifiedComplaintSourceFact(retry.digest, f.context, f.keys, store), /unresolved/);
});

test('competing candidate creators observe one immutable winning envelope', async () => {
  const f = fixture(); let saved: string | null = null;
  const store = { async readSourceFact() { return saved; },
    async createSourceFact(_id: string, envelope: string) {
      if (saved !== null) return false;
      saved = envelope; return true;
    } };
  const results = await Promise.all([1, 2].map(() =>
    preserveComplaintSourceCandidate(f.body, f.context, f.keys, store)));
  assert.equal(results[0]!.digest, results[1]!.digest);
  assert.equal(results.filter(result => result.replayed).length, 1);
});

test('S3 candidate transport enforces exact scope, conditional creation and KMS metadata', async () => {
  const f = fixture(); const sealed = await sealComplaintSourceFact(f.body, f.context, f.keys);
  const objects = new Map<string, string>();
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const client = new S3Client({ region: 'eu-west-1', credentials });
  const storageKey = `complaint-source/install/charity/${f.context.operationId}.json`;
  const kmsKeyArn = keyId.replace('11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222');
  let calls = 0;
  client.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    calls++;
    assert.equal(command.input.Key, storageKey);
    assert.equal(command.input.ExpectedBucketOwner, '123456789012');
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (!body) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: kmsKeyArn, ContentLength: Buffer.byteLength(body),
        Body: Readable.from([Buffer.from(body)]) };
    }
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.SSEKMSKeyId, kmsKeyArn);
    assert.ok(!String(command.input.Body).includes('Synthetic private complaint narrative'));
    if (objects.has(command.input.Key!)) throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
    objects.set(command.input.Key!, String(command.input.Body));
    return { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyArn };
  }) as typeof client.send;
  const store = new S3AuthorityObjectStore({ bucket: 'synthetic-source', accountId: '123456789012',
    kmsKeyArn, replayKeyArn: keyId, installationId: 'install', organisationId: 'charity' }, credentials, client);
  assert.equal(await store.createSourceFact(f.context.operationId, sealed.envelope), true);
  assert.equal(await store.createSourceFact(f.context.operationId, sealed.envelope), false);
  assert.equal(await store.readSourceFact(f.context.operationId), sealed.envelope);
  await assert.rejects(() => store.createSourceFact('wrong-operation', sealed.envelope), /scope mismatch/);
  assert.equal(calls, 3);
  client.destroy();
});
