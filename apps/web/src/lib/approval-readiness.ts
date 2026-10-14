import type { ComplianceApprovalReadinessResponse } from '@charitypilot/shared';

export type ApprovalReadiness = ComplianceApprovalReadinessResponse;

export function countApprovalReadinessBlockers(readiness: ApprovalReadiness | null | undefined) {
  if (!readiness) return 0;
  return (
    readiness.missingRecords.length +
    readiness.missingEvidence.length +
    readiness.missingExplanations.length +
    readiness.profileIssues.length
  );
}

export function approvalReadinessBlockerCodes(readiness: ApprovalReadiness | null | undefined) {
  if (!readiness) return [];
  return [
    ...readiness.missingRecords.map((item) => item.standardCode),
    ...readiness.missingEvidence.map((item) => item.standardCode),
    ...readiness.missingExplanations.map((item) => item.standardCode),
  ];
}

export function approvalReadinessSummary(readiness: ApprovalReadiness | null | undefined) {
  const blockerCount = countApprovalReadinessBlockers(readiness);
  if (blockerCount === 0) {
    return 'No annual approval-readiness blockers are currently visible.';
  }

  const parts = [
    summaryPart(readiness?.missingRecords.length ?? 0, 'missing standard record', 'missing standard records'),
    summaryPart(readiness?.missingEvidence.length ?? 0, 'missing evidence field', 'missing evidence fields'),
    summaryPart(readiness?.missingExplanations.length ?? 0, 'missing explanation', 'missing explanations'),
    summaryPart(readiness?.profileIssues.length ?? 0, 'organisation profile check', 'organisation profile checks'),
  ].filter(Boolean);

  return `${blockerCount} approval-readiness blocker${blockerCount === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

export interface NarrativeWarningLine {
  key: string;
  standardCode: string;
  title: string;
  description: string;
}

function irishDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IE', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Standards whose narrative linked evidence or the calendar has overtaken.
 * Warnings only: they never count as blockers and never stop a sign-off.
 * Tolerates an older API that does not send them.
 */
export function narrativeWarningLines(readiness: ApprovalReadiness | null | undefined): NarrativeWarningLine[] {
  return (readiness?.narrativeWarnings ?? []).map((warning) => warning.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE'
    ? {
        key: `linked-${warning.standardId}-${warning.documentId}`,
        standardCode: warning.standardCode,
        title: 'Evidence linked after the narrative was written',
        description: `A current document was linked on ${irishDate(warning.linkedAt)}, after the actions taken and evidence were last edited on ${irishDate(warning.recordUpdatedAt)}. Reread the text before approving.`,
      }
    : {
        key: `target-${warning.standardId}-${warning.targetDate}`,
        standardCode: warning.standardCode,
        title: 'Target date has passed',
        description: `The actions taken give a target of ${irishDate(warning.targetDate)}, which has passed. Update the text to say what happened.`,
      });
}

function summaryPart(count: number, singular: string, plural: string) {
  if (count === 0) return '';
  return `${count} ${count === 1 ? singular : plural}`;
}
