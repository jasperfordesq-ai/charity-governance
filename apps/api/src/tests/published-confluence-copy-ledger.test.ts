import { publishedLedgerFixture as fixture } from './fixtures/published-confluence-copy-ledger.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceCopyLocalLedger } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import { publishVerifiedConfluenceCopyLedger } from '../services/published-confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { readConfluenceCopyDecisionHistory } from '../services/confluence-copy-decision-history.js';


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
  await f.reserve(); await assert.rejects(f.publish,/candidate prefix/); assert.equal(f.rows.size,0);
});
