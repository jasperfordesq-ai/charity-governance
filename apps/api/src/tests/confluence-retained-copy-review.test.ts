import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareRetainedConfluenceCopyReview,
  assertRetainedConfluenceCopyReviewCurrent,
} from '../services/confluence-retained-copy-review.js';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const snapshot = () => ({
  organisationId: 'synthetic-org', documentId: 'synthetic-document',
  sourceRevision: '2026-10-15T17:00:00.000Z', sourceSha256: 'a'.repeat(64),
  lifecycleStatus: 'RETIRED', deletionHold: false, externalPublicationApproved: false,
  publicationId: 'synthetic-publication', publicationRevision: '2026-10-15T17:01:00.000Z',
  publicationState: 'RETIRED', cloudId: '00000000-0000-4000-8000-000000000001',
  siteOrigin: 'https://synthetic-example.atlassian.net', spaceId: '123', pageId: '456',
  inventory: {
    observedAt: '2026-10-15T17:59:00.000Z', status: 'CURRENT', complete: true,
    currentPageVersion: 2, pageVersions: [2, 1],
    attachments: [{ id: 'att789', currentVersion: 2, versions: [
      { number: 2, sha256: 'b'.repeat(64), sizeBytes: 243 },
      { number: 1, sha256: 'c'.repeat(64), sizeBytes: 200 },
    ] }],
  },
});
const review = () => ({
  scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE',
  reviewerId: 'synthetic-owner', evidenceRef: 'C01-SYNTHETIC-COPY-REVIEW',
  retentionDecisionRef: 'C01-RETAIN-PRIMARY', holdReviewRef: 'C01-NO-HOLD',
  inventoryEvidenceRef: 'C01-COMPLETE-INVENTORY', syntheticEvidenceRef: 'C01-SYNTHETIC-FIXTURE',
  reviewedAt: NOW.toISOString(), expiresAt: '2026-10-15T19:00:00.000Z',
  snapshot: snapshot(),
});
const refuses = (fn: () => unknown) => assert.throws(fn, (e: { code?: string }) =>
  ['CONFLUENCE_COPY_REVIEW_INVALID', 'CONFLUENCE_COPY_REVIEW_STALE'].includes(e.code ?? ''));

test('retained-copy review is a detached, non-authorising candidate even with explicit purpose', () => {
  const input = review();
  const candidate = prepareRetainedConfluenceCopyReview(input, NOW);
  assert.equal(candidate.kind, 'CONFLUENCE_RETAINED_COPY_REVIEW_CANDIDATE');
  assert.equal(candidate.authorisesProviderIO, false);
  assert.match(candidate.snapshotSha256, /^[a-f0-9]{64}$/);
  input.snapshot.inventory.attachments[0]!.versions[0]!.sha256 = 'd'.repeat(64);
  assert.equal(candidate.review.snapshot.inventory.attachments[0]!.versions[1]!.sha256, 'b'.repeat(64));
});

test('provider ordering does not change the exact inventory binding', () => {
  const first = prepareRetainedConfluenceCopyReview(review(), NOW);
  const reordered = review();
  reordered.snapshot.inventory.pageVersions.reverse();
  reordered.snapshot.inventory.attachments[0]!.versions.reverse();
  assert.equal(prepareRetainedConfluenceCopyReview(reordered, NOW).snapshotSha256, first.snapshotSha256);
  reordered.snapshot.inventory.observedAt = NOW.toISOString();
  assertRetainedConfluenceCopyReviewCurrent(first, reordered.snapshot, NOW);
});

test('a freshly read identical snapshot matches, without granting execution', () => {
  const candidate = prepareRetainedConfluenceCopyReview(review(), NOW);
  const fresh = snapshot();
  fresh.inventory.observedAt = NOW.toISOString();
  assert.equal(assertRetainedConfluenceCopyReviewCurrent(candidate, fresh, NOW), undefined);
  assert.equal(candidate.authorisesProviderIO, false);
});

for (const [label, change] of Object.entries({
  'other charity': (s: ReturnType<typeof snapshot>) => { s.organisationId = 'other-org'; },
  'other source': (s: ReturnType<typeof snapshot>) => { s.documentId = 'other-document'; },
  'changed source revision': (s: ReturnType<typeof snapshot>) => { s.sourceRevision = NOW.toISOString(); },
  'changed primary bytes': (s: ReturnType<typeof snapshot>) => { s.sourceSha256 = 'd'.repeat(64); },
  'changed publication': (s: ReturnType<typeof snapshot>) => { s.publicationId = 'other-publication'; },
  'changed publication revision': (s: ReturnType<typeof snapshot>) => { s.publicationRevision = NOW.toISOString(); },
  'other cloud': (s: ReturnType<typeof snapshot>) => { s.cloudId = '00000000-0000-4000-8000-000000000002'; },
  'other site': (s: ReturnType<typeof snapshot>) => { s.siteOrigin = 'https://other-example.atlassian.net'; },
  'other space': (s: ReturnType<typeof snapshot>) => { s.spaceId = '999'; },
  'other page': (s: ReturnType<typeof snapshot>) => { s.pageId = '999'; },
  'new page version': (s: ReturnType<typeof snapshot>) => { s.inventory.currentPageVersion = 3; s.inventory.pageVersions.push(3); },
  'changed attachment bytes': (s: ReturnType<typeof snapshot>) => { s.inventory.attachments[0]!.versions[0]!.sha256 = 'd'.repeat(64); },
  'missing version': (s: ReturnType<typeof snapshot>) => { s.inventory.attachments[0]!.versions.pop(); },
  'new attachment': (s: ReturnType<typeof snapshot>) => { s.inventory.attachments.push({ id: 'att999', currentVersion: 1, versions: [{ number: 1, sha256: 'd'.repeat(64), sizeBytes: 1 }] }); },
})) {
  test(`review comparison refuses ${label}`, () => {
    const current = snapshot(); current.inventory.observedAt = NOW.toISOString(); change(current);
    refuses(() => assertRetainedConfluenceCopyReviewCurrent(
      prepareRetainedConfluenceCopyReview(review(), NOW), current, NOW));
  });
}

for (const [label, change] of Object.entries({
  'legal hold': (r: ReturnType<typeof review>) => { r.snapshot.deletionHold = true; },
  'active publication approval': (r: ReturnType<typeof review>) => { r.snapshot.externalPublicationApproved = true; },
  'active source': (r: ReturnType<typeof review>) => { r.snapshot.lifecycleStatus = 'CURRENT'; },
  'active publication': (r: ReturnType<typeof review>) => { r.snapshot.publicationState = 'PROCESSED'; },
  'Trash inventory': (r: ReturnType<typeof review>) => { r.snapshot.inventory.status = 'TRASHED'; },
  'incomplete inventory': (r: ReturnType<typeof review>) => { r.snapshot.inventory.complete = false; },
  'duplicate page version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.pageVersions.push(2); },
  'duplicate attachment': (r: ReturnType<typeof review>) => { r.snapshot.inventory.attachments.push(r.snapshot.inventory.attachments[0]); },
  'duplicate attachment version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.attachments[0].versions.push(r.snapshot.inventory.attachments[0].versions[0]); },
  'missing current page version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.pageVersions = [1]; },
  'page history ahead of current version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.pageVersions.push(3); },
  'attachment history ahead of current version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.attachments[0]!.versions.push({ number: 3, sha256: 'd'.repeat(64), sizeBytes: 1 }); },
  'missing current attachment version': (r: ReturnType<typeof review>) => { r.snapshot.inventory.attachments[0].versions = [r.snapshot.inventory.attachments[0].versions[1]]; },
  'production scope': (r: ReturnType<typeof review>) => { r.scope = 'PRODUCTION'; },
  'primary destruction': (r: ReturnType<typeof review>) => { r.primaryDisposition = 'PURGE'; },
  'no explicit copy disposition': (r: ReturnType<typeof review>) => { Reflect.deleteProperty(r, 'copyDisposition'); },
  'no review evidence': (r: ReturnType<typeof review>) => { r.evidenceRef = ''; },
  'unknown permission flag': (r: ReturnType<typeof review>) => { Object.assign(r, { authorised: true }); },
  'redirect-like site': (r: ReturnType<typeof review>) => { r.snapshot.siteOrigin += '.evil.example'; },
  'future observation': (r: ReturnType<typeof review>) => { r.snapshot.inventory.observedAt = '2026-10-16T00:00:00.000Z'; },
  'future review': (r: ReturnType<typeof review>) => { r.reviewedAt = '2026-10-16T00:00:00.000Z'; },
  'expired review': (r: ReturnType<typeof review>) => { r.expiresAt = NOW.toISOString(); },
})) {
  test(`review preparation refuses ${label}`, () => {
    const input = review(); change(input);
    refuses(() => prepareRetainedConfluenceCopyReview(input, NOW));
  });
}

test('expired, tampered and forged candidates cannot pass comparison', () => {
  const candidate = prepareRetainedConfluenceCopyReview(review(), NOW);
  refuses(() => assertRetainedConfluenceCopyReviewCurrent(candidate, snapshot(), new Date('2026-10-15T19:00:00.000Z')));
  refuses(() => assertRetainedConfluenceCopyReviewCurrent({ ...candidate, snapshotSha256: '0'.repeat(64) }, snapshot(), NOW));
  refuses(() => assertRetainedConfluenceCopyReviewCurrent({ ...candidate, authorisesProviderIO: true }, snapshot(), NOW));
});

test('comparison requires a provider observation at or after the explicit review', () => {
  refuses(() => assertRetainedConfluenceCopyReviewCurrent(
    prepareRetainedConfluenceCopyReview(review(), NOW), snapshot(), NOW));
});

test('invalid clocks cannot make an expired review appear current', () => {
  refuses(() => prepareRetainedConfluenceCopyReview(review(), new Date('invalid')));
  refuses(() => assertRetainedConfluenceCopyReviewCurrent(
    prepareRetainedConfluenceCopyReview(review(), NOW), snapshot(), new Date('invalid')));
});
