import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSyntheticConfluenceScope } from '../services/confluence-synthetic-scope.js';
import { recoveryFactsFixture } from './fixtures/confluence-copy-recovery-facts.js';
import { prepareRetainedConfluenceCopyReview } from '../services/confluence-retained-copy-review.js';

function fixture() {
  const review = recoveryFactsFixture().review.review;
  const now = new Date(review.reviewedAt);
  const candidate = prepareRetainedConfluenceCopyReview(review, now);
  const state = { maintenance: true, owner: true, active: true, bound: false, withdrawn: false,
    existing: null as null | Record<string, unknown>, writes: 0 };
  const tx = {
    $queryRaw: async () => [{ maintenance: state.maintenance, now, database: 'synthetic', dbRole: 'maintenance', address: '127.0.0.1', port: 5432 }],
    organisation: { findFirst: async () => state.active ? { id: review.snapshot.organisationId } : null },
    user: { findFirst: async () => state.owner ? { id: review.reviewerId } : null },
    documentRecoveryEnforcement: { findUnique: async () => state.bound ? { id: 'bound' } : null },
    confluenceRetainedCopyReview: { findFirst: async () => ({ id: 'review-a', review,
      snapshotSha256: candidate.snapshotSha256, withdrawal: state.withdrawn ? { id: 'withdrawn' } : null }) },
    confluenceSyntheticCopyScope: {
      findFirst: async () => state.existing,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.writes++; state.existing = { id: 'scope-a', ...data }; return state.existing;
      },
    },
  };
  const prisma = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
  const input = { organisationId: review.snapshot.organisationId, approvedById: review.reviewerId,
    reviewId: 'review-a', expectedSnapshotSha256: candidate.snapshotSha256,
    evidenceRef: 'SYNTHETIC-SCOPE', disposalPolicyEvidenceRef: 'SYNTHETIC-DISPOSAL',
    expiresAt: new Date(Math.min(Date.parse(review.expiresAt), now.getTime() + 1800000)).toISOString() };
  return { state, input, prisma: prisma as never };
}

test('scope preview writes nothing and exact confirmation registers once with no provider authority', async () => {
  const h = fixture();
  const preview = await registerSyntheticConfluenceScope(h.prisma, h.input);
  assert.equal(preview.state, 'PREVIEW'); assert.equal(h.state.writes, 0);
  assert.equal(preview.providerIOAuthorised, false);
  const result = await registerSyntheticConfluenceScope(h.prisma, h.input, preview.confirmationSha256);
  assert.equal(result.state, 'REGISTERED'); assert.equal(h.state.writes, 1);
  const retry = await registerSyntheticConfluenceScope(h.prisma, h.input, preview.confirmationSha256);
  assert.equal(retry.state, 'ALREADY_REGISTERED'); assert.equal(h.state.writes, 1);
  assert.equal(retry.scopeId, result.scopeId); assert.equal(retry.providerIOAuthorised, false);
});

for (const flag of ['maintenance', 'owner', 'active'] as const) test(`scope refuses missing ${flag} before registration`, async () => {
  const h = fixture(); h.state[flag] = false;
  await assert.rejects(registerSyntheticConfluenceScope(h.prisma, h.input)); assert.equal(h.state.writes, 0);
});
for (const flag of ['bound', 'withdrawn'] as const) test(`scope refuses ${flag} decisions`, async () => {
  const h = fixture(); h.state[flag] = true;
  await assert.rejects(registerSyntheticConfluenceScope(h.prisma, h.input)); assert.equal(h.state.writes, 0);
});
test('a changed reviewed digest or target input cannot reuse the preview confirmation', async () => {
  const h = fixture(); const preview = await registerSyntheticConfluenceScope(h.prisma, h.input);
  await assert.rejects(registerSyntheticConfluenceScope(h.prisma, { ...h.input, evidenceRef: 'OTHER-SCOPE' }, preview.confirmationSha256));
  await assert.rejects(registerSyntheticConfluenceScope(h.prisma, { ...h.input, expectedSnapshotSha256: 'f'.repeat(64) }, preview.confirmationSha256));
  assert.equal(h.state.writes, 0);
});
test('registration refuses conflicts rather than replacing original scope evidence', async () => {
  const h = fixture(); const preview = await registerSyntheticConfluenceScope(h.prisma, h.input);
  await registerSyntheticConfluenceScope(h.prisma, h.input, preview.confirmationSha256);
  await assert.rejects(registerSyntheticConfluenceScope(h.prisma, { ...h.input, disposalPolicyEvidenceRef: 'OTHER-POLICY' }));
  assert.equal(h.state.writes, 1);
});
test('malformed, expired, overlong and foreign review inputs cannot write', async () => {
  for (const mutate of [
    (h: ReturnType<typeof fixture>) => ({ ...h.input, arbitrary: 'not accepted' }),
    (h: ReturnType<typeof fixture>) => ({ ...h.input, expiresAt: '2000-01-01T00:00:00.000Z' }),
    (h: ReturnType<typeof fixture>) => ({ ...h.input, expiresAt: '2099-01-01T00:00:00.000Z' }),
    (h: ReturnType<typeof fixture>) => ({ ...h.input, organisationId: 'foreign' }),
  ]) {
    const h = fixture(); await assert.rejects(registerSyntheticConfluenceScope(h.prisma, mutate(h))); assert.equal(h.state.writes, 0);
  }
});
