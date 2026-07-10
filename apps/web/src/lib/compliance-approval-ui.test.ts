import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ComplianceSignoffStatus,
  ComplianceApprovalReadinessResponse,
  ComplianceSignoffResponse,
} from '@charitypilot/shared';
import {
  complianceSignoffToDraft,
  isCurrentSignoffDraftGeneration,
  isComplianceSignoffDirty,
  persistedApprovalPresentation,
} from './compliance-approval-ui';

test('a save response only owns the exact draft generation it submitted', () => {
  assert.equal(isCurrentSignoffDraftGeneration(4, 4), true);
  assert.equal(isCurrentSignoffDraftGeneration(4, 5), false);
});

const snapshot = {
  id: 'snapshot-1',
  approvalSequence: 1,
  evidenceHash: 'a'.repeat(64),
  snapshotHash: 'b'.repeat(64),
  approvedAt: '2026-07-10T12:00:00.000Z',
};

const DRAFT = 'DRAFT' as ComplianceSignoffStatus;
const BOARD_REVIEW = 'BOARD_REVIEW' as ComplianceSignoffStatus;
const APPROVED = 'APPROVED' as ComplianceSignoffStatus;

const signoff = (overrides: Partial<ComplianceSignoffResponse> = {}): ComplianceSignoffResponse => ({
  id: 'signoff-1',
  organisationId: 'org-1',
  reportingYear: 2026,
  status: DRAFT,
  boardMeetingDate: null,
  minuteReference: null,
  approvedByName: null,
  approvedByRole: null,
  approvalNotes: null,
  approvedAt: null,
  revision: 1,
  approvalSequence: 0,
  approvalCurrent: false,
  currentApprovalSnapshotId: null,
  currentApproval: null,
  latestApproval: null,
  invalidatedAt: null,
  invalidationReason: null,
  invalidatedById: null,
  updatedById: null,
  updatedAt: '2026-07-10T12:00:00.000Z',
  ...overrides,
});

const readiness = (evidenceHash = 'a'.repeat(64)): ComplianceApprovalReadinessResponse => ({
  ready: true,
  evidenceHash,
  missingRecords: [],
  missingEvidence: [],
  missingExplanations: [],
  profileIssues: [],
  conditionalReviewItems: [],
  matrixReviewItems: [],
  matrixLastChecked: '2026-07-09',
});

test('derives dirty sign-off state from persisted canonical values', () => {
  const saved = signoff({
    status: BOARD_REVIEW,
    boardMeetingDate: '2026-05-20T00:00:00.000Z',
    minuteReference: 'Minute 6',
  });
  const draft = complianceSignoffToDraft(saved);
  assert.equal(draft.boardMeetingDate, '2026-05-20');
  assert.equal(isComplianceSignoffDirty(saved, draft), false);
  assert.equal(isComplianceSignoffDirty(saved, { ...draft, minuteReference: 'Minute 7' }), true);
});

test('reports approval only when persisted current snapshot hash matches fresh readiness', () => {
  const approved = signoff({
    status: APPROVED,
    approvalCurrent: true,
    currentApprovalSnapshotId: snapshot.id,
    currentApproval: snapshot,
    latestApproval: snapshot,
  });
  assert.deepEqual(persistedApprovalPresentation(approved, readiness()), {
    label: 'Approved by board',
    tone: 'success',
    approvalCurrent: true,
  });
  assert.deepEqual(persistedApprovalPresentation(approved, readiness('c'.repeat(64))), {
    label: 'Reapproval required',
    tone: 'warning',
    approvalCurrent: false,
  });
});

test('retained latest snapshot stays available while invalidated current work requires reapproval', () => {
  const invalidated = signoff({
    status: DRAFT,
    latestApproval: snapshot,
    invalidatedAt: '2026-07-10T13:00:00.000Z',
    invalidationReason: 'RECORD_CHANGED',
  });
  assert.deepEqual(persistedApprovalPresentation(invalidated, readiness()), {
    label: 'Reapproval required',
    tone: 'warning',
    approvalCurrent: false,
  });
});

test('an approved status without verifiable readiness never renders as current approval', () => {
  const approved = signoff({
    status: APPROVED,
    approvalCurrent: true,
    currentApprovalSnapshotId: snapshot.id,
    currentApproval: snapshot,
    latestApproval: snapshot,
  });
  assert.deepEqual(
    persistedApprovalPresentation(approved, null),
    { label: 'Approval verification unavailable', tone: 'warning', approvalCurrent: false },
  );
});
