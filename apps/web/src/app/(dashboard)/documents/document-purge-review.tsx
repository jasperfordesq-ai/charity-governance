'use client';

import { useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';
import { statusPanelClassName } from '@/components/ui/status';

const areas = ['PRIMARY', 'VERSIONS', 'CONFLUENCE', 'EXPORTS', 'AUDIT', 'BACKUPS'] as const;
const labels = { PRIMARY: 'Primary file', VERSIONS: 'Provider versions', CONFLUENCE: 'Confluence copies', EXPORTS: 'Recipient exports', AUDIT: 'Audit records', BACKUPS: 'Backups' };
type Area = typeof areas[number];
type Disposition = '' | 'DISPOSE' | 'RETAIN_APPROVED' | 'NOT_APPLICABLE';
type Plan = Record<Area, { disposition: Disposition; evidenceRef: string }>;
type Document = { id: string; name: string; updatedAt: string; recoveryUntil: string; deletionHold: boolean };
type Policy = { id: string; revision: number; retentionMode: string; retentionDays: number | null };
type Authorization = { id: string; documentId: string; reason: string; evidenceRef: string; recoveryUntil: string;
  authorizedAt: string; dispositionPlan: Plan; withdrawal: { evidenceRef: string } | null;
  claim: { deletionId: string; claimedAt: string; deletion: { state: string; activeObjectAbsentAt: string | null } } | null };
const freshPlan = () => Object.fromEntries(areas.map(area => [area, { disposition: '', evidenceRef: '' }])) as Plan;
const evidenceValid = (value: string) => /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(value);
const reasonValid = (value: string) => Array.from(value.trim()).length >= 10 && Array.from(value.trim()).length <= 500;
const describe = (value: Disposition) => ({ DISPOSE: 'Disposal planned', RETAIN_APPROVED: 'Approved retention', NOT_APPLICABLE: 'Not applicable', '': 'Not reviewed' })[value];

export function DocumentPurgeReview({ document, onClaimed }: { document: Document | null; onClaimed: () => Promise<void> }) {
  const { user } = useAuth();
  const isOwner = user?.role === 'OWNER';
  const [rows, setRows] = useState<Authorization[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [plan, setPlan] = useState<Plan>(freshPlan);
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [review, setReview] = useState<{ kind: 'authorize'; document: Document; policyId: string; plan: Plan; reason: string; evidenceRef: string } |
    { kind: 'withdraw' | 'claim'; authorization: Authorization } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);

  const history = async (older = false) => {
    const { data } = await api.get<{ items: Authorization[]; nextCursor: string | null }>(`/documents/purge-authorizations${older && cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
    setRows(current => older ? [...(current ?? []), ...data.items.filter(row => !current?.some(item => item.id === row.id))] : data.items);
    setCursor(data.nextCursor);
  };
  const load = async (older = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await history(older);
      if (!older) { const { data } = await api.get<Policy[]>('/documents/recovery-policies'); setPolicies(data); setPolicyId(''); }
    } catch (cause) {
      if (isApiForbiddenError(cause)) { setRows(null); setCursor(null); setPolicies([]); setReview(null); }
      setError(apiErrorMessage(cause, 'Disposal decisions could not be loaded.'));
    } finally { pending.current = false; setBusy(false); }
  };
  const perform = async () => {
    if (!review || pending.current || !isOwner) return;
    if (review.kind === 'withdraw' ? !evidenceValid(evidence) || !reasonValid(reason) : !confirmed) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (review.kind === 'authorize') {
        await api.post('/documents/purge-authorizations', { documentId: review.document.id,
          expectedUpdatedAt: review.document.updatedAt, policyId: review.policyId, dispositionPlan: review.plan,
          reason: review.reason, evidenceRef: review.evidenceRef, authorityConfirmed: true });
        setNotice('Disposal authorization recorded. Nothing has been erased.');
        setPlan(freshPlan()); setPolicyId(''); setReason(''); setEvidence('');
      } else if (review.kind === 'withdraw') {
        await api.post(`/documents/purge-authorizations/${encodeURIComponent(review.authorization.id)}/withdraw`, { evidenceRef: evidence, reason: reason.trim() });
        setNotice('Disposal authorization withdrawn. Its history is preserved.');
      } else {
        await api.post(`/documents/purge-authorizations/${encodeURIComponent(review.authorization.id)}/claim`, { confirmPermanentPurge: true });
        setNotice('Primary file disposal queued. Recovery is no longer available. Other copies still require their own evidence.');
      }
      const claimed = review.kind === 'claim';
      setReview(null); setConfirmed(false);
      try { await history(); if (claimed) await onClaimed(); }
      catch { setError('The action succeeded, but the view could not refresh. Reload the page before another action.'); }
    } catch (cause) {
      if (isApiForbiddenError(cause)) { setRows(null); setPolicies([]); setReview(null); }
      setError(apiErrorMessage(cause, 'The action could not be confirmed. Refresh disposal history before retrying.'));
    } finally { pending.current = false; setBusy(false); }
  };
  const validPlan = areas.every(area => plan[area].disposition && evidenceValid(plan[area].evidenceRef)) && plan.PRIMARY.disposition === 'DISPOSE';

  return <section aria-label="Disposal decisions" className={statusPanelClassName('neutral', 'mt-4 p-4')}>
    <h3 className="font-semibold">Disposal decisions</h3>
    <p className="text-sm">Review the plan for every copy. Authorizing a plan does not erase data. Primary file disposal is a separate Owner action after retention and recovery expiry; other copies need separate verification.</p>
    <Button size="sm" className="mt-3" variant="flat" onPress={() => load()} isDisabled={busy}>Load disposal decisions</Button>
    {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
    {isOwner && document ? <div className="mt-4 space-y-3">
      <h4 className="font-medium">Prepare disposal plan: {document.name}</h4>
      <p className="text-sm">Recovery deadline: {new Date(document.recoveryUntil).toLocaleString('en-IE')}. {document.deletionHold ? 'A deletion hold blocks authorization.' : 'The server checks current holds and file contents again.'}</p>
      <label className="block text-sm">Disposal policy<select aria-label="Disposal policy" className="mt-1 block w-full rounded border p-2" value={policyId} disabled={busy} onChange={event => setPolicyId(event.target.value)}>
        <option value="">Load decisions, then choose an approved policy</option>
        {policies.map(policy => <option key={policy.id} value={policy.id}>Revision {policy.revision}: {policy.retentionMode === 'AFTER_ANCHOR' ? `${policy.retentionDays} days from creation` : 'Individual disposition review'}</option>)}
      </select></label>
      {areas.map(area => <fieldset key={area} className="rounded border p-3">
        <legend className="px-1 text-sm font-medium">{labels[area]}</legend>
        <label className="block text-sm">{labels[area]} plan<select aria-label={`${labels[area]} plan`} className="mt-1 block w-full rounded border p-2" value={plan[area].disposition} disabled={busy}
          onChange={event => setPlan(current => ({ ...current, [area]: { ...current[area], disposition: event.target.value as Disposition } }))}>
          <option value="">Choose a reviewed disposition</option><option value="DISPOSE">Disposal planned</option>
          {area !== 'PRIMARY' ? <><option value="RETAIN_APPROVED">Retain with approved authority</option><option value="NOT_APPLICABLE">Not applicable</option></> : null}
        </select></label>
        <Input className="mt-2" label={`${labels[area]} evidence reference`} value={plan[area].evidenceRef} maxLength={120} isDisabled={busy}
          onValueChange={value => setPlan(current => ({ ...current, [area]: { ...current[area], evidenceRef: value } }))} />
      </fieldset>)}
      <Input label="Disposal authorization evidence reference" value={evidence} onValueChange={setEvidence} maxLength={120} isDisabled={busy} />
      <Textarea label="Reason for disposal authorization" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy} />
      <Button variant="flat" isDisabled={busy || document.deletionHold || !policyId || !validPlan || !evidenceValid(evidence) || !reasonValid(reason)} onPress={() => {
        setReview({ kind: 'authorize', document: { ...document }, policyId, plan, reason: reason.trim(), evidenceRef: evidence }); setConfirmed(false); setError('');
      }}>Review disposal authorization</Button>
    </div> : null}
    {rows?.length === 0 ? <p className="mt-3 text-sm">No disposal authorizations recorded.</p> : null}
    {rows?.length ? <ul className="mt-4 space-y-3">{rows.map(row => <li key={row.id} className="rounded border p-3 text-sm">
      <p className="font-medium">Decision {row.evidenceRef}</p><p>Document reference: {row.documentId}</p>
      <p>{row.reason}</p><p>Authorized: {new Date(row.authorizedAt).toLocaleString('en-IE')}</p>
      <ul>{areas.map(area => <li key={area}>{labels[area]}: {describe(row.dispositionPlan[area].disposition)} — {row.dispositionPlan[area].evidenceRef}</li>)}</ul>
      <p className="mt-2">{row.withdrawal ? `Withdrawn: ${row.withdrawal.evidenceRef}` : row.claim
        ? row.claim.deletion.activeObjectAbsentAt ? 'Primary object absence verified. This does not verify versions, exports or backups.' : `Primary disposal job: ${row.claim.deletion.state}. Other copies remain separately accountable.`
        : 'Authorized plan only. No disposal claimed.'}</p>
      {isOwner && !row.withdrawal && !row.claim ? <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="flat" isDisabled={busy} onPress={() => { setReview({ kind: 'withdraw', authorization: row }); setReason(''); setEvidence(''); setError(''); }}>Review disposal cancellation</Button>
        <Button size="sm" color="danger" variant="flat" isDisabled={busy} onPress={() => { setReview({ kind: 'claim', authorization: row }); setConfirmed(false); setError(''); }}>Review permanent primary disposal</Button>
      </div> : null}
    </li>)}</ul> : null}
    {cursor ? <Button size="sm" className="mt-3" onPress={() => load(true)} isDisabled={busy}>Load older disposal decisions</Button> : null}
    <ConfirmActionModal isOpen={review !== null} onOpenChange={open => { if (!open && !busy) setReview(null); }} ariaLabel="Review disposal decision"
      title={review?.kind === 'authorize' ? 'Authorize disposal plan' : review?.kind === 'withdraw' ? 'Withdraw disposal authorization' : 'Permanently dispose of the primary file'}
      confirmLabel={review?.kind === 'authorize' ? 'Record disposal authorization' : review?.kind === 'withdraw' ? 'Withdraw disposal authorization' : 'Queue permanent primary disposal'}
      confirmColor={review?.kind === 'claim' ? 'danger' : 'primary'} confirming={busy}
      confirmDisabled={review?.kind === 'withdraw' ? !evidenceValid(evidence) || !reasonValid(reason) : !confirmed} onConfirm={perform}>
      {review?.kind === 'authorize' ? <>
        <p>Authorize this exact plan for <strong>{review.document.name}</strong> using {review.evidenceRef}?</p>
        <p>{review.reason}</p><ul className="mt-2 text-sm">{areas.map(area => <li key={area}>{labels[area]}: {describe(review.plan[area].disposition)} — {review.plan[area].evidenceRef}</li>)}</ul>
        <Checkbox className="mt-3" isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I have authority to approve this exact disposal plan and its evidence.</Checkbox>
      </> : review?.kind === 'withdraw' ? <>
        <p>Withdraw {review.authorization.evidenceRef}? Cancellation is refused if irreversible disposal has already been claimed.</p>
        <Input className="mt-3" label="Disposal cancellation evidence reference" value={evidence} onValueChange={setEvidence} maxLength={120} isDisabled={busy} />
        <Textarea className="mt-3" label="Reason for disposal cancellation" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy} />
      </> : review?.kind === 'claim' ? <>
        <p>Execute {review.authorization.evidenceRef} for document {review.authorization.documentId}? Recovery will become unavailable as soon as the server accepts this claim. This action cannot recall deletion already dispatched.</p>
        <p className="mt-2">Recovery deadline: {new Date(review.authorization.recoveryUntil).toLocaleString('en-IE')}. The server also checks retention, holds and current authority. Other copies are not erased by this action.</p>
        <Checkbox className="mt-3" isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I confirm permanent disposal of the primary file under this authorization.</Checkbox>
      </> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
    </ConfirmActionModal>
  </section>;
}
