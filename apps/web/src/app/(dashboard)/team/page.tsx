'use client';

import { logClientError } from '@/lib/client-logger';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { canInviteMembers } from '@/lib/team-permissions';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage } from '@/components/ui/app-page';
import { InlineStatus } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import type { TeamResponse, TeamMemberResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';
import { ROLE_META } from './team-display';
import { TeamInvitesPanel } from './team-invites-panel';
import { TeamMembersPanel } from './team-members-panel';

export default function TeamPage() {
  useDocumentTitle('Team');
  const { user } = useAuth();
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole.ADMIN | UserRole.MEMBER>(UserRole.MEMBER);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revokeInviteId, setRevokeInviteId] = useState<string | null>(null);
  const [roleUpdateMemberId, setRoleUpdateMemberId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canInvite = canInviteMembers(user?.role);
  const allowedInviteRoles = useMemo<Array<UserRole.ADMIN | UserRole.MEMBER>>(() => {
    if (user?.role === UserRole.OWNER) return [UserRole.MEMBER, UserRole.ADMIN];
    if (canInvite) return [UserRole.MEMBER];
    return [];
  }, [canInvite, user?.role]);
  const canInviteAdmin = allowedInviteRoles.includes(UserRole.ADMIN);
  const permissionDisabledReason = canInvite
    ? ''
    : 'Your role can view this team, but only owners and admins can send or revoke invites.';
  const inviteRoleHint = canInviteAdmin
    ? 'Owners may invite Admins or Members. Use Admin for people helping run compliance.'
    : canInvite
      ? 'Admins can invite Members only. Ask an owner if this person needs Admin access.'
      : permissionDisabledReason;

  const activeInviteCount = useMemo(
    () =>
      team?.invites.filter(
        (invite) => !invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt) >= new Date(),
      ).length ?? 0,
    [team],
  );

  const fetchTeam = useCallback(async () => {
    try {
      const { data } = await api.get<TeamResponse>('/team');
      setTeam(data);
      setError(null);
    } catch (err) {
      logClientError('Failed to load team', err);
      setError('Team settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  useEffect(() => {
    if (!allowedInviteRoles.includes(role)) {
      setRole(UserRole.MEMBER);
    }
  }, [allowedInviteRoles, role]);

  const inviteDisabledReason = useMemo(() => {
    if (permissionDisabledReason) return permissionDisabledReason;
    if (!allowedInviteRoles.includes(role)) return 'Choose an invite role available to your account.';
    if (!email.trim()) return 'Add an email address before sending an invite.';
    return '';
  }, [allowedInviteRoles, email, permissionDisabledReason, role]);

  const inviteMember = async (event: FormEvent) => {
    event.preventDefault();
    if (inviteDisabledReason) {
      setError(inviteDisabledReason);
      setMessage(null);
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      await api.post('/team/invites', { email, role });
      setEmail('');
      setRole(UserRole.MEMBER);
      setMessage('Invite sent. CharityPilot will record whether the email was delivered when reminders are configured.');
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Invite could not be sent.'));
    } finally {
      setSaving(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    setError(null);
    setMessage(null);
    setRevokeInviteId(inviteId);
    try {
      await api.delete(`/team/invites/${inviteId}`);
      setMessage('Invite revoked.');
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Invite could not be revoked.'));
    } finally {
      setRevokeInviteId(null);
    }
  };

  const updateRole = async (member: TeamMemberResponse, nextRole: UserRole) => {
    setError(null);
    setMessage(null);
    setRoleUpdateMemberId(member.id);
    try {
      await api.patch(`/team/members/${member.id}/role`, { role: nextRole });
      setMessage(`${member.name}'s role was updated.`);
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Role could not be updated.'));
    } finally {
      setRoleUpdateMemberId(null);
    }
  };

  return (
    <AppPage
      eyebrow="Team permissions"
      title="Team & Permissions"
      description="Invite trustees, staff, and governance administrators with clear access levels for this charity workspace."
      actions={(
        <>
          <StatusChip tone="brand">{team?.members.length ?? 0} members</StatusChip>
          <StatusChip tone={activeInviteCount > 0 ? 'warning' : 'neutral'}>{activeInviteCount} pending invites</StatusChip>
        </>
      )}
    >
      <div aria-live="polite" role={error ? 'alert' : 'status'} className="sr-only">
        {error ?? message ?? 'Team permissions ready'}
      </div>

      {(message || error) ? (
        <InlineStatus tone={error ? 'danger' : 'success'}>
          {error ?? message}
        </InlineStatus>
      ) : null}

      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">Role guidance</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Keep invite authority separate from owner-only role control.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Owners can manage billing and role changes. Admins can invite collaborators and help run governance workflows. Members can maintain records without team administration rights.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3 lg:min-w-[34rem]">
            {Object.values(UserRole).map((item) => (
              <div key={item} className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
                <StatusChip tone={ROLE_META[item].tone}>{ROLE_META[item].label}</StatusChip>
                <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{ROLE_META[item].description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <TeamMembersPanel
          error={error}
          loading={loading}
          onRetry={fetchTeam}
          onUpdateRole={updateRole}
          roleUpdateMemberId={roleUpdateMemberId}
          team={team}
          user={user}
        />

        <TeamInvitesPanel
          allowedInviteRoles={allowedInviteRoles}
          canInvite={canInvite}
          canInviteAdmin={canInviteAdmin}
          email={email}
          inviteDisabledReason={inviteDisabledReason}
          inviteMember={inviteMember}
          inviteRoleHint={inviteRoleHint}
          permissionDisabledReason={permissionDisabledReason}
          revokeInvite={revokeInvite}
          revokeInviteId={revokeInviteId}
          role={role}
          saving={saving}
          setEmail={setEmail}
          setRole={setRole}
          team={team}
        />
      </div>
    </AppPage>
  );
}
