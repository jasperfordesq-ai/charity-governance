// Authorization predicates for the Team page, extracted so the UI authorization
// boundary is falsifiable in isolation. These mirror the API's role guards
// (OWNER / ADMIN / MEMBER): the UI hides or disables what a role cannot do, and the
// API independently enforces the same rule (defense in depth — prove BOTH).
//
// Roles are compared as plain strings (the values of the shared UserRole enum) so this
// module has no runtime dependency and stays unit-testable in the node:test harness.

export function canInviteMembers(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canManageMemberRoles(role: string | null | undefined): boolean {
  return role === 'OWNER';
}

/**
 * Whether the current actor may change a specific member's role. Only an OWNER can; an
 * OWNER row can never be demoted via this control, and a user can never change their own
 * role (no self-lockout / self-escalation).
 */
export function canEditMemberRole(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  member: { role: string; id: string },
): boolean {
  return canManageMemberRoles(actorRole) && member.role !== 'OWNER' && member.id !== actorId;
}
