import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { publishedExecutionV2Fixture } from './fixtures/published-confluence-execution-v2.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation } from '../services/recovery-operation-reservation.js';
import { sealConfluenceExecutionArchiveV2 } from '../services/confluence-execution-archive-v2.js';
import { publishVerifiedConfluenceExecutionV2 } from '../services/confluence-execution-v2-prefix.js';
import { acknowledgeConfluenceExecutionV2Archive } from '../services/confluence-execution-v2-acknowledgement.js';

test('S3-backed archive acknowledgement survives a committed lost response without clearing a later operation', async t => {
  const f = await publishedExecutionV2Fixture();
  const { context } = f.binding;
  const identity = { installationId: context.installationId, organisationId: context.organisationId };
  const config = { ...identity, bucket: 'synthetic-confluence-archive', accountId: '123456789012',
    kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
    replayKeyArn: context.keyId };
  const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const headKey = `authority/${identity.installationId}/${identity.organisationId}/head.json`;
  const initial = { format: 2, ...identity, writerId: 'writer-a', writerEpoch: context.writerEpoch,
    generation: 0, digest: null, activeOperation: null, publicationId: randomUUID() };
  const objects = new Map([[headKey, { body: JSON.stringify(initial), version: 1 }]]);
  let version = 1, releaseWrites = 0, loseReleaseResponse = true;
  const etag = (body: string) => `"${createHash('sha256').update(body).digest('hex')}"`;
  const client = new S3Client({ region: 'eu-west-1', credentials });
  t.after(() => client.destroy());
  // Every SDK request is intercepted: no provider, keyring, database or HTTP.
  t.mock.method(client, 'send', async (command: unknown) => {
    assert.ok(command instanceof GetObjectCommand || command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, config.bucket);
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    const key = command.input.Key!;
    const existing = objects.get(key);
    const metadata = { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
    if (command instanceof GetObjectCommand) {
      if (!existing) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return { ...metadata, VersionId: `version-${existing.version}`, ETag: etag(existing.body),
        ContentLength: Buffer.byteLength(existing.body), Body: Readable.from([Buffer.from(existing.body)]) };
    }
    if ((command.input.IfNoneMatch === '*' && existing)
      || (command.input.IfMatch && (!existing || command.input.IfMatch !== etag(existing.body)))) {
      throw { $metadata: { httpStatusCode: 412 } };
    }
    assert.ok(command.input.IfNoneMatch === '*' || command.input.IfMatch, 'Every write must be conditional');
    const body = String(command.input.Body);
    objects.set(key, { body, version: ++version });
    if (key === headKey && JSON.parse(body).generation === 1 && JSON.parse(body).activeOperation === null) {
      releaseWrites++;
      if (loseReleaseResponse) { loseReleaseResponse = false; throw new Error('Synthetic committed release response loss'); }
    }
    return { ...metadata, VersionId: `version-${version}` };
  });
  const store = new S3AuthorityObjectStore(config, credentials, client);
  const binding = { context, observedControl: await store.readControl() };
  const original = await sealConfluenceExecutionArchiveV2(f.prepared.body, binding, f.keys);
  assert.equal(await store.createExecutionLedgerV2(context, original.envelope), true);
  const checkpoint = { ...identity, generation: 0, digest: null };
  const journal = new RecoveryAuthorityJournal(store, identity, checkpoint);
  await reserveRecoveryOperation({ ...identity, writerId: 'writer-a', writerEpoch: context.writerEpoch,
    operationId: context.operationId, preparationDigest: f.prepared.digest,
    expectedGeneration: 0, expectedDigest: null }, store);
  await publishVerifiedConfluenceExecutionV2(journal, store, f.prepared.digest, binding, f.keys, store,f.policy);
  const before = await store.readControl();
  const expected = { operationId: context.operationId, preparationDigest: f.prepared.digest,
    generation: before.generation,digest: before.digest!,envelopeDigest: original.digest };
  await assert.rejects(store.releaseConfluenceCopyLedgerControl(before.revision,expected));
  await assert.rejects(store.releaseConfluenceCopyStateControl(before.revision,expected));
  await assert.rejects(store.releaseControl(before.revision,{ operationId: context.operationId,preparationDigest: f.prepared.digest,
    generation: before.generation,digest: before.digest! }));
  await assert.rejects(store.releaseConfluenceExecutionV2Control(before.revision,{ ...expected,envelopeDigest: '0'.repeat(64) }));
  assert.deepEqual(await store.readControl(),before);
  await assert.rejects(() => acknowledgeConfluenceExecutionV2Archive(
    journal, store, f.prepared.digest, binding, f.keys, store,f.policy), /outcome is unknown/);
  assert.equal(releaseWrites, 1);
  assert.equal((await store.readControl()).activeOperation, null);

  // Fresh adapters, same independent object bytes: retry must authenticate again.
  const restartedStore = new S3AuthorityObjectStore(config, credentials, client);
  const restartedJournal = new RecoveryAuthorityJournal(restartedStore, identity, checkpoint);
  const acknowledge = () => acknowledgeConfluenceExecutionV2Archive(
    restartedJournal, restartedStore, f.prepared.digest, binding, f.keys, restartedStore,f.policy);
  const result = await acknowledge();
  assert.equal(result.acknowledged, true);
  assert.equal(result.replayed, true);
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.currentHistoryVerified, false);
  assert.equal(result.reopeningAuthorised, false);
  assert.equal(releaseWrites, 1);
  const after = await restartedStore.readControl();
  assert.equal(after.generation, before.generation);
  assert.equal(after.digest, before.digest);
  assert.equal(after.writerId, before.writerId);
  assert.equal(after.writerEpoch, before.writerEpoch);

  const archiveKey = `confluence-execution-ledger-v2/${identity.installationId}/${identity.organisationId}/${context.writerEpoch}/${context.operationId}.json`;
  const archive = objects.get(archiveKey)!;
  objects.delete(archiveKey);
  await assert.rejects(acknowledge);
  assert.equal(releaseWrites, 1, 'An empty slot is not a substitute for the original archive');
  objects.set(archiveKey, archive);
  await reserveRecoveryOperation({ ...identity, writerId: after.writerId, writerEpoch: after.writerEpoch,
    operationId: 'later-synthetic-operation', preparationDigest: 'f'.repeat(64),
    expectedGeneration: after.generation, expectedDigest: after.digest }, restartedStore);
  const later = await restartedStore.readControl();
  await assert.rejects(acknowledge);
  assert.deepEqual(await restartedStore.readControl(), later);
  assert.equal(later.activeOperation?.operationId, 'later-synthetic-operation');
  assert.equal(releaseWrites, 1);
});
