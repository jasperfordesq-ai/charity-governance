'use client';

import { useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type RegisterChange = {
  id: string;
  recordKind: string;
  recordId: string;
  actorUserId: string;
  action: string;
  previousStatus: string | null;
  nextStatus: string | null;
  changedFields: string[];
  occurredAt: string;
};
type AuditPage = { items: RegisterChange[]; nextCursor: string | null };

export function RegisterChangeAudit() {
  const [changes, setChanges] = useState<RegisterChange[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const load = async (before?: string) => {
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const response = await api.get('/governance-registers/change-audit', { params: before ? { before } : {} });
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
        setError(apiErrorMessage(cause, 'Register change history could not be loaded.'));
      }
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  };

  return <AppSection title="Register change history"
    description="Restricted metadata for conflict, complaint, fundraising and risk record changes across reporting years. This records changed field names, not their earlier values."
  >
    <div aria-label="Register change history">
      <Button size="sm" variant="flat" onPress={() => void load()} isDisabled={busy} isLoading={busy}>
        {changes === null ? 'Load register changes' : 'Refresh register changes'}
      </Button>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {changes?.length === 0 ? <p className="mt-3 text-sm">No retained register change was found.</p> : null}
      {changes && changes.length > 0 ? <>
        <p className="mt-3 text-xs">Showing {changes.length} retained change{changes.length === 1 ? '' : 's'}.</p>
        <ol className="mt-2 space-y-2 text-sm">{changes.map((change) => <li key={change.id} className="rounded border p-3">
          <strong>{change.action} · {change.recordKind} · {change.recordId}</strong>
          <p className="text-xs">Actor {change.actorUserId} · {new Date(change.occurredAt).toLocaleString('en-IE')}</p>
          <p className="text-xs">Status {change.previousStatus ?? 'none'} → {change.nextStatus ?? 'none'}</p>
          <p className="text-xs">Changed fields: {change.changedFields.length ? change.changedFields.join(', ') : 'none recorded'}</p>
        </li>)}</ol>
      </> : null}
      {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
        isDisabled={busy} isLoading={busy}>Load older register changes</Button> : null}
    </div>
  </AppSection>;
}
