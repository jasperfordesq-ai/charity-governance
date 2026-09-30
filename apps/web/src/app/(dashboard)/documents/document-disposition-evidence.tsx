'use client';

import { useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { CopyAuthorityReview } from './copy-authority-review';
import type { CopyAuthority } from '@/lib/copy-authority-review';
import { CopyPreservationReview } from './copy-preservation-review';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';

const documentAreas = { VERSIONS: 'Provider versions', CONFLUENCE: 'Confluence copies', EXPORTS: 'Recipient exports', AUDIT: 'Audit records', BACKUPS: 'Backups' };
const complaintAreas = { SNAPSHOTS: 'Approved report snapshots', EXPORTS: 'Recipient exports', AUDIT: 'Audit and retained evidence', BACKUPS: 'Backups', OTHER_COPIES: 'Other copies and attachments' };
type Area = keyof typeof documentAreas | keyof typeof complaintAreas;
const statuses = { NEEDS_REVIEW: 'Needs review', PENDING_DISPOSAL: 'Disposal pending', FAILED: 'Disposal failed', VERIFIED_ABSENT: 'Absence verified by reviewer', RETAINED_APPROVED: 'Retained with approved authority', NOT_APPLICABLE: 'Not applicable to this scope' };
type Status = keyof typeof statuses;
type Observation = { id: string; area: Area; scopeRef: string; revision: number; status: Status;
  evidenceRef: string; reason: string; observedAt: string; nextReviewAt: string | null; occurredAt: string };
type Plan = Partial<Record<Area, { disposition: string; evidenceRef: string }>>;
type Props = { authorizationId: string; plan: Plan; isOwner: boolean };
const validRef = (value: string) => /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(value);
const dateValid = (value: string) => value !== '' && Number.isFinite(new Date(value).getTime());
const followUp = (status: string) => ['NEEDS_REVIEW', 'PENDING_DISPOSAL', 'FAILED', 'RETAINED_APPROVED'].includes(status);
const fresh = () => ({ area: '' as Area | '', scopeRef: '', revision: 1, status: '' as Status | '', evidenceRef: '', reason: '', observedAt: '', nextReviewAt: '' });

export function DocumentDispositionEvidence(props: Props) {
  return <DispositionEvidence {...props} kind="document" />;
}
export function ComplaintDispositionEvidence(props: Props) {
  return <DispositionEvidence {...props} kind="complaint" />;
}
function DispositionEvidence({ authorizationId, plan, isOwner, kind }: Props & {kind:'document'|'complaint'}) {
  const areas: Partial<Record<Area,string>> = kind==='complaint'?complaintAreas:documentAreas;
  const [authority, setAuthority] = useState<CopyAuthority | null>(null);
  const [rows, setRows] = useState<Observation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [form, setForm] = useState(fresh);
  const [correcting, setCorrecting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const prefix=kind==='complaint'?'/governance-registers/complaints':'/documents';
  const path = `${prefix}/purge-authorizations/${encodeURIComponent(authorizationId)}/dispositions`;
  const history = async (older = false) => {
    const { data } = await api.get<{ items: Observation[]; nextCursor: string | null }>(`${path}${older && cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
    setRows(current => older ? [...(current ?? []), ...data.items.filter(row => !current?.some(item => item.id === row.id))] : data.items);
    setCursor(data.nextCursor); setCheckedAt(Date.now());
  };
  const load = async (older = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setAuthority(null); setConfirmed(false);
    try { await history(older); }
    catch (cause) {
      if (isApiForbiddenError(cause)) { setRows(null); setCursor(null); setForm(fresh()); setConfirmed(false); }
      setError(apiErrorMessage(cause, 'Copy evidence could not be loaded.'));
    } finally { pending.current = false; setBusy(false); }
  };
  const selectedAuthority = authority?.area === form.area && authority.scopeRef === form.scopeRef ? authority : null;
  const planned = selectedAuthority?.disposition ?? (form.area ? plan[form.area]?.disposition ?? '' : '');
  const allowed = (status: Status) => status === 'NEEDS_REVIEW' || status === 'FAILED' ||
    (['PENDING_DISPOSAL', 'VERIFIED_ABSENT'].includes(status) && planned === 'DISPOSE') ||
    (status === 'RETAINED_APPROVED' && planned === 'RETAIN_APPROVED') || (status === 'NOT_APPLICABLE' && planned === 'NOT_APPLICABLE');
  const valid = form.area && form.status && allowed(form.status) && validRef(form.scopeRef) && validRef(form.evidenceRef) &&
    form.reason.trim().length >= 10 && dateValid(form.observedAt) && (!followUp(form.status) || dateValid(form.nextReviewAt)) &&
    (!form.nextReviewAt || dateValid(form.nextReviewAt));
  const save = async () => {
    if (!isOwner || pending.current || !valid || !confirmed) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.post(path, { ...form, ...(selectedAuthority ? { copyAuthorityId: selectedAuthority.id } : {}), reason: form.reason.trim(), observedAt: new Date(form.observedAt).toISOString(),
        nextReviewAt: form.nextReviewAt ? new Date(form.nextReviewAt).toISOString() : null, evidenceReviewed: true });
      setForm(fresh()); setAuthority(null); setCorrecting(false); setConfirmed(false);
      setNotice('Scoped evidence recorded. No files were erased by this action.');
      try { await history(); } catch { setRows(null); setError('Evidence was saved, but history could not refresh. Load copy evidence before another entry.'); }
    } catch (cause) {
      if (isApiForbiddenError(cause)) { setRows(null); setCursor(null); setForm(fresh()); setConfirmed(false); }
      setError(apiErrorMessage(cause, 'Evidence could not be recorded. Refresh history before retrying; a correction must use the latest revision.'));
    } finally { pending.current = false; setBusy(false); }
  };
  return <section aria-label="Copy and backup evidence" className="mt-3 rounded border p-3">
    <h4 className="font-medium">Copy and backup evidence</h4>
    <p>Record each named copy or inventory scope separately. These are reviewer observations, not automatic provider checks or confirmation that all copies are erased. Unlisted scopes remain unreviewed.</p>
    <Button size="sm" className="mt-2" variant="flat" isDisabled={busy} onPress={() => load()}>Load copy evidence</Button>
    {notice ? <p role="status" className="mt-2">{notice}</p> : null}
    {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
    {rows?.length === 0 ? <p className="mt-2">No downstream observations recorded.</p> : null}
    {rows?.length ? <ul className="mt-3 space-y-2">{rows.map(row => <li key={row.id} className="rounded border p-2">
      <p className="font-medium">{areas[row.area]} · {row.scopeRef} · Revision {row.revision}</p>
      <p>{statuses[row.status]} — {row.evidenceRef}</p><p>{row.reason}</p>
      {rows.some(other => other.area === row.area && other.scopeRef === row.scopeRef && other.revision > row.revision) ? <p>Historical observation; a later revision is shown above.</p> : null}
      <p>Observed: {new Date(row.observedAt).toLocaleString('en-IE')}. Recorded: {new Date(row.occurredAt).toLocaleString('en-IE')}.</p>
      {row.nextReviewAt ? <p>Follow-up: {new Date(row.nextReviewAt).toLocaleString('en-IE')}{new Date(row.nextReviewAt).getTime() <= checkedAt ? ' — overdue when loaded; review required' : ''}</p> : null}
      {isOwner && !rows.some(other => other.area === row.area && other.scopeRef === row.scopeRef && other.revision > row.revision) ? <Button size="sm" className="mt-2" variant="flat" isDisabled={busy} onPress={() => {
        setForm({ ...fresh(), area: row.area, scopeRef: row.scopeRef, revision: row.revision + 1 }); setCorrecting(true); setAuthority(null); setConfirmed(false); setError(''); setNotice('');
      }}>Record a later observation</Button> : null}
    </li>)}</ul> : null}
    {cursor ? <Button size="sm" className="mt-2" isDisabled={busy} onPress={() => load(true)}>Load older copy evidence</Button> : null}
    {isOwner && rows !== null ? <div className="mt-4 space-y-3">
      <h5 className="font-medium">{correcting ? `Later observation — revision ${form.revision}` : 'New copy or inventory scope'}</h5>
      <label className="block">Storage location<select aria-label="Evidence storage location" className="mt-1 block w-full rounded border p-2" value={form.area} disabled={busy || correcting}
        onChange={event => setForm(current => ({ ...current, area: event.target.value as Area, status: '' }))}>
        <option value="">Choose a location</option>{Object.entries(areas).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <Input label="Copy or inventory scope reference" description="Use the controlled reference for this exact copy or inventory. Use a later observation to correct an existing scope." value={form.scopeRef} maxLength={120} isDisabled={busy || correcting} onValueChange={value => setForm(current => ({ ...current, scopeRef: value }))} />
      <label className="block">Reviewed outcome<select aria-label="Reviewed copy outcome" className="mt-1 block w-full rounded border p-2" value={form.status} disabled={busy || !form.area}
        onChange={event => setForm(current => ({ ...current, status: event.target.value as Status }))}>
        <option value="">Choose an evidenced outcome</option>{(Object.keys(statuses) as Status[]).filter(allowed).map(value => <option key={value} value={value}>{statuses[value]}</option>)}
      </select></label>
      {selectedAuthority ? <p>Observation will cite copy authority revision {selectedAuthority.revision} ({selectedAuthority.evidenceRef}).</p> : null}
      <Input label="Copy observation evidence reference" value={form.evidenceRef} maxLength={120} isDisabled={busy} onValueChange={value => setForm(current => ({ ...current, evidenceRef: value }))} />
      <Textarea label="Reason for copy observation" value={form.reason} maxLength={500} isDisabled={busy} onValueChange={value => setForm(current => ({ ...current, reason: value }))} />
      <label className="block">Observation time (your local time)<input aria-label="Copy observation time" type="datetime-local" step="0.001" className="mt-1 block rounded border p-2" value={form.observedAt} disabled={busy} onChange={event => setForm(current => ({ ...current, observedAt: event.target.value }))} /></label>
      <label className="block">Follow-up review time (required for unresolved or retained copies)<input aria-label="Copy follow-up time" type="datetime-local" step="0.001" className="mt-1 block rounded border p-2" value={form.nextReviewAt} disabled={busy} onChange={event => setForm(current => ({ ...current, nextReviewAt: event.target.value }))} /></label>
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I reviewed the evidence for this exact scope and outcome.</Checkbox>
      <div className="flex flex-wrap gap-2"><Button size="sm" isDisabled={busy || !valid || !confirmed} onPress={save}>Record copy observation</Button>
        {correcting ? <Button size="sm" variant="flat" isDisabled={busy} onPress={() => { setForm(fresh()); setAuthority(null); setCorrecting(false); setConfirmed(false); }}>Start a new scope</Button> : null}</div>
      {correcting && form.area && validRef(form.scopeRef) ? <CopyAuthorityReview
        key={`authority:${authorizationId}:${form.area}:${form.scopeRef}:${form.revision}`}
        kind={kind} authorizationId={authorizationId} area={form.area} scopeRef={form.scopeRef}
        observationRevision={form.revision - 1} onSelect={value => { setAuthority(value); setConfirmed(false); setForm(current => ({ ...current, status: '' })); }} /> : null}
      {form.area && validRef(form.scopeRef) ? <CopyPreservationReview
        key={`${authorizationId}:${form.area}:${form.scopeRef}:${form.revision}`}
        kind={kind} authorizationId={authorizationId} area={form.area} scopeRef={form.scopeRef}
        observationRevision={form.revision - 1} /> : null}
    </div> : null}
  </section>;
}
