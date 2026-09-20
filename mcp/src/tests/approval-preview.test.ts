import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalState, explainState, formatApprovalPreview } from '../approval-preview.js';

const preview = {
  approvalId: 'apr_1',
  summary: 'Permanently delete board member "Aoife Chairperson" (Chair)',
  method: 'DELETE',
  routePattern: '/api/v1/board-members/:id',
  resourceId: 'bm-1',
  expiresAt: '2026-09-20T10:05:00.000Z',
  approvedAt: null,
  consumedAt: null,
};

test('the preview shows the summary, the action and the record before anything is typed', () => {
  const text = formatApprovalPreview(preview);
  assert.match(text, /Aoife Chairperson/);
  assert.match(text, /DELETE \/api\/v1\/board-members\/:id/);
  assert.match(text, /Record: bm-1/);
  assert.match(text, /Expires: 2026-09-20T10:05:00.000Z/);
});

test('the state distinguishes pending, approved, consumed and expired', () => {
  const before = new Date('2026-09-20T10:00:00.000Z');
  assert.equal(approvalState(preview, before), 'pending');
  assert.equal(approvalState({ ...preview, approvedAt: '2026-09-20T10:01:00.000Z' }, before), 'approved');
  assert.equal(
    approvalState({ ...preview, approvedAt: '2026-09-20T10:01:00.000Z', consumedAt: '2026-09-20T10:02:00.000Z' }, before),
    'consumed',
  );
  assert.equal(approvalState(preview, new Date('2026-09-20T10:06:00.000Z')), 'expired');
});

test('each non-pending state says what the person should do', () => {
  assert.match(explainState('approved'), /already approved/);
  assert.match(explainState('consumed'), /already been used/);
  assert.match(explainState('expired'), /expired/);
});
