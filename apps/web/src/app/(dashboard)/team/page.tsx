'use client';

import { logClientError } from '@/lib/client-logger';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, SelectItem } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { canInviteMembers, canEditMemberRole } from '@/lib/team-permissions';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClasses } from '@/components/ui/action-button';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { FieldGroup, FormHint } from '@/components/ui/forms';
import { EmptyState, ErrorState, InlineStatus, LoadingState } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import type { TeamResponse, TeamInviteResponse, TeamMemberResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';

type RoleTone = 'success' | 'brand' | 'neutral';

const ROLE_META: Record<UserRole, { label: string; description: string; tone: RoleTone }> = {
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

function inviteStatus(invite: TeamInviteResponse) {
  if (invite.acceptedAt) return { label: 'Accepted', tone: 'success' as const };
  if (invite.revokedAt) return { label: 'Revoked', tone: 'neutral' as const };
  if (new Date(invite.expiresAt) < new Date()) return { label: 'Expired', tone: 'danger' as const };
  return { label: 'Pending', tone: 'warning' as const };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

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

  const roleEditDisabledReason = (member: TeamMemberResponse) => {
    if (member.role === UserRole.OWNER) return 'Owner role changes are protected.';
    if (member.id === user?.id) return 'You cannot change your own role.';
    if (!canEditMemberRole(user?.role, user?.id, member)) return 'Only owners can change member roles.';
    return '';
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
        <DataList
          title="Members"
          description="Owners are protected from in-page demotion. Role changes mirror the API role guard and remain owner-only."
        >
          {loading ? (
            <LoadingState title="Loading team" description="Checking members and pending invites." />
          ) : error && !team ? (
            <ErrorState
              title="Team settings could not be loaded"
              description={error}
              action={(
                <Button size="sm" variant="flat" onPress={fetchTeam}>
                  Try again
                </Button>
              )}
            />
          ) : !team?.members.length ? (
            <EmptyState
              title="No members found"
              description="The organisation owner should appear here once the team endpoint returns member data."
            />
          ) : (
            <DataListItems>
              {team.members.map((member) => {
                const roleDisabledReason = roleEditDisabledReason(member);
                return (
                  <article key={member.id} className="p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{member.name}</h3>
                          <StatusChip tone={ROLE_META[member.role].tone}>{ROLE_META[member.role].label}</StatusChip>
                          {!member.emailVerified ? <ReviewFlag tone="needs-review">Email not verified</ReviewFlag> : null}
                        </div>
                        <p className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{member.email}</p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Joined {formatDate(member.createdAt)}</p>
                        <p className="mt-2 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
                          {ROLE_META[member.role].description}
                        </p>
                      </div>

                      {canEditMemberRole(user?.role, user?.id, member) ? (
                        <Select
                          aria-label={`Role for ${member.name}`}
                          size="sm"
                          className="w-full sm:w-44"
                          selectedKeys={new Set([member.role])}
                          isDisabled={Boolean(roleUpdateMemberId)}
                          onSelectionChange={(keys) => {
                            const next = Array.from(keys)[0] as UserRole | undefined;
                            if (next && next !== member.role) updateRole(member, next);
                          }}
                        >
                          <SelectItem key={UserRole.ADMIN}>Admin</SelectItem>
                          <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                        </Select>
                      ) : (
                        <div className="max-w-xs rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                          {roleDisabledReason}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </DataListItems>
          )}
        </DataList>

        <div className="space-y-5">
          <form
            className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            onSubmit={inviteMember}
          >
            <FieldGroup
              title="Invite someone"
              description={inviteRoleHint}
            >
              <Input
                label="Email"
                type="email"
                value={email}
                onValueChange={setEmail}
                isRequired
                isDisabled={!canInvite}
              />
              <Select
                label="Role"
                selectedKeys={new Set([role])}
                isDisabled={!canInvite}
                onSelectionChange={(keys) => {
                  const next = Array.from(keys)[0] as UserRole.ADMIN | UserRole.MEMBER | undefined;
                  if (next && allowedInviteRoles.includes(next)) setRole(next);
                }}
              >
                <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                <SelectItem key={UserRole.ADMIN} isDisabled={!canInviteAdmin}>Admin</SelectItem>
              </Select>
              <FormHint id="team-invite-disabled-hint" tone={inviteDisabledReason ? 'warning' : 'neutral'}>
                {inviteDisabledReason || 'The invite will be created with a pending status until accepted, revoked, or expired.'}
              </FormHint>
              <Button
                type="submit"
                className={primaryActionButtonClasses('w-full')}
                isLoading={saving}
                isDisabled={!canInvite || Boolean(inviteDisabledReason) || saving}
                aria-describedby="team-invite-disabled-hint"
              >
                Send invite
              </Button>
            </FieldGroup>
          </form>

          <AppSection title="Pending invites" description="Pending invites can be revoked by owners or admins until accepted or expired.">
            {!team?.invites.length ? (
              <EmptyState
                title="No team invites yet"
                description="Invite records will appear here with pending, accepted, revoked, or expired status."
              />
            ) : (
              <DataListItems divided={false}>
                <div className="space-y-3 p-3">
                  {team.invites.map((invite) => {
                    const status = inviteStatus(invite);
                    const active = status.label === 'Pending';
                    return (
                      <article key={invite.id} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{invite.email}</p>
                            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                              {ROLE_META[invite.role].label} invited by {invite.invitedByName ?? 'CharityPilot'}
                            </p>
                          </div>
                          <StatusChip tone={status.tone}>{status.label}</StatusChip>
                        </div>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs text-gray-500 dark:text-gray-400">Expires {formatDate(invite.expiresAt)}</p>
                          {active && canInvite ? (
                            <Button
                              size="sm"
                              variant="flat"
                              color="danger"
                              onPress={() => revokeInvite(invite.id)}
                              isLoading={revokeInviteId === invite.id}
                              isDisabled={Boolean(revokeInviteId) || saving}
                            >
                              Revoke
                            </Button>
                          ) : active ? (
                            <p className="text-xs text-gray-500 dark:text-gray-400">{permissionDisabledReason}</p>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </DataListItems>
            )}
          </AppSection>
        </div>
      </div>
    </AppPage>
  );
}
