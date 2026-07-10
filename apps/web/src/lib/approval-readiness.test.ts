import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalReadinessBlockerCodes, approvalReadinessSummary, countApprovalReadinessBlockers } from './approval-readiness';
import type { ApprovalReadiness } from './approval-readiness';

const readiness = (overrides: Partial<ApprovalReadiness> = {}): ApprovalReadiness => ({
  ready: false,
  evidenceHash: 'a'.repeat(64),
  missingRecords: [],
  missingEvidence: [],
  missingExplanations: [],
  profileIssues: [],
  conditionalReviewItems: [],
  matrixReviewItems: [],
  matrixLastChecked: '2026-07-09',
  ...overrides,
});

test('approval readiness counts every board-approval blocker category', () => {
  const result = readiness({
    missingRecords: [{ standardId: 'std-1', standardCode: '1.1', status: 'NOT_STARTED' }],
    missingEvidence: [
      {
        standardId: 'std-2',
        standardCode: '2.1',
        status: 'COMPLIANT',
        missingActionTaken: true,
        missingEvidence: true,
      },
    ],
    missingExplanations: [{ standardId: 'std-3', standardCode: '3.1', status: 'EXPLAIN' }],
    profileIssues: [{ code: 'CONDITIONAL_OBLIGATION_PROFILE_MISSING', message: 'Capture the profile.' }],
  });

  assert.equal(countApprovalReadinessBlockers(result), 4);
  assert.deepEqual(approvalReadinessBlockerCodes(result), ['1.1', '2.1', '3.1']);
  assert.equal(
    approvalReadinessSummary(result),
    '4 approval-readiness blockers: 1 missing standard record, 1 missing evidence field, 1 missing explanation, 1 organisation profile check.',
  );
});

test('approval readiness summary handles clear or unavailable readiness', () => {
  assert.equal(countApprovalReadinessBlockers(null), 0);
  assert.deepEqual(approvalReadinessBlockerCodes(undefined), []);
  assert.equal(
    approvalReadinessSummary(readiness({ ready: true })),
    'No annual approval-readiness blockers are currently visible.',
  );
});
