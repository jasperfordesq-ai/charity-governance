export type CopyAuthority = { id: string; area: string; scopeRef: string; revision: number;
  state: 'AUTHORIZED' | 'WITHDRAWN'; disposition: string | null; holdRevision: number;
  validUntil: string | null; evidenceRef: string; reason: string; occurredAt: string; policyId: string | null };
export type CopyPolicy = { id: string; revision: number; state: string; withdrawal: unknown;
  retentionMode: string; retentionDays: number | null };

export function latestCopyAuthority(rows: CopyAuthority[], area: string, scopeRef: string) {
  return rows.filter(row => row.area === area && row.scopeRef === scopeRef)
    .reduce<CopyAuthority | null>((latest, row) => !latest || row.revision > latest.revision ? row : latest, null);
}
export function currentCopyPolicy(rows: CopyPolicy[]) {
  const approved = rows.filter(row => row.state === 'APPROVED' && !row.withdrawal);
  return approved.length === 1 ? approved[0] : null;
}
