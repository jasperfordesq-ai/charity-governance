import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyPolicyDescription, copyPolicyNeedsAnchor, copyPolicyTermsValid, currentCopyPolicy, latestCopyAuthority, type CopyAuthority, type CopyPolicy } from './copy-authority-review';

test('copy policy selection refuses missing or competing approvals', () => {
  const approved = { id: 'p1', revision: 1, state: 'APPROVED', withdrawal: null, retentionMode: 'REVIEW_REQUIRED',
    retentionAnchor: null, retentionDays: null, retentionYears: null };
  assert.equal(currentCopyPolicy([]), null);
  assert.equal(currentCopyPolicy([approved]), approved);
  assert.equal(currentCopyPolicy([approved, { ...approved, id: 'p2' }]), null);
  assert.equal(currentCopyPolicy([{ ...approved, withdrawal: {} }, { ...approved, id: 'draft', state: 'DRAFT' }]), null);
});

test('calendar copy terms require the creation anchor and a single bounded year term', () => {
  const policy: CopyPolicy = { id: 'p1', revision: 1, state: 'APPROVED', withdrawal: null,
    retentionMode: 'AFTER_CALENDAR_YEARS', retentionAnchor: 'CREATED_AT', retentionDays: null, retentionYears: 6 };
  assert.equal(copyPolicyTermsValid(policy), true);
  assert.equal(copyPolicyNeedsAnchor(policy), true);
  assert.equal(copyPolicyDescription(policy), '6 calendar years from copy creation');
  for (const change of [
    { retentionYears: null }, { retentionYears: 101 }, { retentionDays: 10 },
    { retentionAnchor: null }, { retentionMode: 'UNKNOWN' },
  ]) assert.equal(copyPolicyTermsValid({ ...policy, ...change }), false);
  assert.equal(copyPolicyNeedsAnchor({ ...policy, retentionMode: 'REVIEW_REQUIRED' }), false);
});
test('authority selection keeps withdrawals and scopes separate', () => {
  const row = { id: 'a1', area: 'BACKUPS', scopeRef: 'SET-001', revision: 1, state: 'AUTHORIZED' } as CopyAuthority;
  const withdrawn = { ...row, id: 'a2', revision: 2, state: 'WITHDRAWN' as const };
  assert.equal(latestCopyAuthority([row, withdrawn, { ...row, revision: 9, area: 'EXPORTS' }], 'BACKUPS', 'SET-001'), withdrawn);
  assert.equal(latestCopyAuthority([row], 'BACKUPS', 'SET-002'), null);
});
