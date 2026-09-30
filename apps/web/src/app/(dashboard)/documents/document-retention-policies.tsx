'use client';

import { useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { apiErrorMessage } from '@/lib/errors';
import { statusPanelClassName } from '@/components/ui/status';
import { ConfirmActionModal } from '@/components/ui/confirm-action-modal';

type Terms = { retentionMode: 'REVIEW_REQUIRED' | 'PERMANENT' | 'AFTER_ANCHOR'; retentionDays: number | null; recoveryDays: number };
type Revision = Terms & { id: string; revision: number; state: 'DRAFT' | 'APPROVED';
  approvedAt: string | null; approvalEvidenceRef: string | null; withdrawal: { reason: string; evidenceRef: string } | null };
function describe(terms: Terms, anchor = 'document creation') {
  const retention = terms.retentionMode === 'PERMANENT' ? 'Permanent retention: removal is prohibited.'
    : terms.retentionMode === 'AFTER_ANCHOR' ? `Retain for ${terms.retentionDays} days from ${anchor} before reviewing removal.`
    : 'Each removal requires a recorded, individual review decision.';
  return `${retention} Recovery window after authorised removal: ${terms.recoveryDays} days.`;
}

export function DocumentRetentionPolicies() {
  return <RetentionPolicies recordClass="VAULT_DRAFT" />;
}

export function RetentionPolicies({ recordClass }: { recordClass: 'VAULT_DRAFT' | 'COMPLAINT' }) {
  const complaint = recordClass === 'COMPLAINT';
  const endpoint = complaint ? '/governance-registers/complaints/policy-revisions' : '/documents/policy-revisions';
  const title = complaint ? 'Complaint retention policies' : 'Draft retention policies';
  const anchor = complaint ? 'reviewed complaint resolution' : 'document creation';
  const { user } = useAuth();
  const isOwner = user?.role === 'OWNER';
  const [rows, setRows] = useState<Revision[] | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [mode, setMode] = useState<Terms['retentionMode']>('REVIEW_REQUIRED');
  const [retention, setRetention] = useState('');
  const [recovery, setRecovery] = useState('');
  const [review, setReview] = useState<Terms | null>(null);
  const [withdraw, setWithdraw] = useState<Revision | null>(null);
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const terms: Terms = { retentionMode: mode, retentionDays: mode === 'AFTER_ANCHOR' ? Number(retention) : null, recoveryDays: Number(recovery) };
  const valid = Number.isInteger(terms.recoveryDays) && terms.recoveryDays >= 1 && terms.recoveryDays <= 3650
    && (mode !== 'AFTER_ANCHOR' || (Number.isInteger(terms.retentionDays) && terms.retentionDays! >= 1 && terms.retentionDays! <= 36525));
  const validEvidence = /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(evidence);

  const load = async (older = false) => {
    if (pending.current || (older && !before)) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const { data } = await api.get<{ items: Revision[]; nextBefore: number | null }>(`${endpoint}${older ? `?before=${before}` : ''}`);
      setRows(current => older ? [...(current ?? []), ...data.items] : data.items);
      setBefore(data.nextBefore);
    } catch (cause) { setError(apiErrorMessage(cause, 'Policy history could not be loaded.')); }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async (approved: boolean) => {
    if (pending.current || (approved ? !isOwner || !review || !confirmed || !validEvidence : !valid)) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.post(endpoint, approved
        ? { ...review, state: 'APPROVED', authorityConfirmed: true, approvalEvidenceRef: evidence }
        : { ...terms, state: 'DRAFT' });
      setReview(null); setRows(null); setBefore(null);
      setNotice(approved ? 'New policy approved. Earlier approvals were withdrawn; existing recovery deadlines are unchanged.' : 'Proposal recorded. It does not authorise removal.');
    } catch (cause) { setError(apiErrorMessage(cause, 'Policy could not be recorded.')); }
    finally { pending.current = false; setBusy(false); }
  };
  const withdrawPolicy = async () => {
    if (pending.current || !isOwner || !withdraw || !validEvidence || Array.from(reason.trim()).length < 10) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.post(`${endpoint}/${encodeURIComponent(withdraw.id)}/withdraw`, { evidenceRef: evidence, reason: reason.trim() });
      setWithdraw(null); setRows(null); setBefore(null);
      setNotice('Policy withdrawn. It cannot authorise new removals; existing recovery deadlines are unchanged.');
    } catch (cause) { setError(apiErrorMessage(cause, 'Policy could not be withdrawn.')); }
    finally { pending.current = false; setBusy(false); }
  };

  return <section className={statusPanelClassName('neutral', 'p-5')} aria-label={title}>
    <h2 className="font-semibold">{title}</h2>
    <p className="text-sm">{complaint ? 'These rules apply only to complaints. Timed rules require reviewed resolution evidence that still matches the closed complaint. Complaint recovery and permanent erasure controls are still being implemented.' : 'These rules apply only to unheld Vault drafts without linked evidence.'} Recovery days are separate from retention obligations. Record the charity’s approved rules; no period is supplied automatically. Other record classes and permanent erasure need separate review.</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Retention rule<select className="mt-1 block w-full rounded border p-2" value={mode} disabled={busy}
        onChange={event => setMode(event.target.value as Terms['retentionMode'])}>
        <option value="REVIEW_REQUIRED">Individual removal review required</option>
        <option value="AFTER_ANCHOR">Minimum days from {anchor}</option>
        <option value="PERMANENT">Permanent retention — no removal</option>
      </select></label>
      {mode === 'AFTER_ANCHOR' ? <Input type="number" label="Minimum retention days" value={retention} onValueChange={setRetention} min={1} max={36525} isDisabled={busy} /> : null}
      <Input type="number" label="Recovery days after removal" value={recovery} onValueChange={setRecovery} min={1} max={3650} isDisabled={busy}
        classNames={{ description: '!text-gray-700 dark:!text-gray-300' }}
        description="A permanent-retention rule still prohibits removal regardless of this recovery value." />
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="flat" onPress={() => save(false)} isDisabled={!valid || busy}>Save proposal</Button>
      {isOwner ? <Button size="sm" variant="flat" isDisabled={!valid || busy} onPress={() => { setReview({ ...terms }); setEvidence(''); setConfirmed(false); setError(''); }}>Review approval</Button> : null}
      <Button size="sm" variant="flat" onPress={() => load()} isDisabled={busy}>Load policy history</Button>
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
    {rows?.length === 0 ? <p className="mt-3 text-sm">No policy revisions recorded.</p> : null}
    {rows?.length ? <ol className="mt-4 space-y-3">{rows.map(row => <li key={row.id} className="rounded border p-3 text-sm">
      <h3 className="font-medium">Revision {row.revision}: {row.withdrawal ? 'Withdrawn' : row.state === 'APPROVED' ? 'Approved' : 'Proposal'}</h3>
      <p>{describe(row, anchor)}</p>
      {row.approvalEvidenceRef ? <p>Approval evidence: {row.approvalEvidenceRef}</p> : null}
      {row.withdrawal ? <p>Withdrawal: {row.withdrawal.reason} Evidence: {row.withdrawal.evidenceRef}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="flat" isDisabled={busy} onPress={() => { setMode(row.retentionMode); setRetention(row.retentionDays?.toString() ?? ''); setRecovery(String(row.recoveryDays)); }}>Copy terms into form</Button>
        {isOwner && row.state === 'APPROVED' && !row.withdrawal ? <Button size="sm" variant="flat" isDisabled={busy}
          onPress={() => { setWithdraw(row); setEvidence(''); setReason(''); setError(''); }}>Review withdrawal</Button> : null}
      </div>
    </li>)}</ol> : null}
    {before ? <Button className="mt-3" size="sm" variant="flat" isDisabled={busy} onPress={() => load(true)}>Load older policies</Button> : null}
    <ConfirmActionModal isOpen={review !== null} onOpenChange={open => { if (!open && !busy) setReview(null); }}
      title={complaint ? 'Approve complaint retention policy' : 'Approve draft retention policy'} confirmLabel="Approve and replace earlier approvals" confirming={busy}
      confirmDisabled={!isOwner || !confirmed || !validEvidence} onConfirm={() => save(true)}>
      <p>{review ? describe(review, anchor) : ''}</p>
      <p className="mt-2">{complaint ? 'This becomes the current complaint assessment policy; recoverable removal is not yet available.' : 'This becomes available for new removals.'} It withdraws earlier approvals for this record class. Existing removed records keep their recorded deadlines. This does not authorise permanent erasure.</p>
      <Input className="mt-3" label="Policy approval evidence reference" value={evidence} onValueChange={setEvidence} maxLength={120} isDisabled={busy}
        description="Capital letters, numbers and hyphens, for example POLICY-001." />
      <Checkbox className="mt-3" isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy}>I have authority to approve these exact terms and the cited evidence records that decision.</Checkbox>
      {error ? <p role="alert" className="mt-3 text-red-700">{error}</p> : null}
    </ConfirmActionModal>
    <ConfirmActionModal isOpen={withdraw !== null} onOpenChange={open => { if (!open && !busy) setWithdraw(null); }}
      title={`Withdraw policy revision ${withdraw?.revision ?? ''}`} confirmLabel="Withdraw policy" confirming={busy}
      confirmDisabled={!isOwner || !validEvidence || Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500} onConfirm={withdrawPolicy}>
      <p>Prevent this policy from authorising new removals. Existing recovery deadlines and retained history remain unchanged.</p>
      <Input className="mt-3" label="Withdrawal evidence reference" value={evidence} onValueChange={setEvidence} maxLength={120} isDisabled={busy} />
      <Textarea className="mt-3" label="Reason for policy withdrawal" value={reason} onValueChange={setReason} maxLength={500} isDisabled={busy} />
      {error ? <p role="alert" className="mt-3 text-red-700">{error}</p> : null}
    </ConfirmActionModal>
  </section>;
}
