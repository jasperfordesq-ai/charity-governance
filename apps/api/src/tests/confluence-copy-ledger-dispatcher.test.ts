import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceCopyLedgerDispatcher } from '../services/confluence-copy-ledger-dispatcher.js';
import { publishedLedgerFixture } from './fixtures/published-confluence-copy-ledger.js';

async function fixture() {
  const f = await publishedLedgerFixture(); f.replace(null);
  const capture = { id: 'capture-a', organisationId: 'org-a', actorUserId: 'owner-a', operationId: f.binding.context.operationId,
    context: f.binding.context, observedControl: f.binding.observedControl, facts: f.prepared.body, factsDigest: f.prepared.digest,
    capturedAt: new Date('2026-10-15T22:00:00.000Z'), recordedAt: new Date('2026-10-15T22:00:01.000Z') };
  const candidate = { id: 'candidate-a', organisationId: 'org-a', captureId: capture.id, actorUserId: 'owner-a',
    envelope: f.original.envelope, envelopeDigest: f.original.digest, recordedAt: new Date('2026-10-15T22:00:02.000Z') };
  const state = { owner: true, puts: 0, losePut: false, rejectPut: false, loseIntent: false, releases: 0,
    loseRelease: false, attempt: null as null | Record<string,unknown>, progress: [] as Array<Record<string,unknown>> };
  const tx = { $executeRaw: async () => 0, $queryRaw: async () => [],
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => ({ id: 'org-a' }) },
    confluenceCopyLedgerCandidate: { findFirst: async () => ({ ...candidate, capture }) },
    confluenceCopyLedgerUploadAttempt: {
      findUnique: async () => structuredClone(state.attempt),
      create: async ({ data }: { data: Record<string,unknown> }) => {
        assert.equal(state.attempt,null); state.attempt = { id: 'attempt-a', ...data, recordedAt: new Date() };
        return structuredClone(state.attempt);
      },
    },
    confluenceCopyLedgerProgress: {
      findMany: async () => structuredClone(state.progress),
      findUnique: async ({ where }: { where: { candidateId_stage: { stage: string } } }) =>
        structuredClone(state.progress.find(row => row.stage === where.candidateId_stage.stage) ?? null),
      create: async ({ data }: { data: Record<string,unknown> }) => {
        const row = { id: `progress-${state.progress.length + 1}`, ...data, recordedAt: new Date() };
        state.progress.push(row); return structuredClone(row);
      },
    },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
    const before = state.attempt; const result = await fn(tx);
    if (!before && state.attempt && state.loseIntent) { state.loseIntent = false; throw new Error('PRIVATE-INTENT-COMMIT-LOST'); }
    return result;
  } };
  const objects = { ...f.objects, createConfluenceCopyLedger: async (_id: string,bytes: string) => {
    state.puts++;
    if (state.rejectPut) throw new Error('PRIVATE-PUT-UNKNOWN');
    f.replace(bytes);
    if (state.losePut) { state.losePut = false; throw new Error('PRIVATE-PUT-RESPONSE-LOST'); }
    return true;
  } };
  const control = { ...f.control, compareAndSwapControl: async (revision: string,next: Parameters<typeof f.control.compareAndSwapControl>[1]) => {
    const deferLoss = f.state.loseHeadAck && next.generation === 0;
    if (deferLoss) f.state.loseHeadAck = false;
    try { return await f.control.compareAndSwapControl(revision,next); }
    finally { if (deferLoss) f.state.loseHeadAck = true; }
  }, releaseConfluenceCopyLedgerControl: async (revision: string) => {
    if (revision !== f.state.current.revision) return false;
    state.releases++; f.state.current = { ...f.state.current, activeOperation: null, revision: `released-${state.releases}` };
    if (state.loseRelease) { state.loseRelease = false; throw new Error('PRIVATE-RELEASE-LOST'); }
    return true;
  } };
  const deps = { journal: f.journal, control, objects, keys: { ...f.keys,
    generate: async () => { throw new Error('Dispatch must not generate a new key'); } } };
  const resume = () => new ConfluenceCopyLedgerDispatcher(prisma as never).resume('org-a','owner-a','candidate-a',deps);
  return { f, state, deps, resume };
}

test('dispatcher preserves original ciphertext, publishes and records acknowledgement without content deletion', async () => {
  const h = await fixture(), result = await h.resume();
  assert.equal(h.state.puts,1); assert.equal(h.state.releases,1); assert.ok(h.state.attempt);
  assert.deepEqual(h.state.progress.map(row => row.stage),['PUBLISHED','ACKNOWLEDGED']);
  assert.equal(result.metadataDispatchAcknowledged,true); assert.equal(result.actionAuthorized,false);
  assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false);
  await h.resume(); assert.equal(h.state.puts,1); assert.equal(h.state.releases,1);
});

for (const failure of ['put','entry','head','release'] as const) {
  test(`fresh dispatcher resumes lost ${failure} response using saved original bytes`, async () => {
    const h = await fixture();
    if (failure === 'put') h.state.losePut = true;
    if (failure === 'entry') h.f.state.loseEntryAck = true;
    if (failure === 'head') h.f.state.loseHeadAck = true;
    if (failure === 'release') h.state.loseRelease = true;
    await assert.rejects(h.resume,/unresolved/);
    await h.resume(); assert.equal(h.state.puts,1); assert.equal(h.state.releases,1);
    assert.equal(h.state.progress.length,2);
  });
}

test('lost attempt commit before upload quarantines missing bytes instead of issuing a create on retry', async () => {
  const h = await fixture(); h.state.loseIntent = true;
  await assert.rejects(h.resume); assert.ok(h.state.attempt); assert.equal(h.state.puts,0);
  await assert.rejects(h.resume,/unresolved/); assert.equal(h.state.puts,0); assert.equal(h.state.releases,0);
});

test('unknown upload with no object never gets a second create attempt', async () => {
  const h = await fixture(); h.state.rejectPut = true;
  await assert.rejects(h.resume); h.state.rejectPut = false;
  await assert.rejects(h.resume); assert.equal(h.state.puts,1); assert.equal(h.state.releases,0);
});

test('missing published object refuses even when local publication progress was never saved', async () => {
  const h = await fixture(); h.f.state.loseHeadAck = true;
  await assert.rejects(h.resume); assert.equal(h.state.progress.length,0);
  h.f.replace(null);
  await assert.rejects(h.resume); assert.equal(h.state.puts,1); assert.equal(h.state.releases,0);
});

test('a foreign reservation or revoked Owner refuses without uploading or releasing', async () => {
  for (const scenario of ['foreign','owner'] as const) {
    const h = await fixture();
    if (scenario === 'owner') h.state.owner = false;
    else h.f.state.current.activeOperation = { operationId: 'other', preparationDigest: '0'.repeat(64) };
    await assert.rejects(h.resume); assert.equal(h.state.puts,0); assert.equal(h.state.releases,0);
  }
});

test('competing dispatchers converge without a second creation request', async () => {
  const h = await fixture();
  await Promise.allSettled([h.resume(),h.resume()]);
  await h.resume(); assert.equal(h.state.puts,1); assert.equal(h.state.releases,1);
  assert.equal(h.state.progress.length,2);
});

test('corrupt saved upload binding refuses rather than treating it as an unused attempt', async () => {
  const h = await fixture(); h.state.losePut = true;
  await assert.rejects(h.resume);
  h.state.attempt!.actorUserId = 'other';
  await assert.rejects(h.resume); assert.equal(h.state.puts,1); assert.equal(h.state.releases,0);
});
