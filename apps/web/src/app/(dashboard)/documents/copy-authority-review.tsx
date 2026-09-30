'use client';

import { useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { currentCopyHold } from '@/lib/copy-hold-review';
import { currentCopyPolicy, latestCopyAuthority, type CopyAuthority, type CopyPolicy } from '@/lib/copy-authority-review';

type Hold = { area: string; scopeRef: string; revision: number; held: boolean };
type Props = { kind: 'document' | 'complaint'; authorizationId: string; area: string; scopeRef: string;
  observationRevision: number; onSelect: (authority: CopyAuthority | null) => void };
const validRef = (value: string) => /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(value);
const validDate = (value: string) => value !== '' && Number.isFinite(new Date(value).getTime());
const fresh = () => ({ disposition: '', evidenceRef: '', reason: '', retentionEvidenceRef: '', holdEvidenceRef: '', validUntil: '', retentionAnchorAt: '' });

export function CopyAuthorityReview({ kind, authorizationId, area, scopeRef, observationRevision, onSelect }: Props) {
  const [data, setData] = useState<{ authorities: CopyAuthority[]; holds: Hold[]; policies: CopyPolicy[] } | null>(null);
  const [form, setForm] = useState(fresh);
  const [confirmed, setConfirmed] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const prefix = kind === 'complaint' ? '/governance-registers/complaints' : '/documents';
  const parent = `${prefix}/purge-authorizations/${encodeURIComponent(authorizationId)}`;
  const current = data ? latestCopyAuthority(data.authorities, area, scopeRef) : null;
  const hold = data ? currentCopyHold(data.holds, null, area, scopeRef) : null;
  const policy = data ? currentCopyPolicy(data.policies) : null;
  const edit = (field: keyof ReturnType<typeof fresh>, value: string) => { setForm(previous => ({ ...previous, [field]: value })); setConfirmed(false); };
  const load = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setData(null); setError(''); setConfirmed(false); onSelect(null);
    try {
      // Review requires complete histories; never infer no hold/approval from the first page.
      async function history<T>(path: string, policyHistory = false) {
        const items: T[] = []; let before: string | number | null = null;
        const seen = new Set<string | number>();
        do {
          const response: { data: { items: T[]; nextCursor?: string | null; nextBefore?: number | null } } = await api.get<{ items: T[]; nextCursor?: string | null; nextBefore?: number | null }>(path, { params: before === null ? {} : { before } });
          items.push(...response.data.items);
          before = (policyHistory ? response.data.nextBefore : response.data.nextCursor) ?? null;
          if (before !== null && seen.has(before)) throw new Error('History could not be completed. Refresh the review.');
          if (before !== null) seen.add(before);
        } while (before !== null);
        return items;
      }
      const [authorities, holds, policies] = await Promise.all([
        history<CopyAuthority>(`${parent}/copy-authorities`), history<Hold>(`${parent}/copy-holds`), history<CopyPolicy>(`${prefix}/copy-policy-revisions`, true),
      ]);
      setData({ authorities, holds, policies }); setCheckedAt(Date.now());
    } catch (cause) { setError(apiErrorMessage(cause, 'Copy review could not be loaded.')); }
    finally { pending.current = false; setBusy(false); }
  };
  const evidenceValid = validRef(form.evidenceRef) && form.reason.trim().length >= 10 && form.reason.trim().length <= 500;
  const grantValid = policy && hold && !hold.held && form.disposition &&
    (policy.retentionMode !== 'PERMANENT' || form.disposition === 'RETAIN_APPROVED') &&
    validRef(form.retentionEvidenceRef) && validRef(form.holdEvidenceRef) && validDate(form.validUntil) &&
    (policy.retentionMode !== 'AFTER_ANCHOR' || validDate(form.retentionAnchorAt));
  const save = async (withdraw: boolean) => {
    if (pending.current || !data || !confirmed || !evidenceValid || (withdraw ? current?.state !== 'AUTHORIZED' : !grantValid)) return;
    pending.current = true; setBusy(true); setError(''); setNotice(''); onSelect(null);
    const input = { area, scopeRef, observationRevision, revision: (current?.revision ?? 0) + 1,
      previousId: current?.id ?? null, evidenceRef: form.evidenceRef, reason: form.reason.trim(), authorityConfirmed: true };
    try {
      await api.post(`${parent}/copy-authorities`, withdraw ? { ...input, state: 'WITHDRAWN' } : {
        ...input, state: 'AUTHORIZED', disposition: form.disposition, policyId: policy!.id, holdRevision: hold!.revision,
        retentionEvidenceRef: form.retentionEvidenceRef, holdEvidenceRef: form.holdEvidenceRef,
        retentionAnchorAt: policy!.retentionMode === 'AFTER_ANCHOR' ? new Date(form.retentionAnchorAt).toISOString() : null,
        validUntil: new Date(form.validUntil).toISOString(),
      });
      setForm(fresh()); setNotice(withdraw ? 'Copy authority withdrawn; history retained.' : 'Copy authority recorded. Reload review to bind it to a later observation. No copy was erased.');
    } catch (cause) { setError(apiErrorMessage(cause, 'Copy authority was not confirmed. Refresh observations and review before trying again.')); }
    finally { setData(null); setConfirmed(false); pending.current = false; setBusy(false); }
  };
  const selectable = current?.state === 'AUTHORIZED' && current.validUntil && new Date(current.validUntil).getTime() > checkedAt
    && hold && !hold.held && current.holdRevision === hold.revision && policy?.id === current.policyId;
  return <section aria-label="Scoped copy authority" className="mt-3 space-y-3 rounded border p-3">
    <h5 className="font-medium">Owner authority for {scopeRef}</h5>
    <p>Review this scope against observation revision {observationRevision}. Approval records a decision; it does not delete copies. The server rechecks current policy, retention, holds and expiry.</p>
    <Button size="sm" variant="flat" isDisabled={busy} onPress={load}>Load copy authority review</Button>
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {data ? <>
      <ul>{data.authorities.filter(row => row.area === area && row.scopeRef === scopeRef).map(row => <li key={row.id} className="my-2 rounded border p-2">
        <p>Authority revision {row.revision}: {row.state} {row.disposition ?? ''}</p><p>{row.reason} Evidence: {row.evidenceRef}</p>
        <p>Recorded {new Date(row.occurredAt).toLocaleString('en-IE')}{row.validUntil ? `; expires ${new Date(row.validUntil).toLocaleString('en-IE')}` : ''}</p>
      </li>)}</ul>
      {selectable ? <Button size="sm" isDisabled={busy} onPress={() => onSelect(current)}>Use current copy authority for observation</Button> : null}
      <p>{policy ? `Current copy policy: revision ${policy.revision}, ${policy.retentionMode}, ${policy.retentionDays ?? 'no fixed'} retention days.` : 'One current approved copy policy is required. Review the copy policies panel.'}</p>
      <p>{hold?.held ? 'This scope is held. New authority cannot be granted.' : `Loaded hold revision: ${hold?.revision ?? 0}.`}</p>
      <label className="block">Reviewed copy decision<select aria-label="Reviewed copy decision" className="block rounded border p-2" value={form.disposition} disabled={busy} onChange={event => edit('disposition', event.target.value)}>
        <option value="">Select decision</option><option value="DISPOSE">Dispose after reviewed retention</option><option value="RETAIN_APPROVED">Retain with authority</option><option value="NOT_APPLICABLE">Not applicable to this scope</option>
      </select></label>
      <Input label="Copy authority evidence reference" value={form.evidenceRef} maxLength={120} isDisabled={busy} onValueChange={value => edit('evidenceRef', value)} />
      <Textarea label="Reason for copy authority decision" value={form.reason} maxLength={500} isDisabled={busy} onValueChange={value => edit('reason', value)} />
      <Input label="Copy retention review reference" value={form.retentionEvidenceRef} maxLength={120} isDisabled={busy} onValueChange={value => edit('retentionEvidenceRef', value)} />
      <Input label="Copy hold review reference" value={form.holdEvidenceRef} maxLength={120} isDisabled={busy} onValueChange={value => edit('holdEvidenceRef', value)} />
      {policy?.retentionMode === 'AFTER_ANCHOR' ? <label className="block">Reviewed copy creation time (local)<input aria-label="Reviewed copy creation time" type="datetime-local" step="0.001" value={form.retentionAnchorAt} disabled={busy} onChange={event => edit('retentionAnchorAt', event.target.value)} /></label> : null}
      <label className="block">Authority expiry (local)<input aria-label="Copy authority expiry" type="datetime-local" step="0.001" value={form.validUntil} disabled={busy} onChange={event => edit('validUntil', event.target.value)} /></label>
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I have authority and reviewed the evidence for this exact copy decision.</Checkbox>
      <Button size="sm" isDisabled={busy || !evidenceValid || !confirmed || !grantValid} onPress={() => save(false)}>Record scoped copy authority</Button>
      {current?.state === 'AUTHORIZED' ? <Button size="sm" variant="flat" isDisabled={busy || !evidenceValid || !confirmed} onPress={() => save(true)}>Withdraw scoped copy authority</Button> : null}
    </> : null}
  </section>;
}
