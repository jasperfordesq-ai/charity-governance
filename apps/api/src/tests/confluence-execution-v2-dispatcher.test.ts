import {executionLedgerFixture} from './fixtures/confluence-execution-ledger-v2.js';
import {prepareConfluenceExecutionLedgerV2} from '../services/confluence-execution-ledger-v2.js';
import {sealConfluenceExecutionArchiveV2,openConfluenceExecutionArchiveV2} from '../services/confluence-execution-archive-v2.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceExecutionV2Dispatcher } from '../services/confluence-execution-v2-dispatcher.js';
import { publishedExecutionV2Fixture } from './fixtures/published-confluence-execution-v2.js';

async function fixture() {
  const f = await publishedExecutionV2Fixture(); f.replace(null);
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
  const objects = { ...f.objects, createExecutionLedgerV2: async (_context: unknown,bytes: string) => {
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
  }, releaseConfluenceExecutionV2Control: async (revision: string) => {
    if (revision !== f.state.current.revision) return false;
    state.releases++; f.state.current = { ...f.state.current, activeOperation: null, revision: `released-${state.releases}` };
    if (state.loseRelease) { state.loseRelease = false; throw new Error('PRIVATE-RELEASE-LOST'); }
    return true;
  } };
  const deps = { journal: f.journal, control, objects, policy:f.policy, keys: { ...f.keys,
    generate: async () => { throw new Error('Dispatch must not generate a new key'); } } };
  const resume = () => new ConfluenceExecutionV2Dispatcher(prisma as never).resume('org-a','owner-a','candidate-a',deps);
  return { f, state, deps, resume, capture, candidate };
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


test('V2 upload rechecks Owner after a provider read and before creation, with no transaction held across IO', async () => {
 const h = await fixture(); h.deps.objects.readExecutionLedgerV2 = async () => { h.state.owner = false; return null; };
 await assert.rejects(h.resume); assert.ok(h.state.attempt); assert.equal(h.state.puts,0); assert.equal(h.state.releases,0);
});
test('V2 local candidate adapter preserves prototype-backed historical readers', async () => {
 const h = await fixture();
 class Provider {
  private receiver = 'synthetic';
  async readExecutionLedgerV2() { assert.equal(this.receiver,'synthetic'); return h.f.objects.readExecutionLedgerV2(); }
  async readExecutionLedgerV2At() { assert.equal(this.receiver,'synthetic'); return h.f.objects.readExecutionLedgerV2At(); }
  async readConfluenceCopyStateHistory() { assert.equal(this.receiver,'synthetic'); return null; }
  async readConfluenceCopyLedgerHistory() { assert.equal(this.receiver,'synthetic'); return null; }
  async createExecutionLedgerV2(ctx: unknown,bytes: string) { assert.equal(this.receiver,'synthetic'); return h.deps.objects.createExecutionLedgerV2(ctx,bytes); }
 }
 // Use the original synthetic transaction client through the normal fixture,
 // replacing only its provider object to exercise prototype receiver binding.
 const original = h.deps.objects; const provider = new Provider();
 const create = original.createExecutionLedgerV2.bind(original);
 provider.createExecutionLedgerV2 = async (ctx,bytes) => create(ctx,bytes);
 h.deps.objects = provider;
 assert.equal((await h.resume()).metadataDispatchAcknowledged,true); assert.equal(h.state.puts,1);
});

test('V2 never creates a missing object if its entry becomes pending or published during the pre-upload read', async () => {
 for (const pending of [false,true]) {
  const h = await fixture(), cas = h.f.control.compareAndSwapControl;
  if (pending) h.f.control.compareAndSwapControl = async (revision,next) => next.generation === 1 ? false : cas(revision,next);
  h.deps.objects.readExecutionLedgerV2 = async () => {
   const append = h.f.journal.appendReservedConfluenceExecutionV2({ operationId:h.f.binding.context.operationId,
    writerId:h.f.binding.observedControl.writerId,writerEpoch:h.f.binding.context.writerEpoch,
    preparationDigest:h.f.prepared.digest,envelopeDigest:h.f.original.digest,expectedGeneration:0,expectedDigest:null },h.deps.control);
   if (pending) await assert.rejects(append); else await append;
   return null;
  };
  await assert.rejects(h.resume); assert.equal(h.state.puts,0); assert.equal(h.state.releases,0); assert.ok(h.state.attempt);
 }
});

test('V2 dispatcher preserves populated claim, request and outcome bytes through upload, publication and acknowledgement', async () => {
 const h = await fixture(), raw = executionLedgerFixture();
 raw.captureOperationId = h.f.binding.context.operationId;
 // These synthetic source captures have no independently published decision
 // receipts yet. Keep their original facts and all execution records intact.
 raw.tables.ConfluenceCopyPublicationPlan = []; raw.tables.ConfluenceCopyPublicationReceipt = [];
 const plain = prepareConfluenceExecutionLedgerV2(raw,h.f.binding.context);
 const sealed = await sealConfluenceExecutionArchiveV2(plain.body,h.f.binding,h.f.keys);
 Object.assign(h.capture,{ facts:plain.body,factsDigest:plain.digest });
 Object.assign(h.candidate,{ envelope:sealed.envelope,envelopeDigest:sealed.digest });
 assert.equal((await h.resume()).metadataDispatchAcknowledged,true);
 const stored = await h.f.objects.readExecutionLedgerV2(); assert.ok(stored);
 const opened = await openConfluenceExecutionArchiveV2(stored,h.f.binding,h.f.keys);
 assert.equal(opened.body,plain.body);
 for (const name of ['ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionOutcome']) {
  assert.equal(JSON.parse(opened.body).tables[name].length,1); assert.deepEqual(JSON.parse(opened.body).tables[name],raw.tables[name]);
 }
 assert.equal(h.state.puts,1); assert.equal(h.state.releases,1); assert.equal(h.state.progress.length,2);
});
