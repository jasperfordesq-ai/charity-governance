import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalReadinessBlockerCodes, approvalReadinessSummary, countApprovalReadinessBlockers, narrativeWarningLines } from './approval-readiness';
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
  narrativeWarnings: [],
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

test('narrative staleness warnings are worded for the board and never counted as blockers', () => {
  const result = readiness({
    ready: true,
    narrativeWarnings: [
      {
        kind: 'EVIDENCE_LINKED_AFTER_NARRATIVE', standardId: 'std-23', standardCode: '2.3',
        recordUpdatedAt: '2026-09-01T10:00:00.000Z', documentId: 'doc-a', linkedAt: '2026-10-14T10:00:00.000Z',
      },
      {
        kind: 'TARGET_DATE_PASSED', standardId: 'std-23', standardCode: '2.3',
        recordUpdatedAt: '2026-09-01T10:00:00.000Z', targetDate: '2026-09-03',
      },
    ],
  });

  const lines = narrativeWarningLines(result);
  assert.deepEqual(lines.map((line) => [line.standardCode, line.title]), [
    ['2.3', 'Evidence linked after the narrative was written'],
    ['2.3', 'Target date has passed'],
  ]);
  assert.match(lines[0]!.description, /linked on 14 Oct 2026, after the actions taken and evidence were last edited on 1 Sept? 2026/);
  assert.match(lines[1]!.description, /target of 3 Sept? 2026, which has passed/);
  assert.equal(new Set(lines.map((line) => line.key)).size, 2, 'each warning has its own key');
  assert.equal(countApprovalReadinessBlockers(result), 0, 'a warning is not a blocker');
  assert.deepEqual(approvalReadinessBlockerCodes(result), []);
});

test('an older API that sends no narrative warnings shows none rather than failing', () => {
  const legacy = { ...readiness() } as Partial<ApprovalReadiness>;
  delete legacy.narrativeWarnings;
  assert.deepEqual(narrativeWarningLines(legacy as ApprovalReadiness), []);
  assert.deepEqual(narrativeWarningLines(null), []);
});
