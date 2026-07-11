'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TeamMemberResponse, TeamSessionResponse } from '@charitypilot/shared';
import { normalizeTeamGovernanceReason } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { isCurrentSessionTargetAuthorized } from '@/lib/team-permissions';
import { apiErrorCode } from './team-page-helpers';

type NullableMessageSetter = Dispatch<SetStateAction<string | null>>;

export function useTeamSessions({
  currentUserId,
  actorRole,
  teamMembers,
  teamAvailable,
  accessRefreshing,
  fetchTeam,
  fetchSecurityAudit,
  redirectAfterServerRevocation,
  setMessage,
  setError,
}: {
  currentUserId?: string;
  actorRole: string | null;
  teamMembers: ReadonlyArray<TeamMemberResponse> | null;
  teamAvailable: boolean;
  accessRefreshing: boolean;
  fetchTeam: () => Promise<boolean>;
  fetchSecurityAudit: () => Promise<void>;
  redirectAfterServerRevocation: () => void;
  setMessage: NullableMessageSetter;
  setError: NullableMessageSetter;
}) {
  const [sessionsMember, setSessionsMember] = useState<TeamMemberResponse | null>(null);
  const [sessions, setSessions] = useState<TeamSessionResponse[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionActorRole, setSessionActorRole] = useState<string | null>(null);
  const [sessionReason, setSessionReason] = useState('');
  const [sessionSavingId, setSessionSavingId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionsRequestId = useRef(0);
  const sessionAccessValid = teamAvailable && actorRole === sessionActorRole && isCurrentSessionTargetAuthorized(
    actorRole,
    currentUserId,
    sessionsMember,
    teamMembers,
  );
  const sessionAccessDisabled = accessRefreshing || !sessionAccessValid;

  const fetchSessions = useCallback(async (member: TeamMemberResponse) => {
    const requestId = ++sessionsRequestId.current;
    setSessionsLoading(true);
    setSessionError(null);
    try {
      const { data } = await api.get<TeamSessionResponse[]>(`/team/members/${member.id}/sessions`);
      if (requestId !== sessionsRequestId.current) return;
      setSessions(data);
    } catch (err: unknown) {
      if (requestId !== sessionsRequestId.current) return;
      setSessions([]);
      setSessionError(apiErrorMessage(err, 'Sessions could not be loaded.'));
    } finally {
      if (requestId === sessionsRequestId.current) setSessionsLoading(false);
    }
  }, []);

  const openSessions = useCallback((member: TeamMemberResponse) => {
    if (
      accessRefreshing ||
      !teamAvailable ||
      !isCurrentSessionTargetAuthorized(actorRole, currentUserId, member, teamMembers)
    ) {
      setError('Session controls are unavailable until current team permissions are loaded.');
      return;
    }
    setSessionsMember(member);
    setSessionActorRole(actorRole);
    setSessions([]);
    setSessionReason('');
    setSessionError(null);
    void fetchSessions(member);
  }, [accessRefreshing, actorRole, currentUserId, fetchSessions, setError, teamAvailable, teamMembers]);

  const invalidateSessions = useCallback(() => {
    sessionsRequestId.current += 1;
    setSessionsMember(null);
    setSessionActorRole(null);
    setSessions([]);
    setSessionsLoading(false);
    setSessionReason('');
    setSessionError(null);
  }, []);

  const closeSessions = useCallback((open: boolean) => {
    if (open || sessionSavingId) return;
    invalidateSessions();
  }, [invalidateSessions, sessionSavingId]);

  useEffect(() => {
    if (!sessionsMember || sessionAccessValid) return;
    invalidateSessions();
    setError('Session controls were closed because team permissions or the target membership changed.');
  }, [invalidateSessions, sessionAccessValid, sessionsMember, setError]);

  const handleMembershipConflict = useCallback(async () => {
    invalidateSessions();
    const refreshed = await fetchTeam();
    setError(
      refreshed
        ? 'This membership changed while you were reviewing its sessions. Team details were refreshed.'
        : 'This membership changed, and current team details could not be reloaded. Retry the team load before managing sessions.',
    );
  }, [fetchTeam, invalidateSessions, setError]);

  const revokeSessionFamily = useCallback(async (familyId: string) => {
    if (!sessionsMember || sessionAccessDisabled) {
      setSessionError('Reload current team permissions before revoking a session.');
      return;
    }
    setSessionSavingId(familyId);
    setSessionError(null);
    try {
      const { data } = await api.post<{ revokedCurrentSession: boolean }>(`/team/members/${sessionsMember.id}/sessions/${familyId}/revoke`, {
        expectedMembershipVersion: sessionsMember.membershipVersion,
        reason: normalizeTeamGovernanceReason(sessionReason),
      });
      if (data.revokedCurrentSession) {
        redirectAfterServerRevocation();
        return;
      }
      setMessage('Session revoked.');
      await Promise.all([fetchSessions(sessionsMember), fetchTeam(), fetchSecurityAudit()]);
    } catch (err: unknown) {
      if (apiErrorCode(err) === 'MEMBERSHIP_VERSION_CONFLICT') {
        await handleMembershipConflict();
        return;
      }
      setSessionError(apiErrorMessage(err, 'Session could not be revoked.'));
    } finally {
      setSessionSavingId(null);
    }
  }, [
    fetchSecurityAudit,
    fetchSessions,
    fetchTeam,
    handleMembershipConflict,
    redirectAfterServerRevocation,
    sessionAccessDisabled,
    sessionReason,
    sessionsMember,
    setMessage,
  ]);

  const revokeAllSessions = useCallback(async () => {
    if (!sessionsMember || sessionAccessDisabled) {
      setSessionError('Reload current team permissions before revoking sessions.');
      return;
    }
    setSessionSavingId('all');
    setSessionError(null);
    try {
      await api.post(`/team/members/${sessionsMember.id}/sessions/revoke-all`, {
        expectedMembershipVersion: sessionsMember.membershipVersion,
        reason: normalizeTeamGovernanceReason(sessionReason),
      });
      if (sessionsMember.id === currentUserId) {
        redirectAfterServerRevocation();
        return;
      }
      setMessage('All active sessions were revoked.');
      await Promise.all([fetchSessions(sessionsMember), fetchTeam(), fetchSecurityAudit()]);
    } catch (err: unknown) {
      if (apiErrorCode(err) === 'MEMBERSHIP_VERSION_CONFLICT') {
        await handleMembershipConflict();
        return;
      }
      setSessionError(apiErrorMessage(err, 'Sessions could not be revoked.'));
    } finally {
      setSessionSavingId(null);
    }
  }, [
    currentUserId,
    fetchSecurityAudit,
    fetchSessions,
    fetchTeam,
    handleMembershipConflict,
    redirectAfterServerRevocation,
    sessionAccessDisabled,
    sessionReason,
    sessionsMember,
    setMessage,
  ]);

  return {
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
  };
}
