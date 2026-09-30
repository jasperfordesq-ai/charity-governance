'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SessionReplayDiagnosticResponse, SessionReplayDiagnosticsPageResponse } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { logClientError } from '@/lib/client-logger';
import { AppSection } from '@/components/ui/app-page';

export function ReplayDiagnosticsPanel() {
  const [events, setEvents] = useState<SessionReplayDiagnosticResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderError, setOlderError] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    setOlderError(false);
    try {
      const response = await api.get<SessionReplayDiagnosticsPageResponse>('/team/replay-diagnostics');
      setEvents(response.data.data);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      logClientError('Failed to load session replay diagnostics', cause);
      setEvents([]);
      setNextCursor(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOlder = async () => {
    if (!nextCursor || loading || loadingMore) return;
    setLoadingMore(true);
    setOlderError(false);
    try {
      const response = await api.get<SessionReplayDiagnosticsPageResponse>('/team/replay-diagnostics', {
        params: { before: nextCursor },
      });
      setEvents((current) => {
        const seen = new Set(current.map((event) => event.eventId));
        return [...current, ...response.data.data.filter((event) => !seen.has(event.eventId))];
      });
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      logClientError('Failed to load older session replay diagnostics', cause);
      setOlderError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <AppSection title="Session replay diagnostics" description="Recent quarantined session families. These facts help correlate API logs; they do not establish why a refresh token was reused.">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-300">Replay events are loaded 50 at a time without token values or user identifiers.</p>
        <button className="rounded border border-gray-300 px-3 py-1 text-sm dark:border-gray-600" type="button" onClick={() => void refresh()} disabled={loading || loadingMore}>Refresh</button>
      </div>
      {loading ? <p className="mt-3 text-sm">Loading replay events…</p> : error ? (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300">Replay diagnostics could not be loaded.</p>
      ) : events.length === 0 ? (
        <p className="mt-3 text-sm">No replay events appear in the latest result.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-200 text-sm dark:divide-gray-700">
          {events.map((event) => (
            <li className="py-3" key={event.eventId}>
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toISOString()}</time>
              <span className="ml-3">Event ID: {event.eventId}</span>
              <span className="ml-3">Family fingerprint: {event.familyFingerprint ?? 'unavailable'}</span>
              <span className="ml-3">Spent session fingerprint: {event.presentedSessionFingerprint ?? 'not recorded'}</span>
              <span className="ml-3">Active sessions quarantined: {event.newlyQuarantinedSessionCount ?? 'not recorded'}</span>
              <span className="ml-3">Client: {event.clientKind ?? 'unknown'}</span>
              <span className="ml-3">Access: {event.accessLevel ?? 'unknown'}</span>
              <span className="ml-3">Previous revocation: {event.previousRevocationReason ?? 'not recorded'}</span>
              <span className="ml-3">Spent session revoked at: {event.presentedSessionRevokedAt ?? 'not recorded'}</span>
              <span className="ml-3">Request ID: {event.requestId ?? 'not recorded'}</span>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && !loading && !error ? <button className="mt-3 rounded border border-gray-300 px-3 py-1 text-sm dark:border-gray-600" type="button" onClick={() => void loadOlder()} disabled={loadingMore}>
        {loadingMore ? 'Loading older events…' : 'Load older events'}
      </button> : null}
      {olderError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">Older replay events could not be loaded. Try again.</p> : null}
      <p className="mt-3 text-xs text-gray-500">Matching spent-session fingerprints mean the same session row was presented again. Compare its earlier revocation time with the event and restricted request logs; a short gap alone does not establish a benign race. A zero quarantine count may mean the family was already inactive. Older events may lack these fields.</p>
    </AppSection>
  );
}
