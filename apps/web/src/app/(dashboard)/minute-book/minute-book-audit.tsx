'use client';

import { useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type MinuteBookChange = {
  id: string;
  recordKind: string;
  recordId: string;
  action: string;
  actorUserId: string;
  beforeState: unknown;
  afterState: unknown;
  occurredAt: string;
};
type AuditPage = { items: MinuteBookChange[]; nextCursor: string | null };

export function MinuteBookAudit() {
  const [changes, setChanges] = useState<MinuteBookChange[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const load = async (before?: string) => {
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const response = await api.get('/governing-acts/audit', { params: before ? { before } : {} });
      const page = response.data as AuditPage;
      if (currentRequest !== requestId.current) return;
      const items = Array.isArray(page?.items) ? page.items : [];
      setChanges((current) => {
        if (!before || !current) return items;
        const seen = new Set(current.map((change) => change.id));
        return [...current, ...items.filter((change) => !seen.has(change.id))];
      });
      setNextCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : null);
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(apiErrorMessage(cause, 'Minute Book change history could not be loaded.'));
      }
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  };

  return <AppSection title="Detailed Minute Book change history"
    description="Restricted before and after records for governing acts and resolutions. Earlier changes appear only if they were recorded after this audit began."
  >
    <div aria-label="Detailed Minute Book change history">
      <Button size="sm" variant="flat" onPress={() => void load()} isDisabled={busy} isLoading={busy}>
        {changes === null ? 'Load detailed history' : 'Refresh detailed history'}
      </Button>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {changes?.length === 0 ? <p className="mt-3 text-sm">No retained change was found.</p> : null}
      {changes && changes.length > 0 ? <>
        <p className="mt-3 text-xs">Showing {changes.length} retained change{changes.length === 1 ? '' : 's'}.</p>
        <ol className="mt-2 space-y-2 text-sm">{changes.map((change) => <li key={change.id} className="rounded border p-3">
          <strong>{change.action} · {change.recordKind} · {change.recordId}</strong>
          <p className="text-xs">Actor {change.actorUserId} · {new Date(change.occurredAt).toLocaleString('en-IE')}</p>
          <details className="mt-2"><summary>Inspect retained before and after record</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ before: change.beforeState, after: change.afterState }, null, 2)}</pre>
          </details>
        </li>)}</ol>
      </> : null}
      {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
        isDisabled={busy} isLoading={busy}>Load older Minute Book changes</Button> : null}
    </div>
  </AppSection>;
}
