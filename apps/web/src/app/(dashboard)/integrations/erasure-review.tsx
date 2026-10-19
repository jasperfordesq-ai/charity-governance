'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type Subject = 'ERASURE' | 'CITATION';
type Props = { targetDigest: string; controlPageId: string } & ({ deletionId: string; referenceId?: never } | { referenceId: string; deletionId?: never });
type Review = { id: string; deletionId?: string; referenceId?: string; instruction?: null; kind: string; clientRequestId: string; recordedAt: string; actorUserId: string;
  input: { expectedTargetDigest: string; controlPageId: string; actionReport: string; evidenceRef: string; actionEvidenceRef: string | null; actionReportedAt: string | null };
  observation: { targetDigest: string; status: string; permanentErasureVerified: false; scope?: string; jobCreated?: false; attachmentsObserved?: false; citationUpdated?: false };
  operatorReportOnly: true; actionAuthorized: false; historicalReceipt: true; currentStateVerified: false };
type Action = 'NOT_REPORTED' | 'TRASH_REPORTED' | 'PURGE_REPORTED';
const evidence = /^[A-Z0-9][A-Z0-9-]{2,119}$/;
const description = { description: 'text-gray-600 dark:text-gray-300' };
function validReceipt(value: Review, subject: Subject) {
  return value && typeof value.id === 'string' && (subject === 'ERASURE'
    ? typeof value.deletionId === 'string' && value.kind === 'CONFLUENCE_ERASURE_REVIEW_V1'
    : typeof value.referenceId === 'string' && value.kind === 'CONFLUENCE_CITATION_REVIEW_V1' && value.instruction === null
      && value.observation?.scope === 'CITED_PAGE_ONLY' && value.observation.jobCreated === false
      && value.observation.attachmentsObserved === false && value.observation.citationUpdated === false)
    && Number.isFinite(Date.parse(value.recordedAt)) && value.operatorReportOnly === true && value.actionAuthorized === false
    && value.historicalReceipt === true && value.currentStateVerified === false && value.observation?.permanentErasureVerified === false
    && ['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN'].includes(value.observation.status)
    && /^[a-f0-9]{64}$/.test(value.observation.targetDigest) && value.input?.expectedTargetDigest === value.observation.targetDigest
    && ['NOT_REPORTED', 'TRASH_REPORTED', 'PURGE_REPORTED'].includes(value.input.actionReport) && evidence.test(value.input.evidenceRef);
}
function Receipt({ review }: { review: Review }) {
  return <div role="status" className="space-y-1 text-sm"><p>Historical report recorded: {review.id}</p>
    <p>{review.referenceId ? `Recorded citation: ${review.referenceId}. No deletion instruction recorded.` : `Recorded deletion job: ${review.deletionId}.`} Actor: {review.actorUserId}.</p>
    <p>Operator report: {review.input.actionReport.replaceAll('_', ' ').toLowerCase()}. Review evidence: {review.input.evidenceRef}.</p>
    {review.input.actionEvidenceRef ? <p>Reported action evidence: {review.input.actionEvidenceRef}. Reported time: {review.input.actionReportedAt}.</p> : null}
    <p>Provider observation recorded: {review.observation.status}. Recorded {new Date(review.recordedAt).toLocaleString('en-IE')}.</p>
    <p>This receipt does not establish current provider state or disposal authority.</p></div>;
}

export function ErasureReviewLookup({ subject = 'ERASURE' }: { subject?: Subject }) {
  const [reference, setReference] = useState(''), [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lookup = async () => {
    if (busy) return;
    setBusy(true); setError(''); setReview(null);
    try {
      const { data } = await api.get<{ review: Review }>(`/integrations/confluence/${subject === 'CITATION' ? 'references' : 'erasures'}/reviews/${encodeURIComponent(reference)}`);
      if (!validReceipt(data.review, subject) || (data.review.id !== reference && data.review.clientRequestId !== reference)) throw new Error('The original report receipt could not be verified.');
      setReview(data.review);
    } catch (cause) { setError(apiErrorMessage(cause, 'The historical report could not be verified.')); }
    finally { setBusy(false); }
  };
  return <section aria-label={subject === 'CITATION' ? 'Historical Confluence citation review lookup' : 'Historical Confluence review lookup'} className="mt-3 space-y-3 rounded border p-3 text-gray-900 dark:text-gray-100">
    <h4 className="font-medium">Look up a historical {subject === 'CITATION' ? 'cited-page ' : ''}review report</h4>
    <p className="text-sm">Use the original request reference or the event ID from Governance Audit → Integrations. This reads a saved report without contacting Confluence.</p>
    <Input label="Original request or audit event reference" value={reference} isDisabled={busy} onValueChange={value => { setReference(value); setReview(null); setError(''); }} />
    <Button size="sm" variant="flat" isLoading={busy} isDisabled={busy || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reference)} onPress={() => void lookup()}>{subject === 'CITATION' ? 'Read historical citation review report' : 'Read historical review report'}</Button>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {review ? <Receipt review={review} /> : null}
  </section>;
}

export function ErasureReview(props: Props) {
  const subject: Subject = props.referenceId ? 'CITATION' : 'ERASURE';
  const subjectId = props.referenceId ?? props.deletionId;
  const prefix = subject === 'CITATION' ? 'references' : 'erasures';
  const [requestId, setRequestId] = useState(''), [evidenceRef, setEvidenceRef] = useState(''), [reason, setReason] = useState('');
  const [action, setAction] = useState<Action>('NOT_REPORTED'), [actionRef, setActionRef] = useState(''), [actionAt, setActionAt] = useState('');
  const [actionTimeAllowed, setActionTimeAllowed] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  const [state, setState] = useState<'READY' | 'SAVING' | 'UNKNOWN' | 'RECORDED'>('READY');
  const [review, setReview] = useState<Review | null>(null), [lookingUp, setLookingUp] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const accept = (value: Review) => {
    if (!validReceipt(value, subject) || (subject === 'CITATION' ? value.referenceId : value.deletionId) !== subjectId || value.clientRequestId !== requestId
      || value.input.expectedTargetDigest !== props.targetDigest || value.input.controlPageId !== props.controlPageId) throw new Error('The original report receipt could not be verified.');
    setReview(value); setState('RECORDED');
  };
  const save = async () => {
    if (state !== 'READY' || !confirmed) return;
    setState('SAVING'); setError('');
    try {
      const { data } = await api.post<{ review: Review }>(`/integrations/confluence/${prefix}/${subject === 'CITATION' ? 'by-id/' : ''}${encodeURIComponent(subjectId)}/reviews`, {
        clientRequestId: requestId, expectedTargetDigest: props.targetDigest, controlPageId: props.controlPageId,
        evidenceRef, reason, actionReport: action, actionEvidenceRef: action === 'NOT_REPORTED' ? null : actionRef,
        actionReportedAt: action === 'NOT_REPORTED' ? null : new Date(actionAt).toISOString(), evidenceReviewed: true,
      });
      if (active.current) accept(data.review);
    } catch (cause) { if (active.current) { setState('UNKNOWN'); setError(apiErrorMessage(cause, 'The save outcome is unknown. Look up the original receipt before any new report.')); } }
  };
  const lookup = async () => {
    if (lookingUp) return;
    setLookingUp(true); setError('');
    try {
      const { data } = await api.get<{ review: Review }>(`/integrations/confluence/${prefix}/reviews/${requestId}`);
      if (active.current) accept(data.review);
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'The original receipt was not confirmed. A missing response does not prove the save failed.')); }
    finally { if (active.current) setLookingUp(false); }
  };
  if (!requestId) return <Button size="sm" variant="flat" onPress={() => setRequestId(crypto.randomUUID())}>{subject === 'CITATION' ? 'Prepare citation review report' : 'Prepare review report'}</Button>;
  const frozen = state !== 'READY', reasonLength = Array.from(reason.trim()).length;
  const valid = evidence.test(evidenceRef) && reasonLength >= 10 && reasonLength <= 500 && !/[\u0000-\u001f\u007f-\u009f]/.test(reason)
    && (action === 'NOT_REPORTED' || (evidence.test(actionRef) && actionAt !== '' && actionTimeAllowed));
  return <section aria-label={subject === 'CITATION' ? 'Confluence citation review report' : 'Confluence erasure review report'} className="space-y-3 rounded border border-gray-300 p-3 text-gray-900 dark:border-gray-600 dark:text-gray-100">
    <h5 className="font-medium">Record a review report</h5>
    <p className="break-all text-sm">Original request reference: {requestId}</p>
    <p className="text-sm">Keep this reference to look up the receipt. Saving reads the provider again and records a historical report.
      It does not authorise deletion, complete a job or verify permanent erasure.</p>
    {subject === 'CITATION' ? <p className="text-sm">This report records no deletion instruction. Its observation covers the cited page only, not attachments, earlier versions or backups.</p> : null}
    <Input label="Review evidence reference" value={evidenceRef} maxLength={120} isDisabled={frozen} classNames={description} onValueChange={setEvidenceRef} />
    <Textarea label="Review report reason" value={reason} maxLength={500} isDisabled={frozen} onValueChange={setReason} />
    <label className="block text-sm">Administrator action reported
      <select aria-label="Administrator action reported" value={action} disabled={frozen} onChange={event => setAction(event.target.value as Action)}
        className="mt-1 block w-full rounded border border-gray-300 bg-white p-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
        <option value="NOT_REPORTED">No administrator action reported</option>
        <option value="TRASH_REPORTED">Administrator reports moving content to Trash</option>
        <option value="PURGE_REPORTED">Administrator reports permanent deletion</option>
      </select>
    </label>
    {action !== 'NOT_REPORTED' ? <>
      <Input label="Administrator action evidence reference" value={actionRef} maxLength={120} isDisabled={frozen} onValueChange={setActionRef} />
      <label className="block text-sm">Reported action time (your local time)<input aria-label="Reported administrator action time" type="datetime-local"
        value={actionAt} disabled={frozen} onChange={event => { const value = event.target.value; setActionAt(value);
          setActionTimeAllowed(Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now()); }} className="mt-1 block w-full rounded border p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100" /></label>
    </> : null}
    <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={frozen}>I reviewed these references; this report is not a disposal instruction.</Checkbox>
    <Button size="sm" variant="flat" isDisabled={frozen || !valid || !confirmed} isLoading={state === 'SAVING'} onPress={() => void save()}>Save review report</Button>
    {state === 'UNKNOWN' ? <div className="space-y-2"><p role="status">Report outcome needs reconciliation.</p>
      <Button size="sm" variant="flat" isLoading={lookingUp} isDisabled={lookingUp} onPress={() => void lookup()}>Look up original report receipt</Button></div> : null}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {review ? <Receipt review={review} /> : null}
  </section>;
}
