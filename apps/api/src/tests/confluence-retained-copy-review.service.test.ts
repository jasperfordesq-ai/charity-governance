import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceRetainedCopyReviewService } from '../services/confluence-retained-copy-review.service.js';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const input = () => ({
  scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE',
  reviewerId: 'owner-a', evidenceRef: 'C01-REVIEW', retentionDecisionRef: 'C01-RETAIN',
  holdReviewRef: 'C01-HOLD', inventoryEvidenceRef: 'C01-INVENTORY', syntheticEvidenceRef: 'C01-FIXTURE',
  reviewedAt: NOW.toISOString(), expiresAt: '2026-10-15T19:00:00.000Z',
  snapshot: {
    organisationId: 'org-a', documentId: 'doc-a', sourceRevision: '2026-10-15T17:00:00.000Z',
    sourceSha256: 'a'.repeat(64), lifecycleStatus: 'RETIRED', deletionHold: false,
    externalPublicationApproved: false, publicationId: 'pub-a', publicationRevision: '2026-10-15T17:01:00.000Z',
    publicationState: 'RETIRED', cloudId: '00000000-0000-4000-8000-000000000001',
    siteOrigin: 'https://synthetic-example.atlassian.net', spaceId: '123', pageId: '456',
    inventory: { observedAt: '2026-10-15T17:59:00.000Z', status: 'CURRENT', complete: true,
      currentPageVersion: 1, pageVersions: [1], attachments: [] },
  },
});
function harness(options: { owner?: boolean; bound?: boolean; missing?: boolean; withdrawn?: boolean; failInsert?: boolean } = {}) {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async () => [{ now: NOW }],
    user: { findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      options.owner !== false && where.id === 'owner-a' && where.organisationId === 'org-a'
        && where.role === 'OWNER' && where.lifecycleStatus === 'ACTIVE' ? { id: 'owner-a' } : null },
    documentRecoveryEnforcement: { findUnique: async () => options.bound ? { id: 'binding' } : null },
    confluenceRetainedCopyReview: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failInsert) throw new Error('Synthetic SQL revision refusal');
        writes.push({ kind: 'review', data }); return { id: 'review-a', ...data };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        !options.missing && where.id === 'review-a' && where.organisationId === 'org-a'
          ? { id: 'review-a', withdrawal: options.withdrawn ? { id: 'withdrawn' } : null } : null,
    },
    confluenceRetainedCopyReviewWithdrawal: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ kind: 'withdrawal', data }); return { id: 'withdrawal-a', ...data };
      },
    },
  };
  const prisma = { $transaction: async <T>(run: (client: typeof tx) => Promise<T>) => run(tx) };
  return { writes, service: new ConfluenceRetainedCopyReviewService(prisma as never) };
}
const withdrawal = { evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the synthetic review evidence' };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test('records reviewed evidence with authenticated identity and no provider permission', async () => {
  const h = harness();
  await h.service.record('org-a', 'owner-a', input());
  assert.equal(h.writes.length, 1);
  const row = h.writes[0]!.data;
  assert.equal(row.authorisesProviderIO, false);
  assert.equal(row.reviewerId, 'owner-a');
  assert.equal(row.organisationId, 'org-a');
  assert.equal(row.documentId, 'doc-a');
  assert.match(row.snapshotSha256 as string, /^[a-f0-9]{64}$/);
});
test('caller cannot substitute another reviewer or charity', async () => {
  for (const field of ['reviewer', 'charity']) {
    const h = harness(); const value = input();
    if (field === 'reviewer') value.reviewerId = 'owner-b'; else value.snapshot.organisationId = 'org-b';
    await assert.rejects(h.service.record('org-a', 'owner-a', value), code('CONFLUENCE_COPY_REVIEW_SCOPE_REQUIRED'));
    assert.equal(h.writes.length, 0);
  }
});
test('non-Owner and recovery-bound writes are refused for record and withdrawal', async () => {
  for (const options of [{ owner: false }, { bound: true }]) {
    const h = harness(options);
    const expected = options.owner === false ? 'CONFLUENCE_COPY_REVIEW_OWNER_REQUIRED' : 'CONFLUENCE_COPY_REVIEW_RECOVERY_REQUIRED';
    await assert.rejects(h.service.record('org-a', 'owner-a', input()), code(expected));
    await assert.rejects(h.service.withdraw('org-a', 'owner-a', 'review-a', withdrawal), code(expected));
    assert.equal(h.writes.length, 0);
  }
});
test('SQL source-revision refusal propagates without creating evidence or a fallback job', async () => {
  const h = harness({ failInsert: true });
  await assert.rejects(h.service.record('org-a', 'owner-a', input()), /Synthetic SQL revision refusal/);
  assert.equal(h.writes.length, 0);
});
test('withdrawal appends its own evidence without updating the original review', async () => {
  const h = harness();
  await h.service.withdraw('org-a', 'owner-a', 'review-a', withdrawal);
  assert.deepEqual(h.writes, [{ kind: 'withdrawal', data: {
    organisationId: 'org-a', reviewId: 'review-a', actorUserId: 'owner-a', ...withdrawal,
  } }]);
});
test('missing, cross-charity and already withdrawn reviews cannot be withdrawn', async () => {
  const missing = harness({ missing: true });
  await assert.rejects(missing.service.withdraw('org-a','owner-a','review-a',withdrawal), code('CONFLUENCE_COPY_REVIEW_NOT_FOUND'));
  const withdrawn = harness({ withdrawn: true });
  await assert.rejects(withdrawn.service.withdraw('org-a','owner-a','review-a',withdrawal), code('CONFLUENCE_COPY_REVIEW_WITHDRAWN'));
  assert.equal(missing.writes.length + withdrawn.writes.length, 0);
});
