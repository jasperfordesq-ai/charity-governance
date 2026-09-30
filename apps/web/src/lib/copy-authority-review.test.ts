import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentCopyPolicy, latestCopyAuthority, type CopyAuthority } from './copy-authority-review';

test('copy policy selection refuses missing or competing approvals', () => {
  const approved = { id: 'p1', revision: 1, state: 'APPROVED', withdrawal: null, retentionMode: 'REVIEW_REQUIRED', retentionDays: null };
  assert.equal(currentCopyPolicy([]), null);
  assert.equal(currentCopyPolicy([approved]), approved);
  assert.equal(currentCopyPolicy([approved, { ...approved, id: 'p2' }]), null);
  assert.equal(currentCopyPolicy([{ ...approved, withdrawal: {} }, { ...approved, id: 'draft', state: 'DRAFT' }]), null);
});
test('authority selection keeps withdrawals and scopes separate', () => {
  const row = { id: 'a1', area: 'BACKUPS', scopeRef: 'SET-001', revision: 1, state: 'AUTHORIZED' } as CopyAuthority;
  const withdrawn = { ...row, id: 'a2', revision: 2, state: 'WITHDRAWN' as const };
  assert.equal(latestCopyAuthority([row, withdrawn, { ...row, revision: 9, area: 'EXPORTS' }], 'BACKUPS', 'SET-001'), withdrawn);
  assert.equal(latestCopyAuthority([row], 'BACKUPS', 'SET-002'), null);
});
