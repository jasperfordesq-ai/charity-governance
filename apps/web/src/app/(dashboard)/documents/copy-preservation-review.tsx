'use client';

import { useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { currentCopyHold } from '@/lib/copy-hold-review';

type Hold = { id: string; area: string; scopeRef: string; revision: number; held: boolean;
  observationRevision: number; evidenceRef: string; reason: string; occurredAt: string };
type Props = { kind: 'document' | 'complaint'; authorizationId: string; area: string; scopeRef: string; observationRevision: number };

// The parent keys this component by scope and observation revision to discard stale review state.
export function CopyPreservationReview({ kind, authorizationId, area, scopeRef, observationRevision }: Props) {
  const [rows, setRows] = useState<Hold[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const prefix = kind === 'complaint' ? '/governance-registers/complaints' : '/documents';
  const path = `${prefix}/purge-authorizations/${encodeURIComponent(authorizationId)}/copy-holds`;
  const current = currentCopyHold(rows, cursor, area, scopeRef);
  const valid = /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(evidence) && reason.trim().length >= 10 && reason.trim().length <= 500;
  const load = async (older = false) => {
    if (pending.current || (older && !cursor)) return;
    pending.current = true; setBusy(true); setError(''); setConfirmed(false);
    if (!older) { setRows(null); setCursor(null); }
    try {
      const { data } = await api.get<{ items: Hold[]; nextCursor: string | null }>(path, { params: older ? { before: cursor } : {} });
      setRows(previous => older ? [...(previous ?? []), ...data.items.filter(row => !previous?.some(item => item.id === row.id))] : data.items);
      setCursor(data.nextCursor);
    } catch (cause) {
      if (isApiForbiddenError(cause)) { setRows(null); setCursor(null); setEvidence(''); setReason(''); }
      setError(apiErrorMessage(cause, 'Preservation history could not be loaded.'));
    } finally { pending.current = false; setBusy(false); }
  };
  const save = async () => {
    if (pending.current || !current || !valid || !confirmed) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.post(path, { area, scopeRef, revision: current.revision + 1, observationRevision,
        held: !current.held, evidenceRef: evidence, reason: reason.trim(), holdConfirmed: true });
      setNotice(current.held ? 'Hold release recorded. New copy authority still requires separate review.' : 'Preservation hold recorded for this exact scope.');
      setEvidence(''); setReason('');
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The hold was not confirmed. Refresh copy observations and hold history before reviewing again.'));
      if (isApiForbiddenError(cause)) { setEvidence(''); setReason(''); }
    } finally {
      // Also invalidate after uncertain responses: never replay a decision against an old revision.
      setRows(null); setCursor(null); setConfirmed(false); pending.current = false; setBusy(false);
    }
  };
  return <section aria-label="Scoped copy preservation" className="mt-3 space-y-3 rounded border p-3">
    <h5 className="font-medium">Preservation hold for {scopeRef}</h5>
    <p>Location: {area.replaceAll('_', ' ').toLowerCase()}. Observation revision: {observationRevision}.
      A hold preserves this scope. Releasing it does not approve deletion or revive earlier copy authority.</p>
    <Button size="sm" variant="flat" isDisabled={busy} onPress={() => load()}>Load preservation history</Button>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {rows !== null ? <ul>{rows.filter(row => row.area === area && row.scopeRef === scopeRef).map(row => <li key={row.id} className="my-2 rounded border p-2">
      <p>Revision {row.revision}: {row.held ? 'Hold recorded' : 'Hold released'} · {new Date(row.occurredAt).toLocaleString('en-IE')}</p>
      <p>{row.reason} Evidence: {row.evidenceRef}</p>
    </li>)}</ul> : null}
    {cursor ? <><p>Load the remaining history before making a preservation decision.</p>
      <Button size="sm" isDisabled={busy} onPress={() => load(true)}>Load older preservation history</Button></> : null}
    {current ? <>
      <p>{current.held ? 'The latest recorded decision holds this scope.' : 'No active hold is recorded for this scope in the loaded history.'}</p>
      <Input label="Copy hold evidence reference" value={evidence} maxLength={120} isDisabled={busy}
        onValueChange={value => { setEvidence(value); setConfirmed(false); }} />
      <Textarea label="Reason for copy preservation decision" value={reason} maxLength={500} isDisabled={busy}
        onValueChange={value => { setReason(value); setConfirmed(false); }} />
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>
        {current.held ? 'I reviewed the evidence and have authority to release this exact hold.' : 'I reviewed the evidence requiring preservation of this exact scope.'}
      </Checkbox>
      <Button size="sm" isDisabled={busy || !valid || !confirmed} onPress={save}>{current.held ? 'Record copy hold release' : 'Record copy preservation hold'}</Button>
    </> : null}
  </section>;
}
