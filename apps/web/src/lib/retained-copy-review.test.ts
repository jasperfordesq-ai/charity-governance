import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyntheticCopyReview, SYNTHETIC_REVIEW_FIELDS } from './retained-copy-review';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const actor = { id: 'owner-a', organisationId: 'org-a', role: 'OWNER' };
const observation = { sourceBytesObserved: true, actionAuthorized: false, syntheticVerified: false, allCopiesVerified: false,
  snapshot: { organisationId: 'org-a', publicationId: 'pub-a', sourceSha256: 'a'.repeat(64), lifecycleStatus: 'RETIRED',
    deletionHold: false, externalPublicationApproved: false, publicationState: 'RETIRED',
    inventory: { observedAt: new Date(now - 1000).toISOString(), complete: true, status: 'CURRENT' } } };
const references = Object.fromEntries(SYNTHETIC_REVIEW_FIELDS.map(({ key }) => [key, 'SYNTHETIC-DECISION']));

test('review builder binds the authenticated Owner and observed target with explicit bounded validity', () => {
  const result = buildSyntheticCopyReview({ actor, observation, publicationId: 'pub-a', references,
    validityMinutes: 30, confirmed: true }, now);
  assert.equal(result.reviewerId, 'owner-a');
  assert.equal(result.scope, 'SYNTHETIC_ONLY');
  assert.equal(result.primaryDisposition, 'RETAIN');
  assert.equal(result.copyDisposition, 'PURGE');
  assert.equal(result.reviewedAt, new Date(now).toISOString());
  assert.equal(Date.parse(result.expiresAt) - now, 30 * 60000);
  assert.deepEqual(result.snapshot, observation.snapshot);
  assert.equal('providerIOAuthorised' in result, false);
});

test('wrong role, tenant, target, observation, references or validity cannot produce a review', () => {
  const valid = { actor, observation, publicationId: 'pub-a', references, validityMinutes: 30, confirmed: true };
  for (const change of [{ actor: { ...actor, role: 'ADMIN' } }, { actor: { ...actor, organisationId: 'org-b' } },
    { publicationId: 'other-publication' }, { confirmed: false }, { references: {} },
    ...[0, 61, 1.5, NaN].map(validityMinutes => ({ validityMinutes })),
    { observation: { ...observation, sourceBytesObserved: false } },
    { observation: { ...observation, actionAuthorized: true } },
    { observation: { ...observation, snapshot: { ...observation.snapshot, deletionHold: true } } },
    { references: { ...references, evidenceRef: '<script>' } }]) {
    assert.throws(() => buildSyntheticCopyReview({ ...valid, ...change }, now));
  }
  assert.throws(() => buildSyntheticCopyReview(valid, now - 2000));
});
