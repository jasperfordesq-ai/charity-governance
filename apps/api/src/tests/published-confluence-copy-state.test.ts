import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, type RecoveryControlValue } from '../services/recovery-operation-reservation.js';
import { prepareConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-facts.js';
import { sealConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import { publishVerifiedConfluenceCopyState, readPublishedConfluenceCopyState } from '../services/published-confluence-copy-state.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

async function fixture() {
  const facts = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const binding = { installationId: context.installationId, organisationId: context.organisationId };
  const state = { control: { format: 2, ...binding, writerId: 'writer-a', writerEpoch: context.writerEpoch,
    generation: 0, digest: null, activeOperation: null, revision: 'revision-0' } as RecoveryControlValue & { revision: string },
    reads: 0, changeOnRead: 0, version: 0, loseHeadAck: false, loseEntryAck: false };
  const control = {
    readControl: async () => {
      state.reads++;
      if (state.reads === state.changeOnRead) state.control = { ...state.control, writerId: 'other-writer', revision: 'changed' };
      return structuredClone(state.control);
    },
    compareAndSwapControl: async (revision: string, next: RecoveryControlValue) => {
      if (revision !== state.control.revision) return false;
      state.control = { ...next, revision: `revision-${++state.version}` };
      if (state.loseHeadAck) { state.loseHeadAck = false; throw new Error('Synthetic head acknowledgement lost'); }
      return true;
    },
  };
  const keys: RecoveryDataKeys = {
    generate: async () => ({ key: Buffer.alloc(32,7), wrappedKey: Buffer.from('synthetic-key').toString('base64'), keyId: context.keyId }),
    unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }),
  };
  const original = await sealConfluenceCopyRecoveryFacts(facts.body,context,keys);
  let envelope: string | null = original.envelope;
  const objects = { readConfluenceCopyState: async () => envelope };
  const rows = new Map<string,string>();
  const journal = new RecoveryAuthorityJournal({
    read: async key => rows.get(key) ?? null,
    create: async (key,body) => {
      if (rows.has(key)) return false;
      rows.set(key,body);
      if (state.loseEntryAck) { state.loseEntryAck = false; throw new Error('Synthetic entry acknowledgement lost'); }
      return true;
    },
  },binding,{ ...binding, generation: 0, digest: null });
  const request = { writerId: 'writer-a', preparationDigest: facts.digest, expectedGeneration: 0, expectedDigest: null };
  const reserve = () => reserveRecoveryOperation({ ...binding, ...request, writerEpoch: context.writerEpoch, operationId: context.operationId },control);
  const publish = () => publishVerifiedConfluenceCopyState(journal,control,request,context,keys,objects);
  const read = () => readPublishedConfluenceCopyState(journal,control,context,keys,objects);
  return { facts, state, rows, journal, control, keys, original, request, reserve, publish, read,
    replace: (value: string | null) => { envelope = value; } };
}

test('exact reservation publishes decrypted original state and authenticates it against current history', async () => {
  const f = await fixture(); await f.reserve(); const receipt = await f.publish();
  assert.equal(receipt.headPublished,true); assert.equal(receipt.actionAuthorized,false);
  assert.equal(receipt.currentHistoryVerified,false); assert.equal(receipt.reopeningAuthorised,false);
  const entry = JSON.parse([...f.rows.values()][0]!);
  assert.equal(entry.kind,'CONFLUENCE_COPY_DECISION_STATE_V1');
  assert.equal(entry.factsDigest,f.original.digest);
  assert.equal(f.state.control.activeOperation?.preparationDigest,f.facts.digest);
  assert.equal((await f.publish()).replayed,true);
  const read = await f.read();
  assert.equal(read.body,f.facts.body); assert.equal(read.envelopeDigest,f.original.digest);
  assert.equal(read.currentHistoryVerified,false); assert.equal(read.reopeningAuthorised,false);
  assert.equal(read.actionAuthorized,false);
});

for (const boundary of ['entry','head'] as const) test(`lost ${boundary} acknowledgement retries the exact operation without rewriting bytes`, async () => {
  const f = await fixture(); await f.reserve();
  if (boundary === 'entry') f.state.loseEntryAck = true; else f.state.loseHeadAck = true;
  await assert.rejects(f.publish, /unknown/);
  const originalRows = [...f.rows.values()];
  assert.equal(originalRows.length,1);
  assert.equal((await f.publish()).replayed,true);
  assert.deepEqual([...f.rows.values()],originalRows);
  assert.equal(f.state.control.generation,1);
  assert.equal(f.state.control.activeOperation?.operationId,context.operationId);
});

for (const scenario of ['unreserved','wrong-writer','wrong-epoch','wrong-charity','wrong-operation','wrong-facts','missing','corrupt','changed-during-open','changed-before-append'] as const) {
  test(`publication refuses ${scenario} without writing history`, async () => {
    const f = await fixture(); if (scenario !== 'unreserved') await f.reserve();
    if (scenario === 'wrong-writer') f.state.control.writerId = 'other-writer';
    if (scenario === 'wrong-epoch') f.state.control.writerEpoch = 2;
    if (scenario === 'wrong-charity') f.state.control.organisationId = 'other-charity';
    if (scenario === 'wrong-operation') f.state.control.activeOperation!.operationId = 'other-operation';
    if (scenario === 'wrong-facts') {
      f.request.preparationDigest = '0'.repeat(64);
      f.state.control.activeOperation!.preparationDigest = f.request.preparationDigest;
    }
    if (scenario === 'missing') f.replace(null);
    if (scenario === 'corrupt') f.replace(f.original.envelope.replace('ciphertext','invalid-field'));
    if (scenario === 'changed-during-open') {
      const unwrap = f.keys.unwrap;
      f.keys.unwrap = async (...args) => { const result = await unwrap(...args); f.state.control.revision = 'changed'; return result; };
    }
    if (scenario === 'changed-before-append') f.state.changeOnRead = f.state.reads + 3;
    await assert.rejects(f.publish);
    assert.equal(f.rows.size,0); assert.equal(f.state.control.generation,0);
  });
}

test('re-encrypted replacement and missing published object cannot be repaired by a publication retry', async () => {
  const f = await fixture(); await f.reserve(); await f.publish(); const rows = [...f.rows.values()];
  const replacement = await sealConfluenceCopyRecoveryFacts(f.facts.body,context,f.keys);
  f.replace(replacement.envelope);
  await assert.rejects(f.publish, /different facts/);
  await assert.rejects(f.read, /missing or invalid/);
  f.replace(null);
  await assert.rejects(f.publish, /missing/); await assert.rejects(f.read, /missing or invalid/);
  assert.deepEqual([...f.rows.values()],rows);
  assert.notEqual(f.state.control.activeOperation,null);
});

test('readback refuses a changed head during decryption and missing earlier journal history', async () => {
  const f = await fixture(); await f.reserve(); await f.publish();
  const unwrap = f.keys.unwrap;
  f.keys.unwrap = async (...args) => { const result = await unwrap(...args); f.state.control.revision = 'changed'; return result; };
  await assert.rejects(f.read, /changed while reading/);
  f.keys.unwrap = unwrap;
  f.rows.clear();
  await assert.rejects(f.read, /does not match/);
});
