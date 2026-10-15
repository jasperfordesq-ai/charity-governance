import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceRetainedCopyPermissionService } from '../services/confluence-retained-copy-permission.service.js';
import { prepareRetainedConfluenceCopyReview } from '../services/confluence-retained-copy-review.js';

const NOW = new Date('2026-10-15T18:10:00.000Z');
function fixture() {
  const review = {
    scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE', reviewerId: 'owner-a',
    evidenceRef: 'C01-REVIEW', retentionDecisionRef: 'C01-RETAIN', holdReviewRef: 'C01-HOLD',
    inventoryEvidenceRef: 'C01-INVENTORY', syntheticEvidenceRef: 'C01-SYNTHETIC',
    reviewedAt: '2026-10-15T18:00:00.000Z', expiresAt: '2026-10-15T19:00:00.000Z',
    snapshot: { organisationId: 'org-a', documentId: 'doc-a', sourceRevision: '2026-10-15T17:00:00.000Z',
      sourceSha256: 'a'.repeat(64), lifecycleStatus: 'RETIRED', deletionHold: false, externalPublicationApproved: false,
      publicationId: 'pub-a', publicationRevision: '2026-10-15T17:01:00.000Z', publicationState: 'RETIRED',
      cloudId: '00000000-0000-4000-8000-000000000001', siteOrigin: 'https://synthetic-example.atlassian.net',
      spaceId: 'space-a', pageId: 'page-a', inventory: { observedAt: '2026-10-15T17:59:00.000Z', status: 'CURRENT',
        complete: true, currentPageVersion: 1, pageVersions: [1], attachments: [] } },
  };
  const prepared = prepareRetainedConfluenceCopyReview(review, NOW);
  const state = { owner: true, active: true, bound: false, reviewWithdrawn: false, permissionWithdrawn: false,
    scopePresent: true, scopePolicy: 'C01-COPY-DISPOSAL', scopeExpires: new Date('2026-10-15T18:50:00.000Z'), clock: NOW };
  const calls = { observations: 0, writes: [] as Array<{ kind: string; data: Record<string, unknown> }> };
  const tx = {
    $queryRaw: async () => [{ now: state.clock }],
    organisation: { findFirst: async () => state.active ? { id: 'org-a' } : null },
    user: { findFirst: async () => state.owner ? { id: 'owner-a' } : null },
    documentRecoveryEnforcement: { findUnique: async () => state.bound ? { id: 'bound' } : null },
    confluenceRetainedCopyReview: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      where.id === 'review-a' && where.organisationId === 'org-a' ? { id: 'review-a', organisationId: 'org-a',
        documentId: 'doc-a', publicationId: 'pub-a', reviewerId: 'owner-a', review: structuredClone(review),
        snapshotSha256: prepared.snapshotSha256, withdrawal: state.reviewWithdrawn ? { id: 'withdrawn' } : null } : null },
    confluenceSyntheticCopyScope: { findFirst: async () => state.scopePresent ? {
      id: 'scope-a', organisationId: 'org-a', reviewId: 'review-a', snapshotSha256: prepared.snapshotSha256,
      classification: 'SYNTHETIC_ONLY', evidenceRef: 'C01-SCOPE', disposalPolicyEvidenceRef: state.scopePolicy,
      expiresAt: state.scopeExpires,
    } : null },
    confluenceRetainedCopyPermission: {
      create: async ({ data }: { data: Record<string, unknown> }) => { calls.writes.push({ kind: 'permission', data }); return { id: 'permission-a', ...data }; },
      findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
        where.id === 'permission-a' && where.organisationId === 'org-a' ? {
          id: 'permission-a', withdrawal: state.permissionWithdrawn ? { id: 'withdrawn' } : null } : null,
    },
    confluenceRetainedCopyPermissionWithdrawal: { create: async ({ data }: { data: Record<string, unknown> }) => {
      calls.writes.push({ kind: 'withdrawal', data }); return { id: 'withdrawal-a', ...data };
    } },
  };
  const prisma = { ...tx, $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
  const observation = { snapshot: structuredClone(prepared.review.snapshot), actorUserId: 'owner-a',
    connection: { integrationId: 'integration-a', connectedAt: '2026-10-15T16:00:00.000Z',
      cloudId: '00000000-0000-4000-8000-000000000001', siteOrigin: 'https://synthetic-example.atlassian.net' },
    sourceBytesObserved: true as const, syntheticVerified: false as const, allCopiesVerified: false as const, actionAuthorized: false as const };
  observation.snapshot.inventory.observedAt = NOW.toISOString();
  const input = { scopeId: 'scope-a', expectedSnapshotSha256: prepared.snapshotSha256,
    scopeEvidenceRef: 'C01-SCOPE', disposalPolicyEvidenceRef: 'C01-COPY-DISPOSAL', evidenceRef: 'C01-OWNER-DECISION',
    reason: 'Dispose only of the reviewed synthetic remote copy', expiresAt: '2026-10-15T18:40:00.000Z',
    attestation: 'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY' };
  const service = new ConfluenceRetainedCopyPermissionService(prisma as never, {
    observeSource: async () => { calls.observations++; return observation; },
  });
  return { review, prepared, state, calls, observation, input, service };
}
test('issues an exact Owner-attested decision after a fresh observed snapshot, with no provider execution', async () => {
  const h = fixture(); const result = await h.service.issue('org-a', 'owner-a', 'review-a', h.input);
  assert.equal(h.calls.observations, 1); assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0]?.data.classification, 'OWNER_ATTESTED_SYNTHETIC');
  assert.equal(h.calls.writes[0]?.data.snapshotSha256, h.prepared.snapshotSha256);
  assert.equal(h.calls.writes[0]?.data.integrationId, 'integration-a');
  assert.equal(result.providerIOAuthorised, false);
});
for (const [label, mutate] of Object.entries({
  noOwner: (h: ReturnType<typeof fixture>) => { h.state.owner = false; },
  inactive: (h: ReturnType<typeof fixture>) => { h.state.active = false; },
  recoveryBound: (h: ReturnType<typeof fixture>) => { h.state.bound = true; },
  missingScope: (h: ReturnType<typeof fixture>) => { h.state.scopePresent = false; },
  withdrawnReview: (h: ReturnType<typeof fixture>) => { h.state.reviewWithdrawn = true; },
  mismatchedReviewedDigest: (h: ReturnType<typeof fixture>) => { h.input.expectedSnapshotSha256 = 'd'.repeat(64); },
  wrongScopeDecision: (h: ReturnType<typeof fixture>) => { h.input.scopeEvidenceRef = 'OTHER-SCOPE'; },
  wrongPolicyDecision: (h: ReturnType<typeof fixture>) => { h.input.disposalPolicyEvidenceRef = 'OTHER-POLICY'; },
  beyondScopeExpiry: (h: ReturnType<typeof fixture>) => { h.input.expiresAt = '2026-10-15T18:55:00.000Z'; },
  missingAttestation: (h: ReturnType<typeof fixture>) => { h.input.attestation = ''; },
})) test(`issuance refuses ${label} before provider observation`, async () => {
  const h = fixture(); mutate(h);
  await assert.rejects(h.service.issue('org-a', 'owner-a', 'review-a', h.input));
  assert.equal(h.calls.observations + h.calls.writes.length, 0);
});
test('changed current primary hash cannot be promoted by an old reviewed digest', async () => {
  const h = fixture(); h.observation.snapshot.sourceSha256 = 'd'.repeat(64);
  await assert.rejects(h.service.issue('org-a','owner-a','review-a',h.input));
  assert.equal(h.calls.writes.length, 0);
});
test('review withdrawal occurring during observation is rechecked before insert', async () => {
  const h = fixture();
  Object.defineProperty(h.observation, 'sourceBytesObserved', { get: () => { h.state.reviewWithdrawn = true; return true; } });
  await assert.rejects(h.service.issue('org-a','owner-a','review-a',h.input));
  assert.equal(h.calls.writes.length, 0);
});
test('permission expiry reached during observation refuses at final database clock', async () => {
  const h = fixture();
  Object.defineProperty(h.observation, 'sourceBytesObserved', { get: () => {
    h.state.clock = new Date(h.input.expiresAt); return true;
  } });
  await assert.rejects(h.service.issue('org-a','owner-a','review-a',h.input));
  assert.equal(h.calls.writes.length, 0);
});
test('cross-charity review selection cannot start a provider read', async () => {
  const h = fixture();
  await assert.rejects(h.service.issue('org-b','owner-a','review-a',h.input));
  assert.equal(h.calls.observations + h.calls.writes.length, 0);
});
test('permission withdrawal is a separate retained decision and repeated withdrawal refuses', async () => {
  const h = fixture(); const reason = { evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw this synthetic copy permission' };
  await h.service.withdraw('org-a','owner-a','permission-a',reason);
  assert.equal(h.calls.writes[0]?.kind, 'withdrawal');
  h.state.permissionWithdrawn = true;
  await assert.rejects(h.service.withdraw('org-a','owner-a','permission-a',reason));
  assert.equal(h.calls.writes.length, 1);
});
