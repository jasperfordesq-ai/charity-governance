'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Textarea } from '@heroui/react';
import type { ComplaintRecordResponse } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { ComplaintRemovalControl } from './complaint-recovery-panel';
import { ComplaintHoldPanel } from './complaint-hold-panel';

type Evidence = {
  id: string; revision: number; recordRevision: number; state: 'RECORDED' | 'WITHDRAWN';
  resolvedAt: string | null; evidenceRef: string; reason: string; occurredAt: string;
};
type History = { items: Evidence[]; nextBeforeRevision: number | null };
type ReviewedComplaint = ComplaintRecordResponse & { revision: number };
type RetentionAssessment = { state: string; assessedAt: string; retentionUntil: string | null; removalAuthorized: false; policyId: string | null };
const assessmentLabels: Record<string, string> = {
  ADMINISTRATIVE_HOLD: 'An administrative hold blocks removal. Review the hold separately.',
  POLICY_REVIEW_REQUIRED: 'A current approved complaint policy is required.',
  PERMANENT_RETENTION: 'The policy requires permanent retention.',
  COMPLAINT_OPEN: 'The complaint must be closed before removal can be reviewed.',
  INDIVIDUAL_REVIEW_REQUIRED: 'The policy requires an individual removal review.',
  RESOLUTION_REVIEW_REQUIRED: 'Current resolution evidence must be reviewed first.',
  RETENTION_NOT_REACHED: 'The approved minimum retention period has not elapsed.',
  INDEPENDENT_RECOVERY_REQUIRED: 'This charity requires an independently recorded recovery decision before removal can be reviewed.',
  READY_FOR_REMOVAL_REVIEW: 'The minimum retention period has elapsed; removal still requires review.',
};

export function ComplaintResolutionPanel({ complaints, onChanged }: { complaints: ComplaintRecordResponse[]; onChanged: () => void }) {
  const [id, setId] = useState('');
  const [holdReviewVersion, setHoldReviewVersion] = useState(0);
  const selected = complaints.find((complaint) => complaint.id === id);
  return <section aria-label="Complaint resolution evidence" className="space-y-3 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">Complaint resolution evidence</h2>
    <p>Record when a closed complaint was resolved and where the reviewed evidence is held. This does not approve a retention period or delete the complaint. Changes to the complaint require a fresh review.</p>
    <label className="block">Complaint to review
      <select className="mt-1 block w-full rounded border bg-background p-2" value={selected ? id : ''} onChange={(event) => setId(event.target.value)}>
        <option value="">Choose a complaint</option>
        {complaints.map((complaint) => <option key={complaint.id} value={complaint.id}>{complaint.summary}</option>)}
      </select>
    </label>
    {!complaints.length ? <p>No complaints in the selected reporting year.</p> : null}
    {selected ? <ComplaintResolutionReview key={`${selected.id}:${selected.updatedAt}:${holdReviewVersion}`} id={selected.id} onChanged={onChanged} /> : null}
    {selected ? <ComplaintHoldPanel key={selected.id} id={selected.id} onChanged={() => setHoldReviewVersion(value => value + 1)} /> : null}
  </section>;
}

function ComplaintResolutionReview({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [complaint, setComplaint] = useState<ReviewedComplaint | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [assessment, setAssessment] = useState<RetentionAssessment | null>(null);
  const [resolvedAt, setResolvedAt] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const root = `/governance-registers/complaints/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    const serial = ++request.current;
    setBusy(true); setError(''); setComplaint(null); setHistory(null); setAssessment(null);
    try {
      const [record, evidence, retention] = await Promise.all([api.get(root), api.get(`${root}/resolution-evidence`), api.get(`${root}/retention-assessment`)]);
      if (serial !== request.current) return;
      setComplaint(record.data as ReviewedComplaint); setHistory(evidence.data as History);
      setAssessment(retention.data as RetentionAssessment);
    } catch (cause) {
      if (serial === request.current) setError(apiErrorMessage(cause, 'The complaint review could not be loaded.'));
    } finally { if (serial === request.current) setBusy(false); }
  }, [root]);

  useEffect(() => {
    const pendingRequests = request;
    void load();
    return () => { pendingRequests.current++; };
  }, [load]);

  async function submit(state: 'RECORDED' | 'WITHDRAWN') {
    if (!complaint || !history) return;
    const serial = ++request.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.post(`${root}/resolution-evidence`, {
        expectedRecordRevision: complaint.revision,
        expectedEvidenceRevision: history.items[0]?.revision ?? 0,
        state, evidenceRef, reason,
        ...(state === 'RECORDED' ? { resolvedAt: new Date(resolvedAt).toISOString() } : {}),
      });
      if (serial !== request.current) return;
      setNotice(state === 'RECORDED' ? 'Resolution evidence recorded.' : 'Resolution evidence withdrawn; history retained.');
      setResolvedAt(''); setEvidenceRef(''); setReason('');
      await load();
    } catch (cause) {
      if (serial === request.current) {
        setError(apiErrorMessage(cause, 'Resolution evidence could not be saved. Reload before trying again.'));
        setComplaint(null); setHistory(null); setBusy(false);
      }
    }
  }

  async function more() {
    if (!history?.nextBeforeRevision) return;
    const serial = ++request.current;
    setBusy(true); setError('');
    try {
      const response = await api.get(`${root}/resolution-evidence`, { params: { beforeRevision: history.nextBeforeRevision } });
      if (serial !== request.current) return;
      const page = response.data as History;
      setHistory({ items: [...history.items, ...page.items], nextBeforeRevision: page.nextBeforeRevision });
    } catch (cause) {
      if (serial === request.current) setError(apiErrorMessage(cause, 'Older resolution evidence could not be loaded.'));
    } finally { if (serial === request.current) setBusy(false); }
  }

  const latest = history?.items[0];
  const current = complaint?.status === 'CLOSED' && latest?.state === 'RECORDED' && latest.recordRevision === complaint.revision;
  const validReference = /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(evidenceRef);
  const validReason = reason.trim().length >= 10 && reason.trim().length <= 500 && !/[\x00-\x1f\x7f]/.test(reason);
  const commonDisabled = busy || !complaint || !history || !validReference || !validReason;
  return <div className="space-y-3" aria-busy={busy}>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <Button size="sm" isDisabled={busy} onPress={() => void load()}>Reload complaint review</Button>
    {complaint && history ? <>
      <p>{complaint.summary}</p>
      <p>Status: {complaint.status}. {current ? 'Resolution evidence matches this version.' : 'No current resolution evidence applies to this version.'}</p>
      {assessment ? <div aria-label="Complaint retention assessment">
        <p>{assessmentLabels[assessment.state] ?? 'Retention requires further review.'}</p>
        {assessment.retentionUntil ? <p>Minimum retention ends: {new Date(assessment.retentionUntil).toLocaleString()}</p> : null}
        <p>Assessed {new Date(assessment.assessedAt).toLocaleString()}. This assessment does not authorise removal. Reload after policy or record changes.</p>
      </div> : null}
      <Input label="Resolution time (your local time)" type="datetime-local" value={resolvedAt} onValueChange={setResolvedAt} isDisabled={busy || complaint.status !== 'CLOSED'} />
      <Input label="Controlled resolution evidence reference" description="Use an opaque reference with uppercase letters, digits and hyphens; do not enter names or case details." value={evidenceRef} onValueChange={setEvidenceRef} isDisabled={busy} maxLength={120} />
      <Textarea label="Resolution review reason" description="Explain the review or correction without copying personal complaint details. At least 10 characters." value={reason} onValueChange={setReason} isDisabled={busy} maxLength={500} />
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={commonDisabled || complaint.status !== 'CLOSED' || !resolvedAt || !Number.isFinite(Date.parse(resolvedAt))} onPress={() => void submit('RECORDED')}>Record resolution evidence</Button>
        <Button isDisabled={commonDisabled || latest?.state !== 'RECORDED'} onPress={() => void submit('WITHDRAWN')}>Withdraw resolution evidence</Button>
      </div>
      <h3 className="font-semibold">Resolution review history</h3>
      {!history.items.length ? <p>No resolution evidence recorded.</p> : <ol aria-label="Resolution evidence history" className="space-y-2">{history.items.map((item) => <li key={item.id} className="rounded border p-2">
        <p>Review {item.revision}: {item.state === 'RECORDED' ? 'Recorded' : 'Withdrawn'} · {new Date(item.occurredAt).toLocaleString()}</p>
        {item.resolvedAt ? <p>Resolved: {new Date(item.resolvedAt).toLocaleString()}</p> : null}
        <p>{item.evidenceRef} — {item.reason}</p>
        {item.recordRevision !== complaint.revision ? <p>The complaint has changed since this review.</p> : null}
      </li>)}</ol>}
      {history.nextBeforeRevision ? <Button isDisabled={busy} onPress={() => void more()}>Load older resolution reviews</Button> : null}
      {complaint.reviewedByBoard || complaint.boardMinuteReference?.trim() ? <p>Removal of a complaint with board evidence requires separate review.</p> : null}
      <ComplaintRemovalControl id={id} revision={complaint.revision} policyId={assessment?.policyId ?? null}
        evidenceRevision={latest?.revision ?? 0} onChanged={onChanged}
        eligible={!busy && !complaint.reviewedByBoard && !complaint.boardMinuteReference?.trim()
          && ['READY_FOR_REMOVAL_REVIEW', 'INDIVIDUAL_REVIEW_REQUIRED'].includes(assessment?.state ?? '')} />
    </> : busy ? <p role="status">Loading complaint review…</p> : null}
  </div>;
}
