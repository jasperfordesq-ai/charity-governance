'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, Input, Select, SelectItem } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { useDocumentTitle } from '@/lib/use-title';
import type { TeamResponse, TeamInviteResponse, TeamMemberResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';

const ROLE_META: Record<UserRole, { label: string; description: string; color: 'success' | 'primary' | 'default' }> = {
  [UserRole.OWNER]: {
    label: 'Owner',
    description: 'Full account control, billing, and team administration.',
    color: 'success',
  },
  [UserRole.ADMIN]: {
    label: 'Admin',
    description: 'Can manage governance records and invite team members.',
    color: 'primary',
  },
  [UserRole.MEMBER]: {
    label: 'Member',
    description: 'Can maintain compliance records, documents, registers, and deadlines.',
    color: 'default',
  },
};

function inviteStatus(invite: TeamInviteResponse) {
  if (invite.acceptedAt) return { label: 'Accepted', color: 'success' as const };
  if (invite.revokedAt) return { label: 'Revoked', color: 'default' as const };
  if (new Date(invite.expiresAt) < new Date()) return { label: 'Expired', color: 'danger' as const };
  return { label: 'Pending', color: 'warning' as const };
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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canInvite = user?.role === UserRole.OWNER || user?.role === UserRole.ADMIN;
  const canChangeRoles = user?.role === UserRole.OWNER;

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
      console.error('Failed to load team', err);
      setError('Team settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  const inviteMember = async (event: FormEvent) => {
    event.preventDefault();
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
    try {
      await api.delete(`/team/invites/${inviteId}`);
      setMessage('Invite revoked.');
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Invite could not be revoked.'));
    }
  };

  const updateRole = async (member: TeamMemberResponse, nextRole: UserRole) => {
    setError(null);
    setMessage(null);
    try {
      await api.patch(`/team/members/${member.id}/role`, { role: nextRole });
      setMessage(`${member.name}'s role was updated.`);
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Role could not be updated.'));
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team & Permissions</h1>
          <p className="text-sm text-gray-500 mt-1">
            Invite trustees, staff, and governance administrators with scoped access to this charity workspace.
          </p>
        </div>
        <div className="flex gap-2">
          <Chip variant="flat" color="primary">{team?.members.length ?? 0} members</Chip>
          <Chip variant="flat" color="warning">{activeInviteCount} pending invites</Chip>
        </div>
      </div>

      {(message || error) && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {error ?? message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="border border-gray-200 shadow-sm p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Members</h2>
              <p className="text-sm text-gray-500">Owners control billing and roles. Admins can invite and manage governance work.</p>
            </div>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((item) => (
                <div key={item} className="h-16 rounded-lg bg-gray-100 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {team?.members.map((member) => (
                <div key={member.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-gray-900">{member.name}</p>
                      <Chip size="sm" color={ROLE_META[member.role].color} variant="flat">
                        {ROLE_META[member.role].label}
                      </Chip>
                      {!member.emailVerified && (
                        <Chip size="sm" color="warning" variant="flat">Email not verified</Chip>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{member.email}</p>
                    <p className="text-xs text-gray-400 mt-1">Joined {formatDate(member.createdAt)}</p>
                  </div>

                  {canChangeRoles && member.role !== UserRole.OWNER && member.id !== user?.id ? (
                    <Select
                      aria-label={`Role for ${member.name}`}
                      size="sm"
                      className="w-40"
                      selectedKeys={new Set([member.role])}
                      onSelectionChange={(keys) => {
                        const next = Array.from(keys)[0] as UserRole | undefined;
                        if (next && next !== member.role) updateRole(member, next);
                      }}
                    >
                      <SelectItem key={UserRole.ADMIN}>Admin</SelectItem>
                      <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                    </Select>
                  ) : (
                    <p className="text-xs text-gray-400 sm:text-right max-w-[220px]">
                      {ROLE_META[member.role].description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="border border-gray-200 shadow-sm p-5">
            <h2 className="text-lg font-semibold text-gray-900">Invite Someone</h2>
            <p className="text-sm text-gray-500 mt-1">
              Use admin for people who help run compliance. Use member for evidence and register maintenance.
            </p>

            <form className="mt-5 space-y-4" onSubmit={inviteMember}>
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
                  if (next) setRole(next);
                }}
              >
                <SelectItem key={UserRole.MEMBER}>Member</SelectItem>
                <SelectItem key={UserRole.ADMIN}>Admin</SelectItem>
              </Select>
              <Button
                type="submit"
                className="w-full bg-teal-primary text-white"
                isLoading={saving}
                isDisabled={!canInvite}
              >
                Send Invite
              </Button>
              {!canInvite && (
                <p className="text-xs text-gray-500">
                  Your role can view the team list, but only owners and admins can invite people.
                </p>
              )}
            </form>
          </Card>

          <Card className="border border-gray-200 shadow-sm p-5">
            <h2 className="text-lg font-semibold text-gray-900">Pending Invites</h2>
            <div className="mt-4 space-y-3">
              {team?.invites.length ? (
                team.invites.map((invite) => {
                  const status = inviteStatus(invite);
                  const active = status.label === 'Pending';
                  return (
                    <div key={invite.id} className="rounded-lg border border-gray-100 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-gray-900">{invite.email}</p>
                          <p className="text-xs text-gray-500">
                            {ROLE_META[invite.role].label} invited by {invite.invitedByName ?? 'CharityPilot'}
                          </p>
                        </div>
                        <Chip size="sm" color={status.color} variant="flat">{status.label}</Chip>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-gray-400">Expires {formatDate(invite.expiresAt)}</p>
                        {active && canInvite && (
                          <Button size="sm" variant="light" color="danger" onPress={() => revokeInvite(invite.id)}>
                            Revoke
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-gray-500">No team invites have been sent yet.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
