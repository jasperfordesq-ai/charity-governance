import type { TeamInviteResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';

type RoleTone = 'success' | 'brand' | 'neutral';

export const ROLE_META: Record<UserRole, { label: string; description: string; tone: RoleTone }> = {
  [UserRole.OWNER]: {
    label: 'Owner',
    description: 'Full account control, billing, team administration, and owner-only role changes.',
    tone: 'success',
  },
  [UserRole.ADMIN]: {
    label: 'Admin',
    description: 'Can invite people and manage governance work, but cannot change member roles or billing.',
    tone: 'brand',
  },
  [UserRole.MEMBER]: {
    label: 'Member',
    description: 'Can maintain compliance records, documents, registers, and deadlines.',
    tone: 'neutral',
  },
};

export function inviteStatus(invite: TeamInviteResponse) {
  if (invite.acceptedAt) return { label: 'Accepted', tone: 'success' as const };
  if (invite.revokedAt) return { label: 'Revoked', tone: 'neutral' as const };
  if (new Date(invite.expiresAt) < new Date()) return { label: 'Expired', tone: 'danger' as const };
  return { label: 'Pending', tone: 'warning' as const };
}

export function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
