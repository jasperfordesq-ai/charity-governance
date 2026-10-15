import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive, openConfluenceCopyLedgerArchive,
  preserveConfluenceCopyLedgerArchive, readVerifiedConfluenceCopyLedgerArchive,
  CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES } from '../services/confluence-copy-ledger-envelope.js';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { openConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

function fixture() {
  const ledger = { format: 1, kind: 'CONFLUENCE_COPY_LOCAL_LEDGER_V1', installationId: context.installationId,
    organisationId: context.organisationId, actorUserId: 'owner-a', declaredSourceRevision: context.sourceRevision,
    capturedAt: '2026-10-15T22:00:00.000Z', tables: Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map((name,index) => [name,
      [{ id: `original-${index}`, organisationId: context.organisationId, recordedAt: '2026-10-15T21:00:00.000Z',
        originalEvidence: 'PRIVATE-ORIGINAL-WITHDRAWAL-AND-PUBLICATION-METADATA' }]])) };
  const prepared = prepareConfluenceCopyLocalLedger(ledger);
  const observedControl = { format: 2 as const, installationId: context.installationId, organisationId: context.organisationId,
    writerId: 'writer-a', writerEpoch: context.writerEpoch, generation: 2, digest: 'b'.repeat(64),
    activeOperation: null, revision: 'original-observed-revision' };
  const binding = { context, observedControl };
  const buffers: Buffer[] = [];
  const key = () => { const result = Buffer.alloc(32,17); buffers.push(result); return result; };
  const keys: RecoveryDataKeys = { generate: async () => ({ key: key(), keyId: context.keyId,
    wrappedKey: Buffer.from('synthetic-key').toString('base64') }),
    unwrap: async () => ({ key: key(), keyId: context.keyId }) };
  return { ledger, prepared, binding, keys, buffers };
}

test('all eight original tables round-trip encrypted with original observed control and wiped keys', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  assert.ok(!sealed.envelope.includes('PRIVATE-ORIGINAL-'));
  const opened = await openConfluenceCopyLedgerArchive(sealed.envelope,f.binding,f.keys);
  assert.equal(opened.body,f.prepared.body);
  assert.ok(f.buffers.every(key => key.every(byte => byte === 0)));
  assert.equal(opened.currentHistoryVerified,false); assert.equal(opened.reopeningAuthorised,false);
});

test('ledger refuses omitted or extra tables, foreign rows, duplicates and undeclared header fields', () => {
  const f = fixture();
  for (const mutate of [
    (v: typeof f.ledger) => { delete v.tables.ConfluenceCopyPublicationReceipt; },
    (v: typeof f.ledger) => { v.tables.Credentials = []; },
    (v: typeof f.ledger) => { v.tables.ConfluenceCopyPublicationReceipt![0]!.organisationId = 'other'; },
    (v: typeof f.ledger) => { v.tables.ConfluenceCopyPublicationReceipt!.push(v.tables.ConfluenceCopyPublicationReceipt![0]!); },
    (v: typeof f.ledger) => { Object.assign(v,{ password: 'PRIVATE-SECRET' }); },
  ]) { const value = structuredClone(f.ledger); mutate(value); assert.throws(() => prepareConfluenceCopyLocalLedger(value)); }
});

test('archive binding rejects source, tenant, operation, epoch, key and observed-control substitutions', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  for (const contextChange of [{ organisationId: 'other' },{ installationId: 'other' },{ operationId: 'other' },
    { writerEpoch: 2 },{ sourceRevision: 'c'.repeat(40) },{ keyId: context.keyId.replace('111111111111','222222222222') }]) {
    await assert.rejects(openConfluenceCopyLedgerArchive(sealed.envelope,
      { ...f.binding, context: { ...context, ...contextChange } },f.keys));
  }
  for (const change of [{ revision: 'another' },{ writerId: 'other' },{ digest: 'c'.repeat(64) }]) {
    await assert.rejects(openConfluenceCopyLedgerArchive(sealed.envelope,
      { ...f.binding, observedControl: { ...f.binding.observedControl, ...change } },f.keys));
  }
});

test('tampered ciphertext/control and duplicate JSON keys fail without exposing body or key', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  type Envelope = { sealed: { ciphertext: string }; binding: { observedControl: { revision: string } } };
  for (const mutate of [(value: Envelope) => { value.sealed.ciphertext = Buffer.from('corrupt').toString('base64'); },
    (value: Envelope) => { value.binding.observedControl.revision = 'forged'; }]) {
    const value = JSON.parse(sealed.envelope); mutate(value);
    await assert.rejects(openConfluenceCopyLedgerArchive(JSON.stringify(value),f.binding,f.keys));
  }
  await assert.rejects(openConfluenceCopyLedgerArchive(sealed.envelope.replace('{','{"format":1,'),f.binding,f.keys));
  await assert.rejects(sealConfluenceCopyLedgerArchive(f.prepared.body.replace('{','{"format":1,'),f.binding,f.keys));
  assert.ok(f.buffers.every(key => key.every(byte => byte === 0)));
});

test('unknown immutable-write acknowledgement retries the exact original archive and never overwrites changed metadata', async () => {
  const f = fixture(); let stored: string | null = null, writes = 0;
  const store = { readConfluenceCopyLedger: async () => stored,
    createConfluenceCopyLedger: async (_id: string, envelope: string) => {
      stored = envelope; writes++; throw new Error('PRIVATE-ACKNOWLEDGEMENT-LOST');
    } };
  await assert.rejects(preserveConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys,store));
  const firstStored = stored;
  const retried = await preserveConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys,store);
  assert.equal(writes,1); assert.equal(retried.replayed,true); assert.equal(stored,firstStored);
  const opened = await readVerifiedConfluenceCopyLedgerArchive(retried.digest,f.binding,f.keys,store);
  assert.equal(opened.body,f.prepared.body);
  f.ledger.capturedAt = '2026-10-15T22:00:01.000Z';
  await assert.rejects(preserveConfluenceCopyLedgerArchive(prepareConfluenceCopyLocalLedger(f.ledger).body,f.binding,f.keys,store));
  assert.equal(stored,firstStored); assert.equal(writes,1);
});

test('authenticated object reader rejects missing/replaced bytes without any reconstruction write', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  for (const body of [null,sealed.envelope + ' ']) {
    await assert.rejects(readVerifiedConfluenceCopyLedgerArchive(sealed.digest,f.binding,f.keys,
      { readConfluenceCopyLedger: async () => body }));
  }
});

test('conditional-write races use the original winner and reject different original metadata', async () => {
  for (const changed of [false,true]) {
    const f = fixture(), other = structuredClone(f.ledger);
    if (changed) other.capturedAt = '2026-10-15T22:00:02.000Z';
    const winner = await sealConfluenceCopyLedgerArchive(prepareConfluenceCopyLocalLedger(other).body,f.binding,f.keys);
    let reads = 0, writes = 0;
    const store = { readConfluenceCopyLedger: async () => ++reads === 1 ? null : winner.envelope,
      createConfluenceCopyLedger: async () => { writes++; return false; } };
    const preserved = preserveConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys,store);
    if (changed) await assert.rejects(preserved,/preservation unresolved/);
    else { const result = await preserved; assert.equal(result.digest,winner.digest); assert.equal(result.replayed,true); }
    assert.equal(writes,1); assert.equal(reads,2);
  }
});

test('invalid provider key metadata is refused and every returned key buffer is wiped', async () => {
  for (const scenario of ['wrong-key','wrong-length','bad-wrapping']) {
    const f = fixture(), buffer = Buffer.alloc(scenario === 'wrong-length' ? 31 : 32,9);
    const keys = { ...f.keys, generate: async () => ({ key: buffer,
      keyId: scenario === 'wrong-key' ? 'other-key' : context.keyId,
      wrappedKey: scenario === 'bad-wrapping' ? 'invalid-base64' : 'dGVzdA==' }) };
    await assert.rejects(sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,keys));
    assert.ok(buffer.every(byte => byte === 0));
  }
});

test('altering the supplied binding together with its header still fails AES-GCM authentication', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  const changed = { ...f.binding, observedControl: { ...f.binding.observedControl, revision: 'forged-revision' } };
  const envelope = JSON.parse(sealed.envelope); envelope.binding = changed;
  await assert.rejects(openConfluenceCopyLedgerArchive(JSON.stringify(envelope),changed,f.keys));
  envelope.binding = f.binding; envelope.wrappedKey = Buffer.from('different-wrapped-key').toString('base64');
  await assert.rejects(openConfluenceCopyLedgerArchive(JSON.stringify(envelope),f.binding,f.keys));
  assert.ok(f.buffers.every(key => key.every(byte => byte === 0)));
});

test('ledger archive is never accepted as a decision-state envelope', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  await assert.rejects(openConfluenceCopyRecoveryFacts(sealed.envelope,context,f.keys));
  const wrongGeneration = JSON.parse(sealed.envelope); wrongGeneration.sealed.generation++;
  await assert.rejects(openConfluenceCopyLedgerArchive(JSON.stringify(wrongGeneration),f.binding,f.keys));
});

const config = { bucket: 'synthetic-charitypilot-ledger', accountId: '123456789012',
  kmsKeyArn: context.keyId.replace('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'),
  replayKeyArn: context.keyId, installationId: context.installationId, organisationId: context.organisationId };
const metadata = { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
const s3 = (send: (command: GetObjectCommand | PutObjectCommand) => Promise<unknown>) =>
  new S3AuthorityObjectStore(config,{ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },{ send } as S3Client);

test('archive storage uses a separate immutable namespace and verified exact readback, with no missing-object recreation', async () => {
  const f = fixture(); let stored: string | null = null, writes = 0;
  const store = s3(async command => {
    assert.equal(command.input.Key,`confluence-copy-ledger/${context.installationId}/${context.organisationId}/${context.operationId}.json`);
    assert.equal(command.input.ExpectedBucketOwner,config.accountId); assert.equal(command.input.Bucket,config.bucket);
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch,'*'); assert.equal(command.input.SSEKMSKeyId,config.kmsKeyArn);
      assert.equal(command.input.ServerSideEncryption,'aws:kms'); assert.ok(command.input.ChecksumSHA256);
      assert.equal(typeof command.input.Body,'string'); stored = command.input.Body as string; writes++; return metadata;
    }
    assert.ok(command instanceof GetObjectCommand);
    if (stored === null) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
    return { ...metadata, ContentLength: Buffer.byteLength(stored), Body: Readable.from([Buffer.from(stored)]) };
  });
  const result = await preserveConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys,store);
  assert.equal(result.archiveReadbackVerified,true); assert.equal(result.currentHistoryVerified,false); assert.equal(writes,1);
  const original = stored;
  await preserveConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys,store);
  assert.equal(writes,1); assert.equal(stored,original);
  assert.equal((await readVerifiedConfluenceCopyLedgerArchive(result.digest,f.binding,f.keys,store)).body,f.prepared.body);
  stored = null;
  await assert.rejects(readVerifiedConfluenceCopyLedgerArchive(result.digest,f.binding,f.keys,store));
  assert.equal(writes,1);
});

test('archive storage rejects foreign envelope/unsafe operation before write and refuses invalid metadata or excess length', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  let calls = 0;
  const noCalls = s3(async () => { calls++; throw new Error('Unexpected transport call'); });
  await assert.rejects(noCalls.createConfluenceCopyLedger('other-operation',sealed.envelope));
  await assert.rejects(noCalls.readConfluenceCopyLedger('../unsafe')); assert.equal(calls,0);
  for (const change of [{ VersionId: 'null' },{ SSEKMSKeyId: context.keyId },
    { ContentLength: CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES + 1 }]) {
    const store = s3(async () => ({ ...metadata, ContentLength: Buffer.byteLength(sealed.envelope),
      Body: Readable.from([Buffer.from(sealed.envelope)]), ...change }));
    await assert.rejects(store.readConfluenceCopyLedger(context.operationId));
  }
});

test('archive storage never mistakes bucket/access failure for missing evidence or conditional-write success', async () => {
  const f = fixture(), sealed = await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys);
  for (const failure of [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    { $metadata: { httpStatusCode: 403 } },{ $metadata: { httpStatusCode: 409 } }]) {
    const store = s3(async () => { throw failure; });
    await assert.rejects(store.readConfluenceCopyLedger(context.operationId));
    await assert.rejects(store.createConfluenceCopyLedger(context.operationId,sealed.envelope));
  }
});
