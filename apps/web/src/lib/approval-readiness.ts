import { groupNarrativeWarnings, narrativeWarningDate, type ComplianceApprovalReadinessResponse } from '@charitypilot/shared';

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
  /** The shared board-facing sentence, identical to the report header's. */
  message: string;
  description: string;
}

/**
 * Standards whose narrative linked evidence or the calendar has overtaken,
 * one line per standard and kind, grouped by the same shared function as the
 * report header. Warnings only: they never count as blockers and never stop
 * a sign-off. Tolerates an older API that does not send them.
 */
export function narrativeWarningLines(readiness: ApprovalReadiness | null | undefined): NarrativeWarningLine[] {
  return groupNarrativeWarnings(readiness?.narrativeWarnings).map((group) => ({
    key: group.key,
    standardCode: group.standardCode,
    message: group.message,
    description: group.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE'
      ? `Record last edited ${narrativeWarningDate(group.recordUpdatedAt)}. Reread the text against the linked evidence before approving.`
      : `Record last edited ${narrativeWarningDate(group.recordUpdatedAt)}. Update the text to say what happened.`,
  }));
}

function summaryPart(count: number, singular: string, plural: string) {
  if (count === 0) return '';
  return `${count} ${count === 1 ? singular : plural}`;
}
