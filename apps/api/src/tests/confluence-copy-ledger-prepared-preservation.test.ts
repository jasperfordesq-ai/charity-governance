import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { sealConfluenceCopyLedgerArchive, preservePreparedConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
async function fixture() {
  const body = ledgerFixture().body();
  const binding = { context, observedControl: { format: 2 as const, installationId: context.installationId,
    organisationId: context.organisationId, writerId: 'writer-a', writerEpoch: 1, generation: 2,
    digest: 'b'.repeat(64), activeOperation: null, revision: 'observed-original' } };
  let generations = 0;
  const keys: RecoveryDataKeys = { generate: async () => {
    generations++; return { key: Buffer.alloc(32,17), keyId: context.keyId, wrappedKey: Buffer.from('synthetic').toString('base64') };
  }, unwrap: async (wrappedKey,receivedContext) => {
    assert.equal(wrappedKey,Buffer.from('synthetic').toString('base64'));
    assert.deepEqual(receivedContext,context);
    return { key: Buffer.alloc(32,17), keyId: context.keyId };
  } };
  const candidate = await sealConfluenceCopyLedgerArchive(body,binding,keys);
  return { original: { body, digest: hash(body), binding }, candidate, keys, generations: () => generations };
}

test('prepared upload retries exact ciphertext after a lost write response without key generation', async () => {
  const f = await fixture(); let stored: string | null = null, writes = 0;
  const store = { readConfluenceCopyLedger: async () => stored,
    createConfluenceCopyLedger: async (_id: string, bytes: string) => { writes++; stored = bytes; throw new Error('PRIVATE-LOST-RESPONSE'); } };
  await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,store),
    { message: 'Prepared Confluence ledger preservation unresolved; retain the original candidate' });
  const retry = await preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,store);
  assert.equal(stored,f.candidate.envelope); assert.equal(writes,1); assert.equal(f.generations(),1);
  assert.equal(retry.digest,f.candidate.digest); assert.equal(retry.replayed,true);
  assert.equal(retry.archiveReadbackVerified,true); assert.equal(retry.actionAuthorized,false);
  assert.equal(retry.currentHistoryVerified,false); assert.equal(retry.reopeningAuthorised,false);
});

test('missing unpublished object uses the supplied original bytes on every attempt', async () => {
  const f = await fixture(); const written: string[] = []; let stored: string | null = null;
  const store = { readConfluenceCopyLedger: async () => stored,
    createConfluenceCopyLedger: async (_id: string, bytes: string) => { written.push(bytes); stored = bytes; return true; } };
  const result = await preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,store);
  assert.equal(result.replayed,false);
  stored = null;
  await preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,store);
  assert.deepEqual(written,[f.candidate.envelope,f.candidate.envelope]); assert.equal(f.generations(),1);
});

test('valid alternative ciphertext for the same plaintext is a conflict, not an acceptable retry', async () => {
  const f = await fixture(), other = await sealConfluenceCopyLedgerArchive(f.original.body,f.original.binding,f.keys);
  assert.notEqual(other.envelope,f.candidate.envelope); let writes = 0;
  await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,{
    readConfluenceCopyLedger: async () => other.envelope,
    createConfluenceCopyLedger: async () => { writes++; return true; },
  }));
  assert.equal(writes,0);
});

test('candidate binding, plaintext and both digests are checked before any object lookup', async () => {
  const f = await fixture(); let calls = 0;
  const store = { readConfluenceCopyLedger: async () => { calls++; return null; },
    createConfluenceCopyLedger: async () => { calls++; return true; } };
  const changedBody = f.original.body.replace('22:00:00.000Z','22:00:01.000Z');
  for (const [original,candidate] of [
    [{ ...f.original, digest: '0'.repeat(64) },f.candidate],
    [f.original,{ ...f.candidate, digest: '0'.repeat(64) }],
    [{ ...f.original, body: changedBody, digest: hash(changedBody) },f.candidate],
    [{ ...f.original, binding: { ...f.original.binding, context: { ...context, operationId: 'other' } } },f.candidate],
    [f.original,{ envelope: f.candidate.envelope + ' ', digest: hash(f.candidate.envelope + ' ') }],
  ] as const) await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(original,candidate,f.keys,store));
  assert.equal(calls,0);
});

test('conditional-write collision and missing/changed readback cannot be acknowledged', async () => {
  const f = await fixture();
  for (const readback of [null,'corrupt']) {
    let reads = 0;
    await assert.rejects(preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,{
      readConfluenceCopyLedger: async () => ++reads === 1 ? null : readback,
      createConfluenceCopyLedger: async () => false,
    }));
  }
  let reads = 0;
  const collision = await preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,f.keys,{
    readConfluenceCopyLedger: async () => ++reads === 1 ? null : f.candidate.envelope,
    createConfluenceCopyLedger: async () => false,
  });
  assert.equal(collision.replayed,true);
});

test('structurally valid ciphertext with inconsistent ledger records refuses before external object I/O', async () => {
  const f = await fixture(), ledger = JSON.parse(f.original.body);
  ledger.tables.ConfluenceCopyPublicationReceipt[0].planId = 'missing-plan';
  const body = JSON.stringify(ledger);
  const candidate = await sealConfluenceCopyLedgerArchive(body,f.original.binding,f.keys);
  let reads = 0;
  await assert.rejects(preservePreparedConfluenceCopyLedgerArchive({ ...f.original, body, digest: hash(body) },candidate,f.keys,{
    readConfluenceCopyLedger: async () => { reads++; return null; },
    createConfluenceCopyLedger: async () => { throw new Error('Must not write'); },
  }));
  assert.equal(reads,0);
});

test('caller mutation during unwrap cannot replace the validated original candidate or operation', async () => {
  const f = await fixture(); let stored: string | null = null; const operationIds: string[] = [];
  const originalEnvelope = f.candidate.envelope;
  const unwrapOnly = { unwrap: async (wrappedKey: string,receivedContext: typeof context) => {
    f.original.body = 'replacement'; f.candidate.envelope = 'replacement';
    f.original.binding.context = { ...context, operationId: 'other' };
    return f.keys.unwrap(wrappedKey,receivedContext);
  } };
  await preservePreparedConfluenceCopyLedgerArchive(f.original,f.candidate,unwrapOnly,{
    readConfluenceCopyLedger: async id => { operationIds.push(id); return stored; },
    createConfluenceCopyLedger: async (id,bytes) => { operationIds.push(id); stored = bytes; return true; },
  });
  assert.equal(stored,originalEnvelope); assert.deepEqual(operationIds,[context.operationId,context.operationId,context.operationId]);
});
