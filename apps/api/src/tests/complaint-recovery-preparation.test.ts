import { complaintPreparationFixture as fixture } from './complaint-preparation-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { ComplaintRecoveryPreparationStore } from '../services/complaint-recovery-preparation-store.js';
import type { PrismaClient } from '@prisma/client';

test('preparation preserves explicit decision facts with stable bytes and never authorizes action', () => {
  const input = fixture();
  const first = prepareComplaintRecoveryFacts(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(prepareComplaintRecoveryFacts(reordered), first);
  assert.equal(first.actionAuthorized, false);
  assert.equal(JSON.parse(first.body).authorization.reason, input.authorization.reason);
  input.authorization.reason = 'A different reviewed decision';
  assert.notEqual(prepareComplaintRecoveryFacts(input).digest, first.digest);
});

test('preparation refuses subject fields at every object boundary without leaking their values', () => {
  for (const key of ['', 'complaint', 'authorization', 'policy', 'removalPolicy', 'removal']) {
    const input = fixture();
    const target = key ? (input as unknown as Record<string, object>)[key]! : input;
    Object.assign(target, { narrative: 'sensitive-example' });
    assert.throws(() => prepareComplaintRecoveryFacts(input), { message: 'Invalid complaint recovery preparation' });
  }
});

test('preparation refuses foreign, missing, held and inconsistent dependencies', () => {
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.policy.organisationId = 'foreign'; },
    (v: ReturnType<typeof fixture>) => { v.authorization.policyId = 'absent'; },
    (v: ReturnType<typeof fixture>) => { v.authorization.recordRevision++; },
    (v: ReturnType<typeof fixture>) => { v.authorization.actorUserId = 'former-owner'; },
    (v: ReturnType<typeof fixture>) => { v.authorization.holdRevision = 1; },
    (v: ReturnType<typeof fixture>) => { v.policy.retentionDays = 10; },
    (v: ReturnType<typeof fixture>) => { v.removal.resolutionEvidenceId = 'missing'; },
    (v: ReturnType<typeof fixture>) => { v.complaint.reviewedByBoard = true; },
    (v: ReturnType<typeof fixture>) => { v.writerEpoch = 0; },
    (v: ReturnType<typeof fixture>) => { v.removal.recoveryUntil = '2026-10-01T00:00:00.000Z'; },
  ];
  for (const change of mutations) {
    const input = fixture(); change(input);
    assert.throws(() => prepareComplaintRecoveryFacts(input));
  }
});

test('timed retention preparation requires the actual linked resolution evidence', () => {
  const input = fixture();
  input.policy.retentionMode = 'AFTER_ANCHOR'; input.policy.retentionAnchor = 'RESOLVED_AT'; input.policy.retentionDays = 10;
  input.policy.id = 'timed-policy'; input.authorization.policyId = 'timed-policy';
  assert.throws(() => prepareComplaintRecoveryFacts(input));
  input.removal.resolutionEvidenceId = 'resolution';
  input.resolution = { id: 'resolution', organisationId: 'charity', complaintId: 'complaint', revision: 1,
    recordRevision: 1, actorUserId: 'owner', evidenceRef: 'RESOLUTION-1', reason: 'Synthetic resolution reason',
    state: 'RECORDED', resolvedAt: '2026-08-01T00:00:00.000Z', occurredAt: '2026-08-01T00:00:00.000Z' };
  input.removalResolution = { ...input.resolution };
  assert.equal(prepareComplaintRecoveryFacts(input).actionAuthorized, false);
  input.resolution.recordRevision = 2;
  assert.throws(() => prepareComplaintRecoveryFacts(input));
});

test('one dependency identity cannot carry conflicting facts', () => {
  const input = fixture();
  input.removalPolicy.recoveryDays = 2;
  assert.throws(() => prepareComplaintRecoveryFacts(input));
});

test('review-only disposal preserves withdrawn resolution evidence without treating it as a timed anchor', () => {
  const input = fixture();
  input.resolution = { id: 'withdrawn', organisationId: 'charity', complaintId: 'complaint', revision: 2,
    recordRevision: 1, actorUserId: 'owner', evidenceRef: 'WITHDRAW-1', reason: 'Synthetic resolution withdrawal',
    state: 'WITHDRAWN', resolvedAt: null, occurredAt: '2026-08-01T00:00:00.000Z' };
  assert.equal(JSON.parse(prepareComplaintRecoveryFacts(input).body).resolution.state, 'WITHDRAWN');
  input.policy.id = 'timed-policy'; input.authorization.policyId = 'timed-policy';
  input.policy.retentionMode = 'AFTER_ANCHOR'; input.policy.retentionAnchor = 'RESOLVED_AT'; input.policy.retentionDays = 10;
  assert.throws(() => prepareComplaintRecoveryFacts(input));
});

test('a later disposal policy preserves the distinct original removal policy', () => {
  const input = fixture();
  input.policy.id = 'later-policy'; input.policy.revision = 2;
  input.authorization.policyId = 'later-policy';
  const facts = JSON.parse(prepareComplaintRecoveryFacts(input).body);
  assert.equal(facts.removalPolicy.id, 'policy');
  assert.equal(facts.policy.id, 'later-policy');
  input.removalPolicy.id = 'missing-original';
  assert.throws(() => prepareComplaintRecoveryFacts(input));
});

test('capture selects decision fields and persists in one transaction; retries do not recapture', async () => {
  const source = fixture(); let saved: Record<string, unknown> | null = null;
  let transactions = 0, reads = 0, writes = 0; let activeOwner = true;
  const tx = {
    $queryRaw: async () => [{ now: new Date(source.preparedAt) }],
    user: { findFirst: async () => activeOwner ? { id: 'owner' } : null },
    complaintPurgeAuthorization: { findFirst: async () => { reads++; return { ...source.authorization, claim: null, withdrawal: null }; } },
    complaintRecord: { findFirst: async (args: { select: Record<string, boolean> }) => {
      assert.deepEqual(Object.keys(args.select).sort(), Object.keys(source.complaint).sort());
      assert.equal(args.select.summary, undefined); return source.complaint;
    } },
    complaintRemoval: { findFirst: async () => source.removal },
    dataRetentionPolicyRevision: { findMany: async () => [source.policy], findFirst: async () => source.removalPolicy },
    complaintResolutionEvidence: { findFirst: async () => null },
    complaintHoldEvent: { findFirst: async () => null },
    complaintRecoveryPreparation: { findUnique: async () => saved,
      create: async ({ data }: { data: Record<string, unknown> }) => { writes++; saved = { ...data, id: 'captured' }; return saved; } },
  };
  const client = { $transaction: async (work: (value: typeof tx) => unknown, options: { isolationLevel: string }) => { assert.equal(options.isolationLevel, 'ReadCommitted'); transactions++; return work(tx); } } as unknown as PrismaClient;
  const store = new ComplaintRecoveryPreparationStore(client);
  const request = { installationId: source.installationId, operationId: source.operationId,
    writerEpoch: source.writerEpoch, sourceRevision: source.sourceRevision, authorizationId: source.authorization.id };
  const first = await store.capture('charity', 'owner', request);
  assert.equal(first.actionAuthorized, false); assert.equal(transactions, 1); assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(String(saved!.facts)), source);
  source.preparedAt = '2026-10-01T00:00:00.000Z'; source.authorization.reason = 'A later changed reason';
  const retry = await new ComplaintRecoveryPreparationStore(client).capture('charity', 'owner', request);
  assert.equal(retry.replayed, true); assert.equal(retry.digest, first.digest);
  assert.equal(reads, 1); assert.equal(writes, 1);
  await assert.rejects(() => store.capture('charity', 'owner', { ...request, writerEpoch: 2 }), /identity changed/);
  activeOwner = false;
  await assert.rejects(() => store.capture('charity', 'owner', request), /active charity Owner/);
  assert.equal(writes, 1);
});

test('capture refuses changed or ambiguous current policy before writing', async () => {
  const source = fixture(); let writes = 0;
  const tx = { $queryRaw: async () => [], user: { findFirst: async () => ({ id: 'owner' }) },
    complaintRecoveryPreparation: { findUnique: async () => null, create: async () => { writes++; } },
    complaintPurgeAuthorization: { findFirst: async () => ({ ...source.authorization, claim: null, withdrawal: null }) },
    complaintRecord: { findFirst: async () => source.complaint }, complaintRemoval: { findFirst: async () => source.removal },
    dataRetentionPolicyRevision: { findMany: async () => [{ ...source.policy, id: 'changed-policy' }] },
  };
  const client = { $transaction: async (work: (value: typeof tx) => unknown) => work(tx) } as unknown as PrismaClient;
  const store = new ComplaintRecoveryPreparationStore(client);
  const request = { installationId: source.installationId, operationId: source.operationId,
    writerEpoch: source.writerEpoch, sourceRevision: source.sourceRevision, authorizationId: source.authorization.id };
  await assert.rejects(() => store.capture('charity', 'owner', request), /policy changed/);
  tx.dataRetentionPolicyRevision.findMany = async () => [source.policy, { ...source.policy, id: 'other' }];
  await assert.rejects(() => store.capture('charity', 'owner', request), /policy changed/);
  assert.equal(writes, 0);
});
