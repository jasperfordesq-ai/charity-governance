'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';
import { ComplaintHoldPanel } from './complaint-hold-panel';

type Removal = { expectedRevision: number; expectedEvidenceRevision: number; policyId: string; evidenceRef: string; reason: string };

export function ComplaintRemovalControl({ id, revision, policyId, evidenceRevision, eligible, onChanged }: {
  id: string; revision: number; policyId: string | null; evidenceRevision: number; eligible: boolean; onChanged: () => void;
}) {
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const valid = eligible && policyId && /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(reference)
    && reason.trim().length >= 10 && reason.trim().length <= 500 && !/[\u0000-\u001f\u007f-\u009f]/.test(reason);
  async function remove() {
    if (!review || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await api.post(`/governance-registers/complaints/${encodeURIComponent(id)}/remove`, review);
      setReview(null); onChanged();
    } catch (cause) { setError(apiErrorMessage(cause, 'Complaint removal failed. Reload and review it again.')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="space-y-3 rounded border p-3" aria-label="Complaint removal review">
    <h3 className="font-semibold">Move to recovery</h3>
    <p>The record will leave ordinary registers, search and working exports. Its contents remain available for recovery within the approved window. This does not erase historical reports or backups.</p>
    <Input label="Complaint removal authority reference" value={reference} onValueChange={setReference} maxLength={120} isDisabled={busy || !eligible} description="Use a controlled reference with uppercase letters, digits and hyphens." />
    <Textarea label="Reason for removing this complaint" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy || !eligible} description="Explain the decision without copying personal case details." />
    <Button isDisabled={!valid || busy} onPress={() => { setError(''); setReview({ expectedRevision: revision,
      expectedEvidenceRevision: evidenceRevision, policyId: policyId!, evidenceRef: reference, reason: reason.trim() }); }}>Review complaint removal</Button>
    <ConfirmActionModal isOpen={review !== null} onOpenChange={open => { if (!open && !busy) setReview(null); }}
      title="Move complaint to recovery" confirmLabel="Move complaint to recovery" confirming={busy} onConfirm={() => void remove()}>
      <p>Confirm removal of this reviewed complaint. The approved policy sets the recovery deadline; permanent erasure is a separate decision.</p>
      <p>Authority: {review?.evidenceRef}</p><p>{review?.reason}</p>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmActionModal>
  </div>;
}

type RemovedComplaint = { id: string; summary: string; revision: number; removedAt: string;
  removal: { id: string; recoveryUntil: string; evidenceRef: string } };
type Page = { items: RemovedComplaint[]; nextCursor: string | null };

export function ComplaintRecoveryPanel({ onChanged }: { onChanged: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [holdId, setHoldId] = useState<string | null>(null);
  const [review, setReview] = useState<RemovedComplaint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const pending = useRef(false);
  const load = useCallback(async (before?: string) => {
    const serial = ++sequence.current;
    setBusy(true); setError('');
    try {
      const response = await api.get<Page>('/governance-registers/complaints/removed', { params: before ? { before } : {} });
      if (serial !== sequence.current) return;
      setPage(current => ({ items: before ? [...(current?.items ?? []), ...response.data.items] : response.data.items, nextCursor: response.data.nextCursor }));
    } catch (cause) { if (serial === sequence.current) setError(apiErrorMessage(cause, 'Removed complaints could not be loaded.')); }
    finally { if (serial === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => { const counter = sequence; void load(); return () => { counter.current++; }; }, [load]);
  async function restore() {
    if (!review || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await api.post(`/governance-registers/complaints/${encodeURIComponent(review.id)}/restore`, { expectedRevision: review.revision });
      setReview(null); onChanged(); await load();
    } catch (cause) { setError(apiErrorMessage(cause, 'Restoration failed. Reload the recovery list before trying again.')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-label="Recoverable complaints" className="space-y-3 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">Recoverable complaints</h2>
    <p>Restoring returns the unchanged complaint to the active register. Resolution evidence requires a fresh review. Expired recovery windows need separate disposition review; this screen cannot permanently erase a complaint.</p>
    <Button isDisabled={busy} onPress={() => void load()}>Reload recoverable complaints</Button>
    {error ? <p role="alert">{error}</p> : null}
    {page?.items.length === 0 ? <p>No recoverable complaints.</p> : null}
    <ul className="space-y-2">{page?.items.map(item => <li key={item.id} className="rounded border p-3">
      <p>{item.summary}</p><p>Recovery deadline: {new Date(item.removal.recoveryUntil).toLocaleString()}</p>
      <p>Removal authority: {item.removal.evidenceRef}</p>
      <Button isDisabled={busy} onPress={() => setHoldId(current => current === item.id ? null : item.id)}>Review administrative hold</Button>
      {holdId === item.id ? <ComplaintHoldPanel id={item.id} /> : null}
      <Button isDisabled={busy} onPress={() => { setError(''); setReview(item); }}>Review complaint restoration</Button>
    </li>)}</ul>
    {page?.nextCursor ? <Button isDisabled={busy} onPress={() => void load(page.nextCursor!)}>Load older recoverable complaints</Button> : null}
    <ConfirmActionModal isOpen={review !== null} onOpenChange={open => { if (!open && !busy) setReview(null); }}
      title="Restore complaint" confirmLabel="Restore complaint" confirming={busy} onConfirm={() => void restore()}>
      <p>{review?.summary}</p><p>Restore this complaint within its approved recovery window. The action and your identity will be recorded.</p>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmActionModal>
  </section>;
}
