'use client';

import { useState } from 'react';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { statusPanelClassName } from '@/components/ui/status';

type ControlEvent = {
  id: string;
  source: 'control' | 'visibility';
  documentId: string;
  actorUserId: string;
  kind: string;
  previous: string;
  next: string;
  reason: string;
  occurredAt: string;
};

export function DocumentControlHistory() {
  const [events, setEvents] = useState<ControlEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/documents/control-audit');
      setEvents(response.data?.data ?? []);
      setNextCursor(response.data?.nextCursor ?? null);
    } catch (cause) {
      setEvents(null);
      setNextCursor(null);
      setError(apiErrorMessage(cause, 'Document control history could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };
  const loadOlder = async () => {
    if (!nextCursor || loading || loadingOlder) return;
    setLoadingOlder(true);
    setError('');
    try {
      const response = await api.get('/documents/control-audit', { params: { before: nextCursor } });
      const older: ControlEvent[] = response.data?.data ?? [];
      setEvents((current) => {
        const seen = new Set((current ?? []).map((event) => `${event.source}:${event.id}`));
        return [...(current ?? []), ...older.filter((event) => !seen.has(`${event.source}:${event.id}`))];
      });
      setNextCursor(response.data?.nextCursor ?? null);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Older document control history could not be loaded.'));
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <section className={statusPanelClassName('neutral', 'p-5')} aria-label="Document control history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Document change history</h2>
          <p className="text-sm">Uploads, metadata edits, standard links, Confluence citations, access, publication, deletion-hold and storage-provider decisions, and record deletions can be reviewed 50 at a time. Metadata events record field names and revision times rather than document text. A record deletion does not prove storage or Confluence erasure. Historical rows remain after a document is deleted.</p>
        </div>
        <Button size="sm" variant="flat" onPress={load} isLoading={loading} isDisabled={loadingOlder}>Load history</Button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {events?.length === 0 ? <p className="mt-3 text-sm">No document changes have been recorded in this history.</p> : null}
      {events && events.length > 0 ? (
        <ol className="mt-4 space-y-3">
          {events.map((event) => (
            <li key={`${event.source}:${event.id}`} className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
              <p className="font-medium">{event.kind}: {event.previous} → {event.next}</p>
              <p className="break-words">{event.reason}</p>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Document {event.documentId} · Actor {event.actorUserId} · {new Date(event.occurredAt).toLocaleString('en-IE')}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={loadOlder} isLoading={loadingOlder} isDisabled={loading}>Load older changes</Button> : null}
    </section>
  );
}
