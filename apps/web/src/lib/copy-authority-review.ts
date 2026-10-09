export type CopyAuthority = { id: string; area: string; scopeRef: string; revision: number;
  state: 'AUTHORIZED' | 'WITHDRAWN'; disposition: string | null; holdRevision: number;
  validUntil: string | null; evidenceRef: string; reason: string; occurredAt: string; policyId: string | null };
export type CopyPolicy = { id: string; revision: number; state: string; withdrawal: unknown;
  retentionMode: string; retentionAnchor: string | null; retentionDays: number | null;
  retentionYears: number | null };

export function copyPolicyNeedsAnchor(policy: CopyPolicy) {
  return policy.retentionMode === 'AFTER_ANCHOR' || policy.retentionMode === 'AFTER_CALENDAR_YEARS';
}

export function copyPolicyTermsValid(policy: CopyPolicy) {
  if (policy.retentionMode === 'REVIEW_REQUIRED' || policy.retentionMode === 'PERMANENT')
    return policy.retentionAnchor === null && policy.retentionDays === null && policy.retentionYears === null;
  if (policy.retentionAnchor !== 'CREATED_AT') return false;
  if (policy.retentionMode === 'AFTER_ANCHOR')
    return Number.isInteger(policy.retentionDays) && policy.retentionDays! >= 1 && policy.retentionDays! <= 36525
      && policy.retentionYears === null;
  if (policy.retentionMode === 'AFTER_CALENDAR_YEARS')
    return Number.isInteger(policy.retentionYears) && policy.retentionYears! >= 1 && policy.retentionYears! <= 100
      && policy.retentionDays === null;
  return false;
}

export function copyPolicyDescription(policy: CopyPolicy) {
  if (!copyPolicyTermsValid(policy)) return 'Policy terms need review';
  if (policy.retentionMode === 'AFTER_ANCHOR') return `${policy.retentionDays} days from copy creation`;
  if (policy.retentionMode === 'AFTER_CALENDAR_YEARS') return `${policy.retentionYears} calendar years from copy creation`;
  return policy.retentionMode === 'PERMANENT' ? 'permanent retention' : 'individual disposition review';
}

export function latestCopyAuthority(rows: CopyAuthority[], area: string, scopeRef: string) {
  return rows.filter(row => row.area === area && row.scopeRef === scopeRef)
    .reduce<CopyAuthority | null>((latest, row) => !latest || row.revision > latest.revision ? row : latest, null);
}
export function currentCopyPolicy(rows: CopyPolicy[]) {
  const approved = rows.filter(row => row.state === 'APPROVED' && !row.withdrawal);
  return approved.length === 1 ? approved[0] : null;
}
