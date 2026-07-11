// Authorization predicates for the Team page, extracted so the UI authorization
// boundary is falsifiable in isolation. These mirror the API's role guards
// (OWNER / ADMIN / MEMBER): the UI hides or disables what a role cannot do, and the
// API independently enforces the same rule (defense in depth — prove BOTH).
//
// Roles are compared as plain strings (the values of the shared UserRole enum) so this
// module has no runtime dependency and stays unit-testable in the node:test harness.

function isKnownRole(role: string | null | undefined): role is 'OWNER' | 'ADMIN' | 'MEMBER' {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
}

type TeamAccessMember = {
  id: string;
  role: string;
  lifecycleStatus: string;
  membershipVersion: number;
  emailVerified?: boolean;
};

type TeamAccessInvite = {
  id: string;
  email: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
};

type GovernanceActionSnapshot =
  | { kind: 'role'; member: TeamAccessMember; nextRole: 'ADMIN' | 'MEMBER' }
  | { kind: 'suspend' | 'reactivate' | 'remove' | 'transfer'; member: TeamAccessMember }
  | { kind: 'revoke-invite'; inviteId: string; inviteEmail: string };

export function resolveCanonicalTeamRole<T extends string>(
  actorId: string | null | undefined,
  members: ReadonlyArray<{ id: string; role: T; lifecycleStatus: string }> | null | undefined,
): (T & ('OWNER' | 'ADMIN' | 'MEMBER')) | null {
  if (!actorId || !members) return null;
  const membership = members.find((member) => member.id === actorId);
  if (!membership || membership.lifecycleStatus !== 'ACTIVE' || !isKnownRole(membership.role)) {
    return null;
  }
  return membership.role;
}

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

export function canManageMemberLifecycle(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  member: { role: string; id: string },
): boolean {
  if (!actorId || member.id === actorId || member.role === 'OWNER') return false;
  if (actorRole === 'OWNER') return true;
  return actorRole === 'ADMIN' && member.role === 'MEMBER';
}

export function canManageMemberSessions(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  member: { role: string; id: string },
): boolean {
  if (!actorId || !isKnownRole(actorRole)) return false;
  if (member.id === actorId) return true;
  if (actorRole === 'OWNER') return member.role !== 'OWNER';
  return actorRole === 'ADMIN' && member.role === 'MEMBER';
}

export function canTransferOwnership(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  member: { role: string; id: string; lifecycleStatus?: string; emailVerified?: boolean },
): boolean {
  return (
    actorRole === 'OWNER' &&
    Boolean(actorId) &&
    member.id !== actorId &&
    member.role !== 'OWNER' &&
    member.lifecycleStatus === 'ACTIVE' &&
    member.emailVerified === true
  );
}

/**
 * Revalidates a modal's member snapshot against the latest canonical Team payload.
 * A role/lifecycle/version change, target removal, or unavailable Team payload must
 * invalidate the action before the browser can submit it.
 */
export function isCurrentGovernanceActionAuthorized(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  action: GovernanceActionSnapshot | null,
  members: ReadonlyArray<TeamAccessMember> | null | undefined,
  invites: ReadonlyArray<TeamAccessInvite> | null | undefined,
  now = Date.now(),
): boolean {
  if (!action || !members || !invites) return false;
  if (action.kind === 'revoke-invite') {
    const invite = invites.find((candidate) => candidate.id === action.inviteId);
    return Boolean(
      canInviteMembers(actorRole) &&
      invite &&
      invite.email === action.inviteEmail &&
      !invite.acceptedAt &&
      !invite.revokedAt &&
      Date.parse(invite.expiresAt) >= now,
    );
  }

  const currentMember = members.find((member) => member.id === action.member.id);
  if (!currentMember || currentMember.membershipVersion !== action.member.membershipVersion) {
    return false;
  }
  if (action.kind === 'role') {
    return currentMember.lifecycleStatus === 'ACTIVE' &&
      currentMember.role !== action.nextRole &&
      canEditMemberRole(actorRole, actorId, currentMember);
  }
  if (action.kind === 'transfer') {
    return canTransferOwnership(actorRole, actorId, currentMember);
  }
  if (!canManageMemberLifecycle(actorRole, actorId, currentMember)) return false;
  if (action.kind === 'suspend') return currentMember.lifecycleStatus === 'ACTIVE';
  if (action.kind === 'reactivate') return currentMember.lifecycleStatus === 'SUSPENDED';
  return currentMember.lifecycleStatus !== 'REMOVED';
}

/** Revalidates the session modal target against the latest canonical membership. */
export function isCurrentSessionTargetAuthorized(
  actorRole: string | null | undefined,
  actorId: string | null | undefined,
  targetSnapshot: TeamAccessMember | null,
  members: ReadonlyArray<TeamAccessMember> | null | undefined,
): boolean {
  if (!targetSnapshot || !members) return false;
  const currentMember = members.find((member) => member.id === targetSnapshot.id);
  return Boolean(
    currentMember &&
    currentMember.membershipVersion === targetSnapshot.membershipVersion &&
    canManageMemberSessions(actorRole, actorId, currentMember),
  );
}
