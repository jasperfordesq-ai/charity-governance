'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecurityAuditEventResponse, SecurityAuditPageResponse } from '@charitypilot/shared';
import { UserRole } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { logClientError } from '@/lib/client-logger';

export function useTeamSecurityAudit(effectiveRole: UserRole | null) {
  const [events, setEvents] = useState<SecurityAuditEventResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const olderInFlight = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    olderInFlight.current = null;
    setLoadingOlder(false);
    if (effectiveRole !== UserRole.OWNER && effectiveRole !== UserRole.ADMIN) {
      setEvents([]);
      setError(null);
      setNextCursor(null);
      setOlderError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setOlderError(null);
    try {
      const { data } = await api.get<SecurityAuditPageResponse>('/team/security-audit');
      if (requestId !== requestIdRef.current) return;
      setEvents(data.data);
      setNextCursor(data.nextCursor);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      logClientError('Failed to load team security audit', cause);
      setError(apiErrorMessage(cause, 'The security audit could not be loaded.'));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [effectiveRole]);

  const loadOlder = useCallback(async () => {
    if (loading || olderInFlight.current !== null || !nextCursor ||
      (effectiveRole !== UserRole.OWNER && effectiveRole !== UserRole.ADMIN)) return;
    const requestId = requestIdRef.current;
    olderInFlight.current = requestId;
    const before = nextCursor;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const { data } = await api.get<SecurityAuditPageResponse>('/team/security-audit', { params: { before } });
      if (requestId !== requestIdRef.current) return;
      setEvents((existing) => [...existing, ...data.data]);
      setNextCursor(data.nextCursor);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      logClientError('Failed to load older team security audit', cause);
      setOlderError(apiErrorMessage(cause, 'Older security events could not be loaded.'));
    } finally {
      if (olderInFlight.current === requestId) olderInFlight.current = null;
      if (requestId === requestIdRef.current) setLoadingOlder(false);
    }
  }, [effectiveRole, loading, nextCursor]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { events, loading, error, nextCursor, loadingOlder, olderError, refresh, loadOlder };
}
