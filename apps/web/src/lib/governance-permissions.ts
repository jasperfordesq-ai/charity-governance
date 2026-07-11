// Browser affordance boundary for ordinary governance work. The API remains the
// authoritative enforcement layer; this pure predicate keeps every dashboard
// surface aligned with its OWNER/ADMIN requireAdmin guards.
export function canManageGovernance(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
