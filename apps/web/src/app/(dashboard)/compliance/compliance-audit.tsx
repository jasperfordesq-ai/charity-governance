'use client';

import { useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type ComplianceChange = {
  id: string;
  type: string;
  standardId: string | null;
  complianceRecordId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  occurredAt: string;
};
type AuditPage = { items: ComplianceChange[]; nextCursor: string | null };

export function ComplianceAudit({ year }: { year: number }) {
  const [changes, setChanges] = useState<ComplianceChange[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const load = async (before?: string) => {
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const response = await api.get('/compliance/audit', { params: { year, ...(before ? { before } : {}) } });
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
        setError(apiErrorMessage(cause, 'Compliance decision history could not be loaded.'));
      }
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  };

  return <AppSection title={`Detailed compliance decision history · ${year}`}
    description="Restricted status, evidence and approval changes for this reporting year. Open a record to inspect its retained before and after state."
  >
    <div aria-label="Detailed compliance decision history">
      <Button size="sm" variant="flat" onPress={() => void load()} isDisabled={busy} isLoading={busy}>
        {changes === null ? 'Load detailed decisions' : 'Refresh detailed decisions'}
      </Button>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {changes?.length === 0 ? <p className="mt-3 text-sm">No retained decision was found for this year.</p> : null}
      {changes && changes.length > 0 ? <>
        <p className="mt-3 text-xs">Showing {changes.length} retained decision{changes.length === 1 ? '' : 's'}.</p>
        <ol className="mt-2 space-y-2 text-sm">{changes.map((change) => <li key={change.id} className="rounded border p-3">
          <strong>{change.type} · {change.standardId ?? change.complianceRecordId ?? 'annual approval'}</strong>
          <p className="text-xs">Actor {change.actorName ?? change.actorUserId ?? 'not recorded'} · {new Date(change.occurredAt).toLocaleString('en-IE')}</p>
          {change.reason ? <p className="text-xs">Reason: {change.reason}</p> : null}
          <details className="mt-2"><summary>Inspect retained before and after record</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ before: change.beforeState, after: change.afterState }, null, 2)}</pre>
          </details>
        </li>)}</ol>
      </> : null}
      {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
        isDisabled={busy} isLoading={busy}>Load older compliance decisions</Button> : null}
    </div>
  </AppSection>;
}
