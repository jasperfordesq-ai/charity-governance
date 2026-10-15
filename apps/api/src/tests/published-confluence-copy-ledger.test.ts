import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, type RecoveryControlValue } from '../services/recovery-operation-reservation.js';
import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import { publishVerifiedConfluenceCopyLedger, readPublishedConfluenceCopyLedger } from '../services/published-confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { readConfluenceCopyDecisionHistory } from '../services/confluence-copy-decision-history.js';

async function fixture() {
  const identity = { installationId: context.installationId, organisationId: context.organisationId };
  const initial = { format: 2 as const, ...identity, writerId: 'writer-a', writerEpoch: context.writerEpoch,
    generation: 0, digest: null, activeOperation: null, revision: 'revision-0' };
  const state = { current: structuredClone(initial) as RecoveryControlValue & { revision: string },
    version: 0, loseEntryAck: false, loseHeadAck: false, mutateWhileOpen: false };
  const control = { readControl: async () => structuredClone(state.current),
    compareAndSwapControl: async (revision: string,next: RecoveryControlValue) => {
      if (state.current.revision !== revision) return false;
      state.current = { ...next, revision: `revision-${++state.version}` };
      if (state.loseHeadAck) { state.loseHeadAck = false; throw new Error('Synthetic lost head acknowledgement'); }
      return true;
    } };
  const prepared = prepareConfluenceCopyLocalLedger({ format: 1, kind: 'CONFLUENCE_COPY_LOCAL_LEDGER_V1', ...identity,
    actorUserId: 'owner-a', declaredSourceRevision: context.sourceRevision, capturedAt: '2026-10-15T22:00:00.000Z',
    tables: Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map(name => [name,[]])) });
  const binding = { context, observedControl: structuredClone(initial) };
  const keys: RecoveryDataKeys = { generate: async () => ({ key: Buffer.alloc(32,17), keyId: context.keyId, wrappedKey: 'dGVzdA==' }),
    unwrap: async () => {
      if (state.mutateWhileOpen) state.current.revision = 'changed-while-opening';
      return { key: Buffer.alloc(32,17), keyId: context.keyId };
    } };
  const original = await sealConfluenceCopyLedgerArchive(prepared.body,binding,keys);
  let envelope: string | null = original.envelope;
  const objects = { readConfluenceCopyLedger: async () => envelope };
  const rows = new Map<string,string>();
  const journal = new RecoveryAuthorityJournal({ read: async key => rows.get(key) ?? null,
    create: async (key,body) => {
      if (rows.has(key)) return false;
      rows.set(key,body);
      if (state.loseEntryAck) { state.loseEntryAck = false; throw new Error('Synthetic lost entry acknowledgement'); }
      return true;
    } },identity,{ ...identity, generation: 0, digest: null });
  const reserve = () => reserveRecoveryOperation({ ...identity, operationId: context.operationId, writerId: 'writer-a',
    writerEpoch: context.writerEpoch, preparationDigest: prepared.digest, expectedGeneration: 0, expectedDigest: null },control);
  const publish = () => publishVerifiedConfluenceCopyLedger(journal,control,prepared.digest,binding,keys,objects);
  const read = () => readPublishedConfluenceCopyLedger(journal,control,binding,keys,objects);
  return { state, prepared, binding, original, keys, rows, journal, control, reserve, publish, read,
    replace: (body: string | null) => { envelope = body; } };
}

test('reserved archive publication binds original encrypted ledger to the observed predecessor and keeps the slot', async () => {
  const f = await fixture(); await f.reserve(); const published = await f.publish();
  assert.equal(published.headPublished,true); assert.equal(published.actionAuthorized,false);
  assert.equal((await f.publish()).replayed,true);
  const result = await f.read(); assert.equal(result.body,f.prepared.body);
  assert.equal(result.envelopeDigest,f.original.digest); assert.equal(result.archiveAtObservedHead,true);
  assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false);
  assert.equal(f.state.current.activeOperation?.preparationDigest,f.prepared.digest);
  assert.equal(JSON.parse([...f.rows.values()][0]!).kind,'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1');
});

for (const boundary of ['entry','head'] as const) test(`lost ${boundary} acknowledgement retries original archive without rewriting payload or entry`, async () => {
  const f = await fixture(); await f.reserve();
  if (boundary === 'entry') f.state.loseEntryAck = true; else f.state.loseHeadAck = true;
  await assert.rejects(f.publish,/unknown/); const originalRows = [...f.rows.values()];
  assert.equal((await f.publish()).replayed,true); assert.deepEqual([...f.rows.values()],originalRows);
  assert.equal((await f.read()).body,f.prepared.body); assert.equal(f.state.current.generation,1);
});

for (const scenario of ['no-slot','other-writer','other-epoch','other-operation','other-facts','missing','corrupt','open-race'] as const) {
  test(`archive publication refuses ${scenario} before journal write`, async () => {
    const f = await fixture(); if (scenario !== 'no-slot') await f.reserve();
    if (scenario === 'other-writer') f.state.current.writerId = 'other';
    if (scenario === 'other-epoch') f.state.current.writerEpoch++;
    if (scenario === 'other-operation') f.state.current.activeOperation!.operationId = 'other';
    if (scenario === 'other-facts') f.state.current.activeOperation!.preparationDigest = 'f'.repeat(64);
    if (scenario === 'missing') f.replace(null);
    if (scenario === 'corrupt') f.replace(f.original.envelope + ' ');
    if (scenario === 'open-race') f.state.mutateWhileOpen = true;
    await assert.rejects(f.publish); assert.equal(f.rows.size,0); assert.equal(f.state.current.generation,0);
  });
}

test('generic journal APIs cannot publish an archive without its exact reservation', async () => {
  const f = await fixture();
  const input = { operationId: context.operationId, kind: 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1' as const,
    factsDigest: f.original.digest, expectedGeneration: 0, expectedDigest: null };
  await assert.rejects(f.journal.append(input),/reserved/);
  await assert.rejects(f.journal.appendPublished(input,{ readHead: async () => { throw new Error('unexpected read'); },
    compareAndSwap: async () => { throw new Error('unexpected write'); } }),/reserved/);
  assert.equal(f.rows.size,0);
});

test('missing/re-encrypted published archive refuses without reconstruction or slot release', async () => {
  const f = await fixture(); await f.reserve(); await f.publish(); const rows = [...f.rows.values()];
  f.replace((await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys)).envelope);
  await assert.rejects(f.publish); await assert.rejects(f.read);
  f.replace(null); await assert.rejects(f.publish); await assert.rejects(f.read);
  assert.deepEqual([...f.rows.values()],rows); assert.notEqual(f.state.current.activeOperation,null);
});

test('later journal entry makes the older archive unusable as current recovery evidence', async () => {
  const f = await fixture(); await f.reserve(); await f.publish();
  const first = { ...f.state.current };
  const laterOperation = 'later-facts';
  // Synthetic release/setup, not a supported release API or production change.
  f.state.current = { ...first, activeOperation: { operationId: laterOperation, preparationDigest: 'c'.repeat(64) }, revision: 'synthetic-later-slot' };
  await f.journal.appendReservedConfluenceCopyState({ operationId: laterOperation, writerId: 'writer-a', writerEpoch: 1,
    preparationDigest: 'c'.repeat(64), envelopeDigest: 'd'.repeat(64), expectedGeneration: 1, expectedDigest: first.digest },f.control);
  await assert.rejects(f.read,/latest|current|head/); await assert.rejects(f.publish);
});

test('reader refuses writer replacement and control changes while decrypting a current archive', async () => {
  const f = await fixture(); await f.reserve(); await f.publish();
  f.state.current.writerId = 'replacement'; await assert.rejects(f.read);
  f.state.current.writerId = 'writer-a'; f.state.mutateWhileOpen = true; await assert.rejects(f.read);
});

test('decision-only recovery still refuses archive payloads rather than silently filtering a mixed protocol', async () => {
  const f = await fixture(); await f.reserve(); await f.publish();
  await assert.rejects(readConfluenceCopyDecisionHistory(f.journal,f.control,f.keys,
    { readConfluenceCopyState: async () => { throw new Error('Must not read archive as a decision payload'); } },[context.keyId]),/Unsupported journal kind/);
});

test('a changed observed predecessor and a later head are refused before publication', async () => {
  const f = await fixture(); await f.reserve();
  const changed = { ...f.binding, observedControl: { ...f.binding.observedControl, generation: 1, digest: 'e'.repeat(64) } };
  await assert.rejects(publishVerifiedConfluenceCopyLedger(f.journal,f.control,f.prepared.digest,changed,f.keys,
    { readConfluenceCopyLedger: async () => f.original.envelope }));
  f.state.current.generation = 2; f.state.current.digest = 'e'.repeat(64);
  await assert.rejects(f.publish); assert.equal(f.rows.size,0);
});

test('authenticated but internally inconsistent archive cannot write a journal entry', async () => {
  const f = await fixture(), raw = JSON.parse(f.prepared.body);
  raw.tables.ConfluenceCopyPublicationReceipt.push({ id: 'orphan-receipt', organisationId: context.organisationId,
    planId: 'missing-plan', actorUserId: 'owner-a', envelopeDigest: 'b'.repeat(64), entryGeneration: 1,
    entryDigest: 'c'.repeat(64), verifiedHeadRevision: 'declared-observation', recordedAt: '2026-10-15T18:00:00.000Z' });
  Object.assign(f.prepared,prepareConfluenceCopyLocalLedger(raw));
  f.replace((await sealConfluenceCopyLedgerArchive(f.prepared.body,f.binding,f.keys)).envelope);
  await f.reserve(); await assert.rejects(f.publish,/relationships/); assert.equal(f.rows.size,0);
});
