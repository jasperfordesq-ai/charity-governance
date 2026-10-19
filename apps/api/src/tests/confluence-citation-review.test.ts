import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { confluenceCitationTargetDigest } from '../services/confluence-citation-observation.js';
import { readConfluenceCitationReview, recordConfluenceCitationReview } from '../services/confluence-citation-review.js';

function fixture() {
  let citation: Record<string, unknown> | null = { id: 'ref-1', documentId: 'doc-1', cloudId: 'site-1', pageId: 'page-1',
    pageVersion: 3, citedAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01') };
  let active = true, loseCommit = false, reads = 0, beforeTransaction: (() => void) | undefined;
  type Audit = { id: string; actorUserId: string; occurredAt: Date; context: Record<string, unknown> };
  const rows: Audit[] = [];
  const client = {
    user: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'owner-1', organisationId: 'org-1', role: 'OWNER', lifecycleStatus: 'ACTIVE', organisation: { is: { lifecycleStatus: 'ACTIVE' } } });
      return active ? { id: 'owner-1', name: 'Synthetic Owner' } : null;
    } },
    confluenceReference: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'ref-1', organisationId: 'org-1', OR: [
        { referenceKind: 'CONFLUENCE_SOURCE', documentId: null },
        { document: { organisationId: 'org-1', deletedAt: null } },
      ] }); return citation;
    } },
    securityAuditEvent: {
      findFirst: async ({ where }: { where: { id?: string; organisationId: string; type: string; context?: { equals: string } } }) => {
        assert.equal(where.organisationId, 'org-1'); assert.equal(where.type, 'CONFLUENCE_CITATION_REVIEW_RECORDED');
        return rows.find(row => where.id ? row.id === where.id : row.context.clientRequestId === where.context?.equals) ?? null;
      },
      create: async ({ data }: { data: { actorUserId: string; context: Record<string, unknown> } }) => {
        const row = { id: `event-${rows.length + 1}`, actorUserId: data.actorUserId, occurredAt: new Date(), context: structuredClone(data.context) };
        rows.push(row); return row;
      },
    }, $queryRaw: async () => [],
  };
  let queue = Promise.resolve();
  const prisma = { ...client, $transaction: async (callback: (tx: typeof client) => Promise<unknown>) => {
    const before = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await before;
    try { beforeTransaction?.(); const result = await callback(client); if (loseCommit) { loseCommit = false; throw new Error('Unknown commit'); } return result; }
    finally { release(); }
  } } as unknown as PrismaClient;
  const connection = { cloudId: 'site-1', generation: 'original', client: {} as ConfluenceClient };
  const deps = { getConnection: async () => connection as typeof connection | null,
    getPage: async (_client: ConfluenceClient, id: string): Promise<ConfluencePage | null> => {
      reads++; return id === 'control-1' ? { id, status: 'current' } as ConfluencePage : null;
    }, isPageInTrash: async () => false };
  const body = { clientRequestId: '00000000-0000-4000-8000-000000000123', expectedTargetDigest: confluenceCitationTargetDigest(citation),
    controlPageId: 'control-1', actionReport: 'PURGE_REPORTED', actionEvidenceRef: 'SYNTHETIC-ACTION-1',
    actionReportedAt: '2026-10-01T10:00:00Z', evidenceRef: 'SYNTHETIC-REVIEW-1', reason: 'Synthetic operator claim, not a disposal instruction or provider acknowledgement', evidenceReviewed: true };
  const record = (change: Record<string, unknown> = {}) => recordConfluenceCitationReview(prisma,
    { organisationId: 'org-1', actorUserId: 'owner-1', referenceId: 'ref-1', body: { ...body, ...change } }, deps);
  return { prisma, deps, body, rows, record, reads: () => reads, getCitation: () => citation,
    setCitation: (value: typeof citation) => { citation = value; }, revoke: () => { active = false; },
    loseCommit: () => { loseCommit = true; }, beforeTransaction: (hook: () => void) => { beforeTransaction = hook; } };
}
test('citation report preserves historical identity and action claim with explicitly no deletion instruction or job', async () => {
  const f = fixture(), original = structuredClone(f.getCitation()); const review = await f.record();
  assert.equal(review.instruction, null); assert.equal(review.citation.pageVersion, 3);
  assert.equal(review.input.actionReport, 'PURGE_REPORTED'); assert.equal(review.observation.status, 'NOT_OBSERVED');
  assert.equal(review.observation.jobCreated, false); assert.equal(review.observation.attachmentsObserved, false);
  assert.equal(review.actionAuthorized, false); assert.equal(review.currentStateVerified, false);
  assert.equal(review.operatorReportOnly, true); assert.deepEqual(f.getCitation(), original);
});

test('reference-only source review retains its null file anchor and survives local unciting', async () => {
  const f = fixture();
  const source = { ...f.getCitation()!, documentId: null };
  f.setCitation(source);
  const review = await f.record({ expectedTargetDigest: confluenceCitationTargetDigest(source) });
  assert.equal(review.citation.documentId, null);
  assert.equal(review.instruction, null);
  f.setCitation(null);
  const saved = await readConfluenceCitationReview(f.prisma, 'org-1', 'owner-1', review.clientRequestId);
  assert.equal(saved.citation.documentId, null);
  assert.equal(saved.historicalReceipt, true);
});
test('lost acknowledgement and concurrent identical saves return one original receipt without another read', async () => {
  const f = fixture(); f.loseCommit(); await assert.rejects(f.record(), /Unknown commit/);
  const reads = f.reads(), saved = await f.record();
  assert.deepEqual(await readConfluenceCitationReview(f.prisma, 'org-1', 'owner-1', saved.id), saved);
  assert.deepEqual(await readConfluenceCitationReview(f.prisma, 'org-1', 'owner-1', f.body.clientRequestId), saved);
  assert.equal(f.rows.length, 1); assert.equal(f.reads(), reads);
  const concurrent = fixture(), results = await Promise.all([concurrent.record(), concurrent.record()]);
  assert.deepEqual(results[0], results[1]); assert.equal(concurrent.rows.length, 1);
});
test('original receipt survives later unciting and changed input cannot reuse its identity', async () => {
  const f = fixture(), saved = await f.record(); f.setCitation(null); const reads = f.reads();
  assert.deepEqual(await f.record(), saved);
  assert.deepEqual(await readConfluenceCitationReview(f.prisma, 'org-1', 'owner-1', saved.id), saved);
  await assert.rejects(f.record({ reason: 'Changed report reusing the original request identity' }), { code: 'CONFLUENCE_CITATION_REVIEW_CONFLICT' });
  assert.equal(f.reads(), reads);
});
test('Owner revocation and citation removal or modification before commit prevent saving', async () => {
  for (const mode of ['owner', 'removed', 'changed']) {
    const f = fixture(); f.beforeTransaction(() => mode === 'owner' ? f.revoke() : f.setCitation(mode === 'removed' ? null : { ...f.getCitation(), pageVersion: 4 }));
    await assert.rejects(f.record()); assert.equal(f.rows.length, 0);
  }
});
test('forged instruction/authority, missing action evidence and future action time refuse before provider access', async () => {
  for (const change of [{ instruction: { approved: true } }, { actionAuthorized: true }, { actionEvidenceRef: null },
    { actionReportedAt: '2999-01-01T00:00:00Z' }, { evidenceReviewed: false }]) {
    const f = fixture(); await assert.rejects(f.record(change)); assert.equal(f.reads(), 0); assert.equal(f.rows.length, 0);
  }
});
test('unavailable provider saves explicit unknown and receipt JSON ordering cannot change its binding', async () => {
  const f = fixture(); f.deps.getConnection = async () => null; const saved = await f.record();
  assert.equal(saved.observation.status, 'UNKNOWN'); assert.equal(saved.observation.permanentErasureVerified, false);
  for (const field of ['input', 'citation']) f.rows[0].context[field] = Object.fromEntries(Object.entries(f.rows[0].context[field] as object).reverse());
  assert.equal((await f.record()).id, saved.id);
});
