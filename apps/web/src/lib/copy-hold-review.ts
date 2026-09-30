type Hold = { area: string; scopeRef: string; revision: number; held: boolean };

/** An incomplete page cannot establish the absence of a hold for a scope. */
export function currentCopyHold(rows: Hold[] | null, cursor: string | null, area: string, scopeRef: string) {
  if (rows === null || cursor !== null) return null;
  const latest = rows.filter(row => row.area === area && row.scopeRef === scopeRef)
    .reduce<Hold | null>((current, row) => !current || row.revision > current.revision ? row : current, null);
  return { revision: latest?.revision ?? 0, held: latest?.held ?? false };
}
