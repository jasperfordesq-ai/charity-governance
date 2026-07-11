import type { TeamMemberResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';

export type GovernanceAction =
  | { kind: 'role'; member: TeamMemberResponse; nextRole: UserRole.ADMIN | UserRole.MEMBER }
  | { kind: 'suspend' | 'reactivate' | 'remove' | 'transfer'; member: TeamMemberResponse }
  | { kind: 'revoke-invite'; inviteId: string; inviteEmail: string };

export function apiErrorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === 'string' ? code : null;
}

export function actionContent(action: GovernanceAction | null) {
  if (!action) return { title: '', description: '', label: '', color: 'danger' as const };
  if (action.kind === 'role') {
    return {
      title: `Change ${action.member.name}'s role`,
      description: `Change the role from ${action.member.role} to ${action.nextRole}. The reason will be retained in the security audit.`,
      label: 'Change role',
      color: 'warning' as const,
    };
  }
  if (action.kind === 'revoke-invite') {
    return {
      title: 'Revoke invitation',
      description: `Revoke the pending invitation for ${action.inviteEmail}. The invite link will stop working immediately.`,
      label: 'Revoke invite',
      color: 'danger' as const,
    };
  }
  const copy = {
    suspend: {
      title: `Suspend ${action.member.name}`,
      description: 'Suspension immediately revokes active sessions and stops reserved reminders. The membership can be reactivated later if capacity is available.',
      label: 'Suspend member',
      color: 'warning' as const,
    },
    reactivate: {
      title: `Reactivate ${action.member.name}`,
      description: 'Reactivation restores membership access but never restores old sessions. The member must sign in again.',
      label: 'Reactivate member',
      color: 'primary' as const,
    },
    remove: {
      title: `Remove ${action.member.name}`,
      description: 'Removal is permanent. Sessions and pending reminders are revoked while governance history is retained.',
      label: 'Remove member',
      color: 'danger' as const,
    },
    transfer: {
      title: `Transfer ownership to ${action.member.name}`,
      description: 'This changes the only accountable owner, revokes both people\'s sessions, and signs you out. Billing authority moves to the new owner.',
      label: 'Transfer ownership',
      color: 'danger' as const,
    },
  };
  return copy[action.kind];
}

export function replaceWithLoginAfterServerRevocation(router: { replace: (href: string) => void }) {
  router.replace('/login');
  if (typeof window !== 'undefined') window.location.replace('/login');
}
