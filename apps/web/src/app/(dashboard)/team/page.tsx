'use client';

import { logClientError } from '@/lib/client-logger';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { canInviteMembers, isCurrentGovernanceActionAuthorized, resolveCanonicalTeamRole } from '@/lib/team-permissions';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage } from '@/components/ui/app-page';
import { InlineStatus, SaveStatusIndicator } from '@/components/ui/states';
import { StatusChip } from '@/components/ui/status';
import type { SecurityAuditEventResponse, TeamResponse, TeamMemberResponse } from '@charitypilot/shared';
import { normalizeTeamGovernanceReason, UserRole } from '@charitypilot/shared';
import { TeamInvitesPanel } from './team-invites-panel';
import { TeamMembersPanel } from './team-members-panel';
import { TeamRoleGuidancePanel } from './team-role-guidance-panel';
import { TeamReasonModal } from './team-reason-modal';
import { TeamSessionsModal } from './team-sessions-modal';
import { TeamSecurityAuditPanel } from './team-security-audit-panel';
import { actionContent, apiErrorCode, replaceWithLoginAfterServerRevocation, type GovernanceAction } from './team-page-helpers';
import { useTeamSessions } from './use-team-sessions';

const IS_PERSONAL_SERVER = process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server';

export default function TeamPage() {
  useDocumentTitle('Team');
  const router = useRouter();
  const { user } = useAuth();
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole.ADMIN | UserRole.MEMBER>(UserRole.MEMBER);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revokeInviteId, setRevokeInviteId] = useState<string | null>(null);
  const [roleUpdateMemberId, setRoleUpdateMemberId] = useState<string | null>(null);
  const [governanceAction, setGovernanceAction] = useState<GovernanceAction | null>(null);
  const [governanceReason, setGovernanceReason] = useState('');
  const [governanceConfirmation, setGovernanceConfirmation] = useState('');
  const [governanceSaving, setGovernanceSaving] = useState(false);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const [securityEvents, setSecurityEvents] = useState<SecurityAuditEventResponse[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualInviteUrl, setManualInviteUrl] = useState<string | null>(null);
  const [teamUnavailable, setTeamUnavailable] = useState(false);
  const teamRequestId = useRef(0);
  const securityRequestId = useRef(0);
  const [governanceActorRole, setGovernanceActorRole] = useState<string | null>(null);

  // AuthContext can lag a database role change. Never authorize from
  // `user?.role === UserRole.OWNER || user?.role === UserRole.ADMIN`; the
  // freshly loaded membership below is the fail-closed UI authority.
  const effectiveRole = resolveCanonicalTeamRole(user?.id, team?.members);
  const permissionUser = user && effectiveRole ? { ...user, role: effectiveRole } : null;
  const canInvite = canInviteMembers(effectiveRole);
  const managementDisabled = loading || teamUnavailable || !team || !effectiveRole;
  const governanceAccessValid = !teamUnavailable &&
    governanceActorRole === effectiveRole &&
    isCurrentGovernanceActionAuthorized(
      effectiveRole,
      user?.id,
      governanceAction,
      team?.members,
      team?.invites,
    );
  const allowedInviteRoles = useMemo<Array<UserRole.ADMIN | UserRole.MEMBER>>(() => {
    if (effectiveRole === UserRole.OWNER) return [UserRole.MEMBER, UserRole.ADMIN];
    if (canInvite) return [UserRole.MEMBER];
    return [];
  }, [canInvite, effectiveRole]);
  const canInviteAdmin = allowedInviteRoles.includes(UserRole.ADMIN);
  const permissionDisabledReason = canInvite
    ? ''
    : 'Your role can view this team, but only owners and admins can send or revoke invites.';
  const inviteRoleHint = canInviteAdmin
    ? 'Owners may invite Admins or Members. Use Admin for people helping run compliance.'
    : canInvite
      ? 'Admins can invite Members only. Ask an owner if this person needs Admin access.'
      : permissionDisabledReason;

  const activeInviteCount = canInvite
    ? team?.invites.filter((invite) => !invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt) >= new Date()).length ?? 0
    : 0;
  const fetchTeam = useCallback(async (): Promise<boolean> => {
    const requestId = ++teamRequestId.current;
    setLoading(true);
    try {
      const { data } = await api.get<TeamResponse>('/team');
      if (requestId !== teamRequestId.current) return false;
      setTeam(data);
      setTeamUnavailable(false);
      setError(null);
      return true;
    } catch (err) {
      if (requestId !== teamRequestId.current) return false;
      logClientError('Failed to load team', err);
      setTeam(null);
      setTeamUnavailable(true);
      setError('Team settings could not be loaded.');
      return false;
    } finally {
      if (requestId === teamRequestId.current) setLoading(false);
    }
  }, []);

  const fetchSecurityAudit = useCallback(async () => {
    const requestId = ++securityRequestId.current;
    if (effectiveRole !== UserRole.OWNER && effectiveRole !== UserRole.ADMIN) {
      setSecurityEvents([]);
      setSecurityError(null);
      return;
    }
    setSecurityLoading(true);
    setSecurityError(null);
    try {
      const { data } = await api.get<SecurityAuditEventResponse[]>('/team/security-audit');
      if (requestId !== securityRequestId.current) return;
      setSecurityEvents(data);
    } catch (err) {
      if (requestId !== securityRequestId.current) return;
      logClientError('Failed to load team security audit', err);
      setSecurityError(apiErrorMessage(err, 'The security audit could not be loaded.'));
    } finally {
      if (requestId === securityRequestId.current) setSecurityLoading(false);
    }
  }, [effectiveRole]);

  useEffect(() => {
    void fetchTeam();
  }, [fetchTeam]);

  useEffect(() => {
    void fetchSecurityAudit();
  }, [fetchSecurityAudit]);

  useEffect(() => {
    if (!allowedInviteRoles.includes(role)) {
      setRole(UserRole.MEMBER);
    }
  }, [allowedInviteRoles, role]);

  useEffect(() => {
    if (!governanceAction || governanceAccessValid) return;
    setGovernanceActorRole(null);
    setGovernanceAction(null);
    setGovernanceReason('');
    setGovernanceConfirmation('');
    setGovernanceError(null);
    setError('Governance controls were closed because team permissions or the target membership changed.');
  }, [governanceAccessValid, governanceAction]);

  const inviteDisabledReason = useMemo(() => {
    if (permissionDisabledReason) return permissionDisabledReason;
    if (managementDisabled) {
      return loading ? 'Team details are refreshing.' : 'Reload team details before making changes.';
    }
    if (!allowedInviteRoles.includes(role)) return 'Choose an invite role available to your account.';
    if (!email.trim()) return 'Add an email address before sending an invite.';
    return '';
  }, [allowedInviteRoles, email, loading, managementDisabled, permissionDisabledReason, role]);

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
    setManualInviteUrl(null);

    try {
      const { data } = await api.post<{ accepted: boolean; manualInviteUrl?: string }>('/team/invites', { email, role });
      const inviteUrl = IS_PERSONAL_SERVER && typeof data.manualInviteUrl === 'string' ? data.manualInviteUrl : null;
      setManualInviteUrl(inviteUrl);
      setEmail('');
      setRole(UserRole.MEMBER);
      setMessage(inviteUrl
        ? 'Invitation created. Copy the private link below and send it through a trusted channel.'
        : IS_PERSONAL_SERVER
          ? 'No new invitation link was issued. Revoke an existing pending invite before creating a replacement.'
          : 'Invite sent. CharityPilot will record whether the email was delivered when reminders are configured.');
      await fetchTeam();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Invite could not be sent.'));
    } finally {
      setSaving(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    const invite = team?.invites.find((candidate) => candidate.id === inviteId);
    if (!invite) return;
    setGovernanceActorRole(effectiveRole);
    setGovernanceAction({ kind: 'revoke-invite', inviteId, inviteEmail: invite.email });
    setGovernanceReason('');
    setGovernanceError(null);
  };

  const updateRole = async (
    member: TeamMemberResponse,
    nextRole: UserRole.ADMIN | UserRole.MEMBER,
  ) => {
    setGovernanceActorRole(effectiveRole);
    setGovernanceAction({ kind: 'role', member, nextRole });
    setGovernanceReason('');
    setGovernanceError(null);
  };

  const openLifecycleAction = (member: TeamMemberResponse, action: 'suspend' | 'reactivate' | 'remove') => {
    setGovernanceActorRole(effectiveRole);
    setGovernanceAction({ kind: action, member });
    setGovernanceReason('');
    setGovernanceConfirmation('');
    setGovernanceError(null);
  };

  const openOwnershipTransfer = (member: TeamMemberResponse) => {
    setGovernanceActorRole(effectiveRole);
    setGovernanceAction({ kind: 'transfer', member });
    setGovernanceReason('');
    setGovernanceConfirmation('');
    setGovernanceError(null);
  };

  const closeGovernanceAction = () => {
    if (governanceSaving) return;
    setGovernanceActorRole(null);
    setGovernanceAction(null);
    setGovernanceReason('');
    setGovernanceConfirmation('');
    setGovernanceError(null);
  };

  const redirectAfterServerRevocation = () => replaceWithLoginAfterServerRevocation(router);

  const confirmGovernanceAction = async () => {
    if (!governanceAction || loading || !governanceAccessValid) {
      setGovernanceError('Reload current team permissions before completing this action.');
      return;
    }
    setGovernanceSaving(true);
    setGovernanceError(null);
    setMessage(null);
    setError(null);
    try {
      if (governanceAction.kind === 'revoke-invite') {
        setRevokeInviteId(governanceAction.inviteId);
        await api.delete(`/team/invites/${governanceAction.inviteId}`, {
          data: { reason: normalizeTeamGovernanceReason(governanceReason) },
        });
        setMessage('Invite revoked.');
      } else if (governanceAction.kind === 'role') {
        setRoleUpdateMemberId(governanceAction.member.id);
        await api.patch(`/team/members/${governanceAction.member.id}/role`, {
          role: governanceAction.nextRole,
          expectedMembershipVersion: governanceAction.member.membershipVersion,
          reason: normalizeTeamGovernanceReason(governanceReason),
        });
        setMessage(`${governanceAction.member.name}'s role was updated.`);
      } else if (governanceAction.kind === 'transfer') {
        const currentOwner = team?.members.find((member) => member.id === user?.id);
        if (!currentOwner) throw new Error('Current owner membership is unavailable');
        await api.post('/team/ownership/transfer', {
          targetMemberId: governanceAction.member.id,
          expectedCurrentOwnerVersion: currentOwner.membershipVersion,
          expectedTargetVersion: governanceAction.member.membershipVersion,
          confirmation: governanceConfirmation,
          reason: normalizeTeamGovernanceReason(governanceReason),
        });
        redirectAfterServerRevocation();
        return;
      } else {
        await api.post(`/team/members/${governanceAction.member.id}/${governanceAction.kind}`, {
          expectedMembershipVersion: governanceAction.member.membershipVersion,
          reason: normalizeTeamGovernanceReason(governanceReason),
        });
        setMessage(`${governanceAction.member.name}'s membership was ${governanceAction.kind === 'suspend' ? 'suspended' : governanceAction.kind === 'reactivate' ? 'reactivated' : 'removed'}.`);
      }
      setGovernanceActorRole(null);
      setGovernanceAction(null);
      setGovernanceReason('');
      setGovernanceConfirmation('');
      await Promise.all([fetchTeam(), fetchSecurityAudit()]);
    } catch (err: unknown) {
      if (apiErrorCode(err) === 'MEMBERSHIP_VERSION_CONFLICT') {
        setGovernanceActorRole(null);
        setGovernanceAction(null);
        setGovernanceReason('');
        setGovernanceConfirmation('');
        const refreshed = await fetchTeam();
        setError(
          refreshed
            ? 'This membership changed while you were reviewing it. Team details were refreshed; review them before trying again.'
            : 'This membership changed, and current team details could not be reloaded. Retry the team load before making changes.',
        );
        return;
      }
      setGovernanceError(apiErrorMessage(err, 'The governance action could not be completed.'));
    } finally {
      setGovernanceSaving(false);
      setRevokeInviteId(null);
      setRoleUpdateMemberId(null);
    }
  };

  const {
    sessionsMember,
    sessions,
    sessionsLoading,
    sessionReason,
    setSessionReason,
    sessionSavingId,
    sessionError,
    sessionAccessDisabled,
    openSessions,
    closeSessions,
    revokeSessionFamily,
    revokeAllSessions,
  } = useTeamSessions({
    currentUserId: user?.id,
    actorRole: effectiveRole,
    teamMembers: team?.members ?? null,
    teamAvailable: Boolean(team) && !teamUnavailable && Boolean(effectiveRole),
    accessRefreshing: loading,
    fetchTeam,
    fetchSecurityAudit,
    redirectAfterServerRevocation,
    setMessage,
    setError,
  });

  const teamMutationStatus: 'idle' | 'saving' | 'saved' | 'error' =
    saving || revokeInviteId || roleUpdateMemberId || governanceSaving || sessionSavingId ? 'saving' : 'idle';

  const action = actionContent(governanceAction);

  return (
    <AppPage
      eyebrow="Team permissions"
      title="Team & Permissions"
      description="Invite trustees, staff, and governance administrators with clear access levels for this charity workspace."
      actions={(
        <>
          <SaveStatusIndicator status={teamMutationStatus} />
          <StatusChip tone="brand">{team?.members.length ?? 0} members</StatusChip>
          {canInvite ? (
            <StatusChip tone={activeInviteCount > 0 ? 'warning' : 'neutral'}>{activeInviteCount} pending invites</StatusChip>
          ) : null}
        </>
      )}
    >
      {(message || error) ? (
        <InlineStatus tone={error ? 'danger' : 'success'}>
          {error ?? message}
        </InlineStatus>
      ) : null}

      <TeamRoleGuidancePanel />

      <div className={canInvite ? 'grid gap-5 lg:grid-cols-[1fr_22rem]' : 'grid gap-5'}>
        <TeamMembersPanel
          error={error}
          loading={loading}
          onRetry={fetchTeam}
          onUpdateRole={updateRole}
          onLifecycleAction={openLifecycleAction}
          onViewSessions={openSessions}
          onTransferOwnership={openOwnershipTransfer}
          roleUpdateMemberId={roleUpdateMemberId}
          managementDisabled={managementDisabled}
          team={team}
          user={permissionUser}
        />

        {canInvite ? <TeamInvitesPanel
          allowedInviteRoles={allowedInviteRoles}
          canInvite={canInvite}
          canInviteAdmin={canInviteAdmin}
          email={email}
          inviteDisabledReason={inviteDisabledReason}
          inviteMember={inviteMember}
          inviteRoleHint={inviteRoleHint}
          manualInviteUrl={manualInviteUrl}
          onDismissManualInvite={() => setManualInviteUrl(null)}
          permissionDisabledReason={permissionDisabledReason}
          managementDisabled={managementDisabled}
          revokeInvite={revokeInvite}
          revokeInviteId={revokeInviteId}
          role={role}
          saving={saving}
          setEmail={setEmail}
          setRole={setRole}
          team={team}
        /> : null}
      </div>

      {(effectiveRole === UserRole.OWNER || effectiveRole === UserRole.ADMIN) ? (
        <TeamSecurityAuditPanel
          events={securityEvents}
          loading={securityLoading}
          error={securityError}
          onRetry={fetchSecurityAudit}
        />
      ) : null}

      <TeamReasonModal
        isOpen={Boolean(governanceAction)}
        onOpenChange={(open) => !open && closeGovernanceAction()}
        title={action.title}
        description={action.description}
        reason={governanceReason}
        setReason={setGovernanceReason}
        confirmation={governanceConfirmation}
        setConfirmation={setGovernanceConfirmation}
        expectedConfirmation={governanceAction?.kind === 'transfer' ? 'TRANSFER OWNERSHIP' : undefined}
        confirmLabel={action.label}
        confirmColor={action.color}
        saving={governanceSaving}
        accessDisabled={loading || !governanceAccessValid}
        error={governanceError}
        onConfirm={confirmGovernanceAction}
      />

      <TeamSessionsModal
        member={sessionsMember}
        sessions={sessions}
        loading={sessionsLoading}
        savingFamilyId={sessionSavingId}
        accessDisabled={sessionAccessDisabled}
        reason={sessionReason}
        setReason={setSessionReason}
        error={sessionError}
        onOpenChange={closeSessions}
        onRevokeFamily={revokeSessionFamily}
        onRevokeAll={revokeAllSessions}
      />
    </AppPage>
  );
}
