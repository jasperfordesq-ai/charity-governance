import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { confluenceErasureTargetDigest, type ConfluenceErasureObservationDeps } from '../services/confluence-erasure-observation.js';
import { readConfluenceErasureReview, recordConfluenceErasureReview } from '../services/confluence-erasure-review.js';

function fixture() {
  const target = { kind: 'confluence', cloudId: 'site-1', pageId: 'page-1', attachmentIds: [] };
  const job = { id: 'job-1', targetRef: target, createdAt: new Date('2026-10-01'), requestedById: 'original-requester', reason: 'Original instruction, retained separately' };
  let active = true, loseCommit = false, reads = 0, beforeTransaction: (() => void) | undefined;
  type Audit = { id: string; actorUserId: string; occurredAt: Date; context: Record<string, unknown> };
  const rows: Audit[] = [];
  const client = {
    user: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'owner-1', organisationId: 'org-1', role: 'OWNER', lifecycleStatus: 'ACTIVE', organisation: { is: { lifecycleStatus: 'ACTIVE' } } });
      return active ? { id: 'owner-1', name: 'Synthetic Owner' } : null;
    } },
    documentStorageDeletion: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'job-1', organisationId: 'org-1', provider: 'confluence' }); return job;
    } },
    securityAuditEvent: {
      findFirst: async ({ where }: { where: { id?: string; organisationId: string; type: string; context?: { equals: string } } }) => {
        assert.equal(where.organisationId, 'org-1'); assert.equal(where.type, 'CONFLUENCE_ERASURE_REVIEW_RECORDED');
        return rows.find(row => where.id ? row.id === where.id : row.context.clientRequestId === where.context?.equals) ?? null;
      },
      create: async ({ data }: { data: { actorUserId: string; context: Record<string, unknown> } }) => {
        const row = { id: `event-${rows.length + 1}`, actorUserId: data.actorUserId, occurredAt: new Date(), context: structuredClone(data.context) };
        rows.push(row); return row;
      },
    },
    $queryRaw: async () => [],
  };
  let queue = Promise.resolve();
  const prisma = { ...client, $transaction: async (callback: (tx: typeof client) => Promise<unknown>) => {
    const before = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { beforeTransaction?.(); const result = await callback(client); if (loseCommit) { loseCommit = false; throw new Error('Unknown commit'); } return result; }
    finally { release(); }
  } } as unknown as PrismaClient;
  const connection = { cloudId: 'site-1', generation: 'original', client: {} as ConfluenceClient };
  const deps: ConfluenceErasureObservationDeps = { getConnection: async () => connection,
    getPage: async (_client, id) => { reads++; return id === 'control-1' ? { id, status: 'current' } as ConfluencePage : null; },
    isPageInTrash: async () => false };
  const body = { clientRequestId: '00000000-0000-4000-8000-000000000123', expectedTargetDigest: confluenceErasureTargetDigest(target),
    controlPageId: 'control-1', actionReport: 'PURGE_REPORTED', actionEvidenceRef: 'SYNTHETIC-ACTION-1',
    actionReportedAt: '2026-10-01T10:00:00Z', evidenceRef: 'SYNTHETIC-REVIEW-1', reason: 'Synthetic operator report, not a provider acknowledgement', evidenceReviewed: true };
  const record = (change: Record<string, unknown> = {}) => recordConfluenceErasureReview(prisma,
    { organisationId: 'org-1', actorUserId: 'owner-1', deletionId: 'job-1', body: { ...body, ...change } }, deps);
  return { prisma, deps, body, rows, job, record, reads: () => reads, revoke: () => { active = false; },
    loseCommit: () => { loseCommit = true; }, beforeTransaction: (hook: () => void) => { beforeTransaction = hook; } };
}
test('review preserves original instruction, separate operator claim and uncertain observation', async () => {
  const f = fixture(), before = structuredClone(f.job); const review = await f.record();
  assert.equal(review.input.actionReport, 'PURGE_REPORTED'); assert.equal(review.operatorReportOnly, true);
  assert.equal(review.instruction.requestedById, 'original-requester');
  assert.equal(review.observation.status, 'NOT_OBSERVED'); assert.equal(review.observation.permanentErasureVerified, false);
  assert.equal(review.actionAuthorized, false); assert.equal(review.currentStateVerified, false); assert.deepEqual(f.job, before);
});
test('lost commit acknowledgement returns original receipt without new provider reads', async () => {
  const f = fixture(); f.loseCommit(); await assert.rejects(f.record(), /Unknown commit/);
  const reads = f.reads(); const original = await f.record();
  const fresh = await readConfluenceErasureReview(f.prisma, 'org-1', 'owner-1', f.body.clientRequestId);
  assert.deepEqual(fresh, original); assert.equal(f.rows.length, 1); assert.equal(f.reads(), reads);
  assert.deepEqual(await readConfluenceErasureReview(f.prisma, 'org-1', 'owner-1', original.id), original);
});
test('concurrent identical saves converge to one original event', async () => {
  const f = fixture(); const results = await Promise.all([f.record(), f.record()]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.rows.length, 1);
});
test('changed request with the same identity is refused without another provider read', async () => {
  const f = fixture(); await f.record(); const reads = f.reads();
  await assert.rejects(f.record({ reason: 'Changed operator report with reused request identity' }), { code: 'CONFLUENCE_REVIEW_CONFLICT' });
  assert.equal(f.reads(), reads); assert.equal(f.rows.length, 1);
});
test('revoked Owner before commit cannot record an observation', async () => {
  const f = fixture(); f.beforeTransaction(f.revoke); await assert.rejects(f.record(), { code: 'CONFLUENCE_REVIEW_OWNER_REQUIRED' }); assert.equal(f.rows.length, 0);
});
test('changed recorded target before commit refuses without a report', async () => {
  const f = fixture(); f.beforeTransaction(() => { f.job.targetRef.pageId = 'changed'; });
  await assert.rejects(f.record(), { code: 'CONFLUENCE_REVIEW_CONFLICT' }); assert.equal(f.rows.length, 0);
});
test('future action time and forged authority fields refuse before observation', async () => {
  for (const change of [{ actionReportedAt: '2999-01-01T00:00:00Z' }, { actionAuthorized: true }, { actionEvidenceRef: null }, { actionReport: 'NOT_REPORTED' }]) {
    const f = fixture(); await assert.rejects(f.record(change)); assert.equal(f.reads(), 0); assert.equal(f.rows.length, 0);
  }
});
test('unavailable provider remains a durable unknown report, not an erased state', async () => {
  const f = fixture(); f.deps.getConnection = async () => null;
  const review = await f.record(); assert.equal(review.observation.status, 'UNKNOWN'); assert.equal(review.observation.permanentErasureVerified, false);
});
test('historical JSON field order does not change the original input binding', async () => {
  const f = fixture(); await f.record(); const context = f.rows[0].context;
  context.input = Object.fromEntries(Object.entries(context.input as Record<string, unknown>).reverse());
  assert.equal((await f.record()).id, 'event-1'); assert.equal(f.rows.length, 1);
});
