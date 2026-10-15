import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConfluenceCopyRecoveryFacts, assertConfluenceCopyRecoveryProgression, CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES } from '../services/confluence-copy-recovery-facts.js';
import { canonicalRetainedConfluenceCopyReviewEvidence } from '../services/confluence-retained-copy-review.js';
import { recoveryFactsFixture } from './fixtures/confluence-copy-recovery-facts.js';

function withdrawnState() {
  const first = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const later = recoveryFactsFixture(); later.operationId = 'state-2'; later.factsRevision = 2; later.previousFactsDigest = first.digest;
  later.capturedAt = '2026-10-15T18:07:00.000Z';
  later.permissionWithdrawal = { id: 'withdrawal-a', organisationId: 'org-a', permissionId: 'permission-a', actorUserId: 'owner-a',
    evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic permission', occurredAt: '2026-10-15T18:06:00.000Z' };
  return { first, later, second: prepareConfluenceCopyRecoveryFacts(later) };
}
test('expired historical decisions remain preservable without permission or reopening authority', () => {
  const facts = recoveryFactsFixture(); facts.capturedAt = '2026-10-16T18:05:00.000Z';
  const result = prepareConfluenceCopyRecoveryFacts(facts);
  assert.equal(result.actionAuthorized, false);
  assert.ok(result.body.includes('OWNER_ATTESTED_SYNTHETIC'));
});
test('a later withdrawal survives progression from a stale backup state', () => {
  const { first, second } = withdrawnState();
  const result = assertConfluenceCopyRecoveryProgression(first.body, second.body);
  assert.ok(JSON.parse(result.body).permissionWithdrawal);
  assert.equal(result.currentHistoryVerified, false);
  assert.equal(result.reopeningAuthorised, false);
});
test('reverse, skipped or forked state lineage cannot be replayed', () => {
  const { first, second, later } = withdrawnState();
  assert.throws(() => assertConfluenceCopyRecoveryProgression(second.body, first.body));
  later.factsRevision = 3;
  assert.throws(() => assertConfluenceCopyRecoveryProgression(first.body, prepareConfluenceCopyRecoveryFacts(later).body));
  later.factsRevision = 2; later.previousFactsDigest = 'f'.repeat(64);
  assert.throws(() => assertConfluenceCopyRecoveryProgression(first.body, prepareConfluenceCopyRecoveryFacts(later).body));
});
test('a later state cannot drop or rewrite a previously recorded withdrawal', () => {
  const { second, later } = withdrawnState();
  later.operationId = 'state-3'; later.factsRevision = 3; later.previousFactsDigest = second.digest;
  later.capturedAt = '2026-10-15T18:08:00.000Z';
  later.permissionWithdrawal = null;
  assert.throws(() => assertConfluenceCopyRecoveryProgression(second.body, prepareConfluenceCopyRecoveryFacts(later).body));
  later.permissionWithdrawal = JSON.parse(second.body).permissionWithdrawal;
  later.permissionWithdrawal!.evidenceRef = 'OTHER-EVIDENCE';
  assert.throws(() => assertConfluenceCopyRecoveryProgression(second.body, prepareConfluenceCopyRecoveryFacts(later).body));
});
for (const [label, change] of Object.entries({
  crossTenant: (f: ReturnType<typeof recoveryFactsFixture>) => { f.permission.organisationId = 'org-b'; },
  differentReview: (f: ReturnType<typeof recoveryFactsFixture>) => { f.scope.reviewId = 'other-review'; },
  changedSnapshot: (f: ReturnType<typeof recoveryFactsFixture>) => { f.review.snapshotSha256 = 'd'.repeat(64); },
  changedPolicy: (f: ReturnType<typeof recoveryFactsFixture>) => { f.permission.disposalPolicyEvidenceRef = 'OTHER-POLICY'; },
  claimedExecution: (f: ReturnType<typeof recoveryFactsFixture>) => { f.review.authorisesProviderIO = true; },
  extendedExpiry: (f: ReturnType<typeof recoveryFactsFixture>) => { f.permission.expiresAt = '2026-10-16T19:00:00.000Z'; },
  futureGrant: (f: ReturnType<typeof recoveryFactsFixture>) => { f.permission.connectionGeneration = '2026-10-16T18:00:00.000Z'; },
  prematureCapture: (f: ReturnType<typeof recoveryFactsFixture>) => { f.capturedAt = '2026-10-15T18:00:00.000Z'; },
  unauditedFields: (f: ReturnType<typeof recoveryFactsFixture>) => { Object.assign(f, { documentBytes: 'unapproved payload' }); },
})) test(`complete recovery facts refuse ${label}`, () => {
  const value = recoveryFactsFixture(); change(value); assert.throws(() => prepareConfluenceCopyRecoveryFacts(value));
});
test('malformed progression input cannot leak its private body in parse errors', () => {
  assert.throws(() => assertConfluenceCopyRecoveryProgression('PRIVATE_DATA', '{}'), (e: Error) => !e.message.includes('PRIVATE_DATA'));
});
test('a later state cannot discard existing scope and permission while keeping a valid bare review', () => {
  const first = prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture());
  const value = { ...recoveryFactsFixture(), scope: null, permission: null, operationId: 'state-2', factsRevision: 2,
    previousFactsDigest: first.digest, capturedAt: '2026-10-15T18:06:00.000Z' };
  assert.throws(() => assertConfluenceCopyRecoveryProgression(first.body, prepareConfluenceCopyRecoveryFacts(value).body));
});
test('a newly appearing decision cannot predate a snapshot that asserted it absent', () => {
  const firstValue = { ...recoveryFactsFixture(), permission: null };
  const first = prepareConfluenceCopyRecoveryFacts(firstValue);
  const next = recoveryFactsFixture(); next.operationId = 'state-2'; next.factsRevision = 2;
  next.previousFactsDigest = first.digest; next.capturedAt = '2026-10-15T18:07:00.000Z';
  assert.throws(() => assertConfluenceCopyRecoveryProgression(first.body, prepareConfluenceCopyRecoveryFacts(next).body));
});
test('complete maximum reviewed version inventory fits without truncation', (t) => {
  const value = recoveryFactsFixture();
  const versions = Array.from({ length: 1000 }, (_, i) => ({ number: Number.MAX_SAFE_INTEGER - i, sha256: 'b'.repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER }));
  value.review.review.snapshot.inventory.attachments = Array.from({ length: 100 }, (_, i) => ({ id: `attachment-${i}`,
    currentVersion: Number.MAX_SAFE_INTEGER, versions }));
  const digest = canonicalRetainedConfluenceCopyReviewEvidence(value.review.review).snapshotSha256;
  value.review.snapshotSha256 = digest; value.scope.snapshotSha256 = digest; value.permission.snapshotSha256 = digest;
  const result = prepareConfluenceCopyRecoveryFacts(value);
  assert.ok(Buffer.byteLength(result.body) <= CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES);
  const retained = JSON.parse(result.body).review.review.snapshot.inventory.attachments;
  assert.equal(retained.length, 100); assert.ok(retained.every((a: { versions: unknown[] }) => a.versions.length === 1000));
  t.diagnostic(`Canonical full-capacity recovery facts: ${Buffer.byteLength(result.body)} bytes; 100000 retained attachment versions`);
});
