import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceCopyLedgerProgressStore } from '../services/confluence-copy-ledger-progress-store.js';
import { publishedLedgerFixture } from './fixtures/published-confluence-copy-ledger.js';

async function fixture() {
  const f = await publishedLedgerFixture();
  const capture = { id: 'capture-a', organisationId: 'org-a', actorUserId: 'owner-a', operationId: f.binding.context.operationId,
    context: f.binding.context, observedControl: f.binding.observedControl, facts: f.prepared.body, factsDigest: f.prepared.digest,
    capturedAt: new Date('2026-10-15T22:00:00.000Z'), recordedAt: new Date('2026-10-15T22:00:01.000Z') };
  const candidate = { id: 'candidate-a', organisationId: 'org-a', captureId: capture.id, actorUserId: 'owner-a',
    envelope: f.original.envelope, envelopeDigest: f.original.digest, recordedAt: new Date('2026-10-15T22:00:02.000Z') };
  const state = { owner: true, loseCommit: false, progress: [] as Array<Record<string,unknown>> };
  const tx = { $executeRaw: async () => 0, $queryRaw: async () => [],
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => ({ id: 'org-a' }) },
    confluenceCopyLedgerCandidate: { findFirst: async () => ({ ...structuredClone(candidate), capture: structuredClone(capture) }) },
    confluenceCopyLedgerProgress: {
      findUnique: async ({ where }: { where: { candidateId_stage: { stage: string } } }) =>
        structuredClone(state.progress.find(row => row.stage === where.candidateId_stage.stage) ?? null),
      create: async ({ data }: { data: Record<string,unknown> }) => {
        const row = { id: `progress-${state.progress.length + 1}`, ...data, recordedAt: new Date() };
        state.progress.push(row); return structuredClone(row);
      },
    },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
    const result = await fn(tx);
    if (state.loseCommit && state.progress.length) { state.loseCommit = false; throw new Error('PRIVATE-LOST-COMMIT'); }
    return result;
  } };
  const deps = { journal: f.journal, control: f.control, keys: { ...f.keys,
    generate: async () => { throw new Error('Observation must not generate keys'); } }, objects: f.objects };
  const service = () => new ConfluenceCopyLedgerProgressStore(prisma as never);
  const publish = async () => { await f.reserve(); await f.publish(); };
  const clear = () => { f.state.current = { ...f.state.current, activeOperation: null, revision: 'verified-empty-slot' }; };
  return { f, capture, candidate, state, deps, service, publish, clear };
}

test('publication and empty-slot acknowledgement observations persist separately without mutating external state', async () => {
  const h = await fixture(); await h.publish();
  const control = JSON.stringify(h.f.state.current), rows = [...h.f.rows];
  const published = await h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps);
  assert.equal(published.stage,'PUBLISHED'); assert.equal(published.currentHistoryVerified,false);
  assert.equal(published.actionAuthorized,false); assert.equal(published.reopeningAuthorised,false);
  assert.equal(JSON.stringify(h.f.state.current),control); assert.deepEqual([...h.f.rows],rows);
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','ACKNOWLEDGED',h.deps));
  h.clear();
  const ack = await h.service().observe('org-a','owner-a','candidate-a','ACKNOWLEDGED',h.deps);
  assert.equal(ack.stage,'ACKNOWLEDGED'); assert.equal(h.state.progress.length,2);
});

test('lost local publication commit and new service retry keep the same progress record', async () => {
  const h = await fixture(); await h.publish(); h.state.loseCommit = true;
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps),/unresolved/);
  const original = h.state.progress[0]!.id;
  const retry = await h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps);
  assert.equal(retry.receiptId,original); assert.equal(retry.replayed,true); assert.equal(h.state.progress.length,1);
});

test('missing or changed external archive refuses even when a local progress record already exists', async () => {
  const h = await fixture(); await h.publish();
  await h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps);
  h.f.replace(null);
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps));
  assert.equal(h.state.progress.length,1);
});

test('unpublished head and acknowledgement without committed publication refuse', async () => {
  const h = await fixture();
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps));
  await h.publish(); h.clear();
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','ACKNOWLEDGED',h.deps));
  assert.equal(h.state.progress.length,0);
});

test('foreign slot, changed candidate and revoked Owner refuse without progress', async () => {
  for (const scenario of ['foreign-slot','candidate','owner'] as const) {
    const h = await fixture(); await h.publish();
    if (scenario === 'foreign-slot') h.f.state.current.activeOperation!.operationId = 'other';
    if (scenario === 'candidate') h.candidate.envelopeDigest = '0'.repeat(64);
    if (scenario === 'owner') h.state.owner = false;
    await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps),error =>
      error instanceof Error && error.cause === undefined && !error.message.includes('PRIVATE-'));
    assert.equal(h.state.progress.length,0);
  }
});

test('Owner revoked during external verification cannot record a successful observation', async () => {
  const h = await fixture(); await h.publish();
  h.deps.keys.unwrap = async (wrappedKey,context) => { h.state.owner = false; return h.f.keys.unwrap(wrappedKey,context); };
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps));
  assert.equal(h.state.progress.length,0);
});

test('a changed local receipt cannot be treated as a matching retry', async () => {
  const h = await fixture(); await h.publish();
  await h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps);
  h.state.progress[0]!.entryDigest = '0'.repeat(64);
  await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','PUBLISHED',h.deps));
  h.clear(); await assert.rejects(h.service().observe('org-a','owner-a','candidate-a','ACKNOWLEDGED',h.deps));
  assert.equal(h.state.progress.length,1);
});
