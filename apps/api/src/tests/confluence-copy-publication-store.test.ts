import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfluenceCopyRecoveryCapture, ConfluenceCopyPublicationPlan, ConfluenceCopyPublicationReceipt } from '@prisma/client';
import { ConfluenceCopyPublicationStore } from '../services/confluence-copy-publication-store.js';
import { prepareConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-facts.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import type { RecoveryControlValue } from '../services/recovery-operation-reservation.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

function fixture() {
  const facts = recoveryFactsFixture(), prepared = prepareConfluenceCopyRecoveryFacts(facts);
  const capture: ConfluenceCopyRecoveryCapture = { id: 'capture-a', organisationId: facts.organisationId,
    reviewId: facts.review.id, installationId: facts.installationId, operationId: facts.operationId,
    actorUserId: 'owner-a', writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision,
    factsRevision: 1, previousFactsDigest: null, facts: prepared.body, factsDigest: prepared.digest,
    capturedAt: new Date(facts.capturedAt), recordedAt: new Date(facts.capturedAt) };
  const state = { owner: true, active: true, capture, plan: null as ConfluenceCopyPublicationPlan | null,
    receipt: null as ConfluenceCopyPublicationReceipt | null, receiptFailure: false, loseReceiptCommitAck: false,
    objectWrites: 0, loseObjectAck: false, loseEntryAck: false, loseHeadAck: false,
    controlVersion: 0, control: { format: 2, installationId: facts.installationId, organisationId: facts.organisationId,
      writerId: 'writer-a', writerEpoch: 1, generation: 0, digest: null, activeOperation: null, revision: 'rev-0',
    } as RecoveryControlValue & { revision: string } };
  const tx = {
    $queryRaw: async () => [],
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    confluenceCopyRecoveryCapture: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      where.id === capture.id && where.organisationId === capture.organisationId ? structuredClone(state.capture) : null },
    confluenceCopyPublicationPlan: {
      findUnique: async () => state.plan ? structuredClone(state.plan) : null,
      findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
        state.plan?.id === where.id && state.plan.organisationId === where.organisationId
          ? { ...structuredClone(state.plan), capture: structuredClone(state.capture), receipt: structuredClone(state.receipt) } : null,
      create: async ({ data }: { data: Omit<ConfluenceCopyPublicationPlan,'id' | 'recordedAt'> }) => {
        state.plan = { id: 'plan-a', recordedAt: new Date(facts.capturedAt), ...data }; return structuredClone(state.plan);
      },
    },
    confluenceCopyPublicationReceipt: { create: async ({ data }: { data: Omit<ConfluenceCopyPublicationReceipt,'id' | 'recordedAt'> }) => {
      if (state.receiptFailure) throw new Error('Synthetic local receipt failure');
      state.receipt = { id: 'receipt-a', recordedAt: new Date(), ...data }; return structuredClone(state.receipt);
    } },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
    const result = await fn(tx);
    if (state.receipt && state.loseReceiptCommitAck) { state.loseReceiptCommitAck = false; throw new Error('Synthetic receipt commit acknowledgement lost'); }
    return result;
  } };
  const objects = new Map<string,string>(), entries = new Map<string,string>();
  const control = {
    readControl: async () => structuredClone(state.control),
    compareAndSwapControl: async (revision: string, next: RecoveryControlValue) => {
      if (revision !== state.control.revision) return false;
      const publishing = next.generation > state.control.generation;
      state.control = { ...next, revision: `rev-${++state.controlVersion}` };
      if (publishing && state.loseHeadAck) { state.loseHeadAck = false; throw new Error('Synthetic lost head acknowledgement'); }
      return true;
    },
  };
  const journal = new RecoveryAuthorityJournal({ read: async key => entries.get(key) ?? null,
    create: async (key,body) => {
      if (entries.has(key)) return false; entries.set(key,body);
      if (state.loseEntryAck) { state.loseEntryAck = false; throw new Error('Synthetic lost entry acknowledgement'); } return true;
    } },{ installationId: context.installationId, organisationId: context.organisationId },
    { installationId: context.installationId, organisationId: context.organisationId, generation: 0, digest: null });
  const keys: RecoveryDataKeys = {
    generate: async supplied => {
      assert.equal(state.plan?.keyId,supplied.keyId,'plan must commit the key before external I/O');
      return { key: Buffer.alloc(32,7), wrappedKey: Buffer.from('synthetic-key').toString('base64'), keyId: supplied.keyId };
    }, unwrap: async (_key,supplied) => ({ key: Buffer.alloc(32,7), keyId: supplied.keyId }),
  };
  const deps = { journal, control, keys, objects: {
    readConfluenceCopyState: async (id: string) => objects.get(id) ?? null,
    createConfluenceCopyState: async (id: string,body: string) => {
      assert.ok(state.plan,'durable plan must exist before external object write');
      if (objects.has(id)) return false; objects.set(id,body); state.objectWrites++;
      if (state.loseObjectAck) { state.loseObjectAck = false; throw new Error('Synthetic lost object acknowledgement'); } return true;
    },
  } };
  const input = { captureId: capture.id, writerId: 'writer-a', keyId: context.keyId,
    keyEvidenceRef: 'C01-KEY-CONTEXT', expectedGeneration: 0, expectedDigest: null };
  const service = new ConfluenceCopyPublicationStore(prisma as never);
  const prepare = () => service.prepare('org-a','owner-a',input);
  const resume = () => service.resume('org-a','owner-a','plan-a',deps);
  return { state, input, service, deps, objects, entries, prepare, resume };
}

test('commits exact plan before reservation/storage, then persists authenticated historical receipt', async () => {
  const f = fixture(); await f.prepare(); const result = await f.resume();
  assert.equal(result.actionAuthorized,false); assert.equal(result.currentHistoryVerified,false); assert.equal(result.reopeningAuthorised,false);
  assert.equal(f.state.receipt?.entryGeneration,1); assert.equal(f.state.objectWrites,1);
  assert.notEqual(f.state.control.activeOperation,null);
  assert.equal((await f.resume()).replayed,true); assert.equal(f.state.objectWrites,1);
});

for (const fault of ['object','entry','head','receipt','receipt-ack'] as const) test(`restart after unknown ${fault} outcome resumes original durable context and bytes`, async () => {
  const f = fixture(); await f.prepare();
  if (fault === 'object') f.state.loseObjectAck = true;
  if (fault === 'entry') f.state.loseEntryAck = true;
  if (fault === 'head') f.state.loseHeadAck = true;
  if (fault === 'receipt') f.state.receiptFailure = true;
  if (fault === 'receipt-ack') f.state.loseReceiptCommitAck = true;
  await assert.rejects(f.resume); const bytes = [...f.objects.values()];
  f.state.receiptFailure = false;
  assert.equal((await f.resume()).replayed,true); assert.equal(f.state.objectWrites,1); assert.deepEqual([...f.objects.values()],bytes);
  assert.equal(f.state.receipt?.entryGeneration,1); assert.equal(f.state.control.generation,1);
  assert.equal(f.entries.size,1);
});

test('plan retries refuse changed key/writer/head or approval evidence and caller-supplied facts', async () => {
  const f = fixture(); await f.prepare(); assert.equal((await f.prepare()).replayed,true);
  for (const change of [{ keyId: context.keyId.replace('11111111','22222222') }, { writerId: 'other' },
    { expectedGeneration: 1, expectedDigest: 'a'.repeat(64) }, { keyEvidenceRef: 'OTHER-KEY-EVIDENCE' }]) {
    await assert.rejects(f.service.prepare('org-a','owner-a',{ ...f.input, ...change }), /identity changed/);
  }
  await assert.rejects(f.service.prepare('org-a','owner-a',{ ...f.input, facts: 'untrusted' }));
  assert.equal(f.objects.size,0); assert.equal(f.entries.size,0);
});

test('missing/foreign capture, inactive Owner/charity, wrong writer and corrupt capture perform no external writes', async () => {
  for (const fault of ['foreign','owner','charity','writer','capture'] as const) {
    const f = fixture();
    if (fault === 'foreign') { await assert.rejects(f.service.prepare('org-b','owner-a',f.input)); continue; }
    await f.prepare();
    if (fault === 'owner') f.state.owner = false;
    if (fault === 'charity') f.state.active = false;
    if (fault === 'writer') f.state.control.writerId = 'other';
    if (fault === 'capture') f.state.capture.factsDigest = '0'.repeat(64);
    await assert.rejects(f.resume); assert.equal(f.objects.size,0); assert.equal(f.entries.size,0);
  }
});

test('a published receipt cannot recreate missing payload or regress its independent head', async () => {
  const f = fixture(); await f.prepare(); await f.resume(); f.objects.clear();
  await assert.rejects(f.resume, /missing or invalid/); assert.equal(f.state.objectWrites,1);
  f.state.control.generation = 0; f.state.control.digest = null;
  await assert.rejects(f.resume, /behind its committed receipt/); assert.equal(f.state.objectWrites,1);
});

test('reconciling an already-published original never reacquires a different current slot', async () => {
  const f = fixture(); await f.prepare(); f.state.receiptFailure = true;
  await assert.rejects(f.resume); f.state.receiptFailure = false;
  f.state.control.activeOperation = { operationId: 'separately-reserved-operation', preparationDigest: 'b'.repeat(64) };
  f.state.control.revision = 'later-reservation';
  const controlBefore = structuredClone(f.state.control);
  const result = await f.resume();
  assert.equal(result.replayed,true); assert.deepEqual(f.state.control,controlBefore);
  assert.equal(f.state.objectWrites,1); assert.equal(f.entries.size,1);
});

test('a corrupt restored local receipt cannot overwrite independently verified publication evidence', async () => {
  const f = fixture(); await f.prepare(); await f.resume();
  f.state.receipt!.envelopeDigest = '0'.repeat(64);
  const controlBefore = structuredClone(f.state.control), entriesBefore = [...f.entries.values()];
  await assert.rejects(f.resume, /receipt changed/);
  assert.equal(f.state.objectWrites,1); assert.deepEqual(f.state.control,controlBefore);
  assert.deepEqual([...f.entries.values()],entriesBefore);
});
