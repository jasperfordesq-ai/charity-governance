import type {
  ComplianceSignoffStatus,
  ComplianceApprovalReadinessResponse,
  ComplianceSignoffResponse,
} from '@charitypilot/shared';

export type ComplianceSignoffDraft = {
  status: ComplianceSignoffStatus;
  boardMeetingDate: string;
  minuteReference: string;
  approvedByName: string;
  approvedByRole: string;
  approvalNotes: string;
};

export type PersistedApprovalPresentation = {
  label: string;
  tone: 'default' | 'success' | 'warning';
  approvalCurrent: boolean;
};

export function isCurrentSignoffDraftGeneration(
  submittedGeneration: number,
  currentGeneration: number,
): boolean {
  return submittedGeneration === currentGeneration;
}

const toDateInput = (value: string | null | undefined) => value?.slice(0, 10) ?? '';

export function complianceSignoffToDraft(
  signoff: ComplianceSignoffResponse | null,
): ComplianceSignoffDraft {
  return {
    status: signoff?.status ?? ('DRAFT' as ComplianceSignoffStatus),
    boardMeetingDate: toDateInput(signoff?.boardMeetingDate),
    minuteReference: signoff?.minuteReference ?? '',
    approvedByName: signoff?.approvedByName ?? '',
    approvedByRole: signoff?.approvedByRole ?? '',
    approvalNotes: signoff?.approvalNotes ?? '',
  };
}

export function isComplianceSignoffDirty(
  signoff: ComplianceSignoffResponse | null,
  draft: ComplianceSignoffDraft,
): boolean {
  if (!signoff) return false;
  const persisted = complianceSignoffToDraft(signoff);
  return (Object.keys(persisted) as Array<keyof ComplianceSignoffDraft>).some(
    (key) => persisted[key] !== draft[key],
  );
}

export function persistedApprovalPresentation(
  signoff: ComplianceSignoffResponse | null,
  readiness: ComplianceApprovalReadinessResponse | null,
): PersistedApprovalPresentation {
  if (!signoff) {
    return { label: 'Draft', tone: 'default', approvalCurrent: false };
  }

  const approvalCurrent = Boolean(
    signoff.status === 'APPROVED' &&
    signoff.approvalCurrent &&
    signoff.currentApproval &&
    readiness?.evidenceHash &&
    signoff.currentApproval.evidenceHash === readiness.evidenceHash,
  );
  if (approvalCurrent) {
    return { label: 'Approved by board', tone: 'success', approvalCurrent: true };
  }

  if (signoff.status === 'APPROVED' && !readiness) {
    return { label: 'Approval verification unavailable', tone: 'warning', approvalCurrent: false };
  }

  if (signoff.latestApproval) {
    return { label: 'Reapproval required', tone: 'warning', approvalCurrent: false };
  }

  if (signoff.status === 'BOARD_REVIEW') {
    return { label: 'Ready for board review', tone: 'warning', approvalCurrent: false };
  }

  if (signoff.status === 'APPROVED') {
    return { label: 'Approval verification unavailable', tone: 'warning', approvalCurrent: false };
  }

  return { label: 'Draft', tone: 'default', approvalCurrent: false };
}
