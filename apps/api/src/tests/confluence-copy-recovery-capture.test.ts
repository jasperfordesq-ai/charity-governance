import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceCopyRecoveryCaptureStore } from '../services/confluence-copy-recovery-capture.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { preserveConfluenceCopyRecoveryFacts, readVerifiedConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import type { ConfluenceCopyRecoveryCapture } from '@prisma/client';

type OperationLookup = { where: { organisationId_operationId: { organisationId: string; operationId: string } } };
type ReviewLookup = { where: { organisationId: string; reviewId: string } };

function fixture() {
  const facts = recoveryFactsFixture();
  const state = { owner: true, active: true, reviewPresent: true, clock: new Date(facts.capturedAt), facts,
    captures: [] as ConfluenceCopyRecoveryCapture[], reads: 0, locks: [] as string[] };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => { state.locks.push(query.join('?')); return [{ now: state.clock }]; },
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    confluenceRetainedCopyReview: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) => {
      state.reads++; return state.reviewPresent && where.organisationId === 'org-a' && where.id === 'review-a' ? structuredClone(state.facts.review) : null;
    } },
    confluenceRetainedCopyReviewWithdrawal: { findFirst: async () => structuredClone(state.facts.reviewWithdrawal) },
    confluenceSyntheticCopyScope: { findFirst: async () => structuredClone(state.facts.scope) },
    confluenceRetainedCopyPermission: { findFirst: async () => structuredClone(state.facts.permission) },
    confluenceRetainedCopyPermissionWithdrawal: { findFirst: async () => structuredClone(state.facts.permissionWithdrawal) },
    confluenceCopyRecoveryCapture: {
      findUnique: async ({ where }: OperationLookup) => state.captures.find(r => r.organisationId === where.organisationId_operationId.organisationId
        && r.operationId === where.organisationId_operationId.operationId) ?? null,
      findFirst: async ({ where }: ReviewLookup) => state.captures.filter(r => r.organisationId === where.organisationId && r.reviewId === where.reviewId).at(-1) ?? null,
      create: async ({ data }: { data: Omit<ConfluenceCopyRecoveryCapture,'id' | 'recordedAt'> }) => {
        const row = { id: `capture-${state.captures.length + 1}`, recordedAt: state.clock, ...data }; state.captures.push(row); return row;
      },
    },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, 'ReadCommitted'); return fn(tx);
  } };
  const input = { installationId: facts.installationId, operationId: facts.operationId,
    writerEpoch: facts.writerEpoch, sourceRevision: facts.sourceRevision, reviewId: facts.review.id };
  return { state, input, service: new ConfluenceCopyRecoveryCaptureStore(prisma as never) };
}

test('captures the complete scoped decision bundle under the charity lock without execution authority', async () => {
  const h = fixture();
  const result = await h.service.capture('org-a','owner-a',h.input);
  assert.deepEqual(JSON.parse(result.body), h.state.facts);
  assert.equal(result.replayed, false); assert.equal(result.actionAuthorized, false);
  assert.equal(result.currentHistoryVerified, false); assert.equal(result.reopeningAuthorised, false);
  assert.match(h.state.locks[0]!, /Organisation/);
  assert.match(h.state.locks[0]!, /FOR UPDATE/);
  assert.equal(h.state.captures.length, 1);
});

test('retry returns the original body/time after withdrawal and after the review expires', async () => {
  const h = fixture(); const first = await h.service.capture('org-a','owner-a',h.input);
  h.state.clock = new Date('2026-10-16T18:06:00.000Z');
  h.state.facts.permissionWithdrawal = { id: 'pw-a', organisationId: 'org-a', permissionId: 'permission-a',
    actorUserId: 'owner-a', evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic permission', occurredAt: h.state.clock.toISOString() };
  const retry = await h.service.capture('org-a','owner-a',h.input);
  assert.equal(retry.body, first.body); assert.equal(retry.digest, first.digest);
  assert.equal(retry.replayed, true); assert.equal(h.state.reads, 1); assert.equal(h.state.captures.length, 1);
  const next = await h.service.capture('org-a','owner-a',{ ...h.input, operationId: 'state-2' });
  const facts = JSON.parse(next.body);
  assert.deepEqual(facts.permissionWithdrawal,h.state.facts.permissionWithdrawal);
  assert.equal(facts.factsRevision,2); assert.equal(facts.previousFactsDigest,first.digest);
});

test('same operation refuses changed review, installation, writer epoch or source identity', async () => {
  const h = fixture(); await h.service.capture('org-a','owner-a',h.input);
  for (const change of [{ reviewId: 'other' }, { installationId: 'other' }, { writerEpoch: 2 }, { sourceRevision: 'b'.repeat(40) }]) {
    await assert.rejects(h.service.capture('org-a','owner-a',{ ...h.input, ...change }), /identity changed/);
  }
  assert.equal(h.state.captures.length,1);
});

test('new state refuses dropped or retroactively introduced decisions and changed writer epoch', async () => {
  const h = fixture(); await h.service.capture('org-a','owner-a',h.input);
  const saved = structuredClone(h.state.facts);
  for (const alter of [() => { h.state.facts.permission = null as never; },
    () => { h.state.facts.permissionWithdrawal = { id: 'pw-a', organisationId: 'org-a', permissionId: 'permission-a',
      actorUserId: 'owner-a', evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw exact synthetic permission', occurredAt: '2026-10-15T18:04:00.000Z' }; }]) {
    h.state.facts = structuredClone(saved); alter();
    await assert.rejects(h.service.capture('org-a','owner-a',{ ...h.input, operationId: 'state-2' }));
  }
  h.state.facts = saved;
  await assert.rejects(h.service.capture('org-a','owner-a',{ ...h.input, operationId: 'state-2', writerEpoch: 2 }), /progression/);
  assert.equal(h.state.captures.length,1);
});

test('Owner revocation, missing or other-charity review, and caller-supplied facts fail closed', async () => {
  const h = fixture(); h.state.owner = false;
  await assert.rejects(h.service.capture('org-a','member-a',h.input), /active charity Owner/);
  h.state.owner = true;
  await assert.rejects(h.service.capture('org-b','owner-b',h.input), /not found in charity/);
  h.state.reviewPresent = false;
  await assert.rejects(h.service.capture('org-a','owner-a',h.input), /not found in charity/);
  await assert.rejects(h.service.capture('org-a','owner-a',{ ...h.input, facts: {} }));
  assert.equal(h.state.captures.length,0);
});

test('a corrupt saved body, digest, or scalar cannot be returned as a retry', async () => {
  for (const key of ['facts','factsDigest','reviewId','factsRevision','capturedAt']) {
    const h = fixture(); await h.service.capture('org-a','owner-a',h.input);
    Object.assign(h.state.captures[0]!,{ [key]: key === 'factsRevision' ? 2 : key === 'capturedAt' ? new Date(0) : 'corrupt' });
    await assert.rejects(h.service.capture('org-a','owner-a',h.input), /Invalid stored/);
  }
});

test('charity suspension also refuses returning an existing sensitive capture', async () => {
  const h = fixture(); await h.service.capture('org-a','owner-a',h.input); h.state.active = false;
  await assert.rejects(h.service.capture('org-a','owner-a',h.input), /active charity Owner/);
});

test('lost external acknowledgement resumes the durable original capture after a later withdrawal', async () => {
  const h = fixture(); const captured = await h.service.capture('org-a','owner-a',h.input);
  const keys: RecoveryDataKeys = {
    generate: async () => ({ key: Buffer.alloc(32,7), wrappedKey: Buffer.from('synthetic-key').toString('base64'), keyId: context.keyId }),
    unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }),
  };
  const envelopes = new Map<string,string>(); let writes = 0;
  const objects = {
    readConfluenceCopyState: async (operationId: string) => envelopes.get(operationId) ?? null,
    createConfluenceCopyState: async (operationId: string, envelope: string) => {
      assert.ok(h.state.captures.some(row => row.operationId === operationId), 'capture must commit before external write');
      if (envelopes.has(operationId)) return false;
      envelopes.set(operationId,envelope); writes++;
      if (writes === 1) throw new Error('Synthetic lost acknowledgement');
      return true;
    },
  };
  await assert.rejects(preserveConfluenceCopyRecoveryFacts(captured.body,context,keys,objects), /preservation unresolved/);
  h.state.clock = new Date('2026-10-15T18:06:00.000Z');
  h.state.facts.permissionWithdrawal = { id: 'pw-a', organisationId: 'org-a', permissionId: 'permission-a',
    actorUserId: 'owner-a', evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic permission', occurredAt: h.state.clock.toISOString() };
  const retry = await h.service.capture('org-a','owner-a',h.input);
  const preserved = await preserveConfluenceCopyRecoveryFacts(retry.body,context,keys,objects);
  assert.equal(preserved.replayed,true); assert.equal(writes,1); assert.equal(retry.body,captured.body);
  const next = await h.service.capture('org-a','owner-a',{ ...h.input, operationId: 'state-2' });
  const nextContext = { ...context, operationId: 'state-2' };
  const nextPreserved = await preserveConfluenceCopyRecoveryFacts(next.body,nextContext,keys,objects);
  const read = await readVerifiedConfluenceCopyRecoveryFacts(nextPreserved.digest,nextContext,keys,objects);
  assert.deepEqual(JSON.parse(read.body).permissionWithdrawal,h.state.facts.permissionWithdrawal);
  assert.equal(read.currentHistoryVerified,false); assert.equal(read.reopeningAuthorised,false);
});
