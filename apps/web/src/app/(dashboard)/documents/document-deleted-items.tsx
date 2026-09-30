'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { statusPanelClassName } from '@/components/ui/status';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';
import { DocumentPurgeReview } from './document-purge-review';

type DeletedDocument = {
  id: string; name: string; deletedAt: string; recoveryUntil: string;
  deletionHold: boolean; updatedAt: string;
};
type DeletedPage = { items: DeletedDocument[]; nextCursor: string | null };

export function DocumentDeletedItems({ onRestored }: { onRestored: () => Promise<void> }) {
  const [items, setItems] = useState<DeletedDocument[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<DeletedDocument | null>(null);
  const [disposalDocument, setDisposalDocument] = useState<DeletedDocument | null>(null);
  const [reason, setReason] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = async (older = false) => {
    if (pending.current || (older && !cursor)) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await api.get<DeletedPage>(`/documents/deleted${older ? `?before=${encodeURIComponent(cursor!)}` : ''}`);
      if (!mounted.current) return;
      const result = response.data;
      setItems(current => older
        ? [...(current ?? []), ...result.items.filter(item => !current?.some(existing => existing.id === item.id))]
        : result.items);
      setCursor(result.nextCursor);
    } catch (cause) {
      if (!mounted.current) return;
      if (isApiForbiddenError(cause)) { setItems(null); setCursor(null); setSelected(null); }
      setError(apiErrorMessage(cause, 'Deleted Items could not be loaded. Refresh the list and try again.'));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

  const restore = async () => {
    if (!selected || pending.current || Array.from(reason.trim()).length < 10) return;
    pending.current = true; setRestoring(true); setRestoreError(''); setNotice('');
    try {
      await api.post(`/documents/${encodeURIComponent(selected.id)}/restore`, {
        expectedUpdatedAt: selected.updatedAt, reason: reason.trim(),
      });
      if (!mounted.current) return;
      setItems(current => current?.filter(item => item.id !== selected.id) ?? null);
      // A restored cursor no longer belongs to Deleted Items. Restart pagination.
      setCursor(null);
      setSelected(null); setReason('');
      setNotice('Document restored with restricted access. Review sharing separately. Refresh Deleted Items to review the remaining records.');
      try { await onRestored(); } catch {
        if (mounted.current) setError('Restoration succeeded, but the Vault could not refresh. Reload the page.');
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (isApiForbiddenError(cause)) {
        setItems(null); setCursor(null); setSelected(null);
        setError('Your access changed. Refresh the page before reviewing Deleted Items.');
      } else setRestoreError(apiErrorMessage(cause, 'The document could not be restored. Its retained record has not been released. Refresh and review it again.'));
    } finally { pending.current = false; if (mounted.current) setRestoring(false); }
  };

  return (
    <section className={statusPanelClassName('neutral', 'p-5')} aria-label="Deleted Items">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Deleted Items</h2>
          <p className="text-sm">Removed drafts retain their files during the approved recovery window. Restoring keeps access restricted and preserves any hold. Expiry does not automatically erase a file.</p>
        </div>
        <Button size="sm" variant="flat" onPress={() => load()} isLoading={busy} isDisabled={restoring}>
          {items === null ? 'Load Deleted Items' : 'Refresh Deleted Items'}
        </Button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {items?.length === 0 ? <p className="mt-3 text-sm">No removed documents in this list. Refresh to check for recent changes.</p> : null}
      {items?.length ? <ul className="mt-4 space-y-3">
        {items.map(item => <li key={item.id} className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
          <h3 className="break-words font-medium">{item.name}</h3>
          <p>Removed: {new Date(item.deletedAt).toLocaleString('en-IE')}</p>
          <p>Recovery deadline: {new Date(item.recoveryUntil).toLocaleString('en-IE')}</p>
          <p>{item.deletionHold ? 'Deletion hold active — restoration preserves it.' : 'No deletion hold recorded.'}</p>
          <Button className="mt-2" size="sm" variant="flat" isDisabled={busy || restoring}
            onPress={() => { setSelected(item); setReason(''); setRestoreError(''); }}>Review restoration</Button>
          <Button className="ml-2 mt-2" size="sm" variant="flat" isDisabled={busy || restoring}
            onPress={() => setDisposalDocument(item)}>Review disposal plan</Button>
        </li>)}
      </ul> : null}
      {cursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => load(true)} isDisabled={busy || restoring}>Load older removed documents</Button> : null}
      <DocumentPurgeReview document={disposalDocument} onClaimed={async () => { setDisposalDocument(null); await load(); }} />
      <ConfirmActionModal isOpen={selected !== null} onOpenChange={open => { if (!open && !restoring) setSelected(null); }}
        ariaLabel="Restore retained document" title="Restore document" confirmLabel="Restore with restricted access"
        confirmColor="primary" confirming={restoring} confirmDisabled={Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500}
        onConfirm={restore}>
        <p>Restore <strong>{selected?.name}</strong>? The server checks the recovery deadline and original file contents. Prior Member and publication approvals will not be restored.</p>
        <Textarea className="mt-3" label="Reason for restoration" value={reason} onValueChange={setReason}
          maxLength={500} isRequired isDisabled={restoring} description="10–500 characters. Recorded in document change history." />
        {restoreError ? <p role="alert" className="mt-3 text-red-700">{restoreError}</p> : null}
      </ConfirmActionModal>
    </section>
  );
}
