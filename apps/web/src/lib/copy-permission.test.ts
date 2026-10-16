import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopyPermission } from './copy-permission';
const now = Date.parse('2026-10-16T12:00:00.000Z');
const review = { id: 'review-a', snapshotSha256: 'a'.repeat(64), expiresAt: '2026-10-16T12:30:00.000Z', withdrawnAt: null };
const fields = { scopeId: 'scope-a', scopeEvidenceRef: 'SYNTHETIC-SCOPE', disposalPolicyEvidenceRef: 'SYNTHETIC-DISPOSAL',
  evidenceRef: 'OWNER-PERMISSION', reason: 'Retain the primary and dispose of this synthetic remote copy.', expiresAt: '2026-10-16T12:20:00.000Z' };
const valid = { role: 'OWNER', review, fields, confirmed: true };
test('permission preparation binds exact review digest and explicit registered-scope evidence without actor or target overrides', () => {
  assert.deepEqual(buildCopyPermission({ ...valid, fields: { ...fields, organisationId: 'foreign-org', reviewerId: 'other-actor', pageId: 'other-page' } }, now), { ...fields, expectedSnapshotSha256: review.snapshotSha256,
    attestation: 'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY' });
});
test('permission preparation refuses withdrawn or expired reviews, absent attestation and malformed scope/evidence/time', () => {
  for (const change of [{ role: 'ADMIN' }, { confirmed: false }, { review: { ...review, withdrawnAt: new Date(now).toISOString() } },
    { review: { ...review, expiresAt: new Date(now).toISOString() } }, { review: { ...review, snapshotSha256: 'bad' } }]) {
    assert.throws(() => buildCopyPermission({ ...valid, ...change }, now));
  }
  for (const change of [{ scopeId: 'bad/scope' }, { scopeEvidenceRef: '' }, { disposalPolicyEvidenceRef: 'unknown' },
    { reason: 'short' }, { reason: 'A multiline\nreason is not accepted' },
    { expiresAt: new Date(now).toISOString() }, { expiresAt: '2026-10-16T12:31:00.000Z' }, { expiresAt: '2026-10-16T12:20:00Z' }]) {
    assert.throws(() => buildCopyPermission({ ...valid, fields: { ...fields, ...change } }, now));
  }
});
