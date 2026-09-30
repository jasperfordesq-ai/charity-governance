type ClaimRevision = {
  state: 'VERIFIED' | 'WITHDRAWN';
  riskRevision?: number | null;
};

type OrderedClaim = { id: string; controlReference: string; state: 'VERIFIED' | 'WITHDRAWN' };

// The API returns claims newest first. Only the latest event for a control
// describes its current recorded state; older verifications remain history.
export function activeVerifiedClaimIds(newestFirst: OrderedClaim[]): Set<string> {
  const seen = new Set<string>();
  const active = new Set<string>();
  for (const claim of newestFirst) {
    if (seen.has(claim.controlReference)) continue;
    seen.add(claim.controlReference);
    if (claim.state === 'VERIFIED') active.add(claim.id);
  }
  return active;
}

// A risk edit prompts reassessment; it does not invalidate the underlying
// evidence or say whether a control passed on the new revision.
export function riskClaimRevisionCue(claim: ClaimRevision, currentRiskRevision: number | null): string | null {
  if (claim.state !== 'VERIFIED' || currentRiskRevision === null) return null;
  if (claim.riskRevision === null || claim.riskRevision === undefined) return 'This older claim has no captured risk revision. Review it against the current record.';
  if (!Number.isSafeInteger(currentRiskRevision) || !Number.isSafeInteger(claim.riskRevision) ||
    currentRiskRevision < 1 || claim.riskRevision < 1) {
    return 'The risk revision could not be compared. Review this claim against the current record.';
  }
  return currentRiskRevision > claim.riskRevision
    ? 'The risk record changed after this claim. Review whether its evidence still applies.'
    : null;
}
