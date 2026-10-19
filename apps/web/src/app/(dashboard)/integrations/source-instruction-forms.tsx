'use client';

import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { Button, Checkbox, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';

import { sourceIdentifierPattern as idPattern, sourceEvidencePattern as evidence, validInstructionState, validSourceFollowup,
  type SourceInstructionState, type SourceFollowup } from '@/lib/confluence-source-instructions';
export function InstructionSummary({ state }: { state: SourceInstructionState }) {
  const i = state.instruction;
  return <div className="space-y-1 break-words text-sm">
    <p>Instruction {i.id} · {state.withdrawal ? 'Withdrawn' : 'Recorded assessment'}</p>
    <p>Site {i.citation.cloudId} · page {i.citation.pageId} · cited version {i.citation.pageVersion}.</p>
    <p>Intended action: {i.input.action === 'TRASH' ? 'recoverable Trash' : 'permanent purge'}. Administrator reference: {i.input.administratorRef}.</p>
    <p>Authority evidence: {i.input.authorityEvidenceRef}. Retention and hold assessment: {i.input.retentionEvidenceRef}.</p>
    <p>Recorded {new Date(i.recordedAt).toLocaleString('en-IE')} by {i.actorUserId}. Follow-up target {new Date(i.input.followUpAt).toLocaleString('en-IE')}.</p>
    <p>{i.input.reason} Evidence: {i.input.evidenceRef}.</p>
    {state.withdrawal ? <p>Withdrawal {state.withdrawal.id}: {state.withdrawal.input.reason} Evidence: {state.withdrawal.input.evidenceRef}.</p> : null}
    <p>This records an Owner assessment. It does not establish legal disposal authority, notify the administrator or change Confluence.</p>
  </div>;
}
export function FollowupSummary({ report }: { report: SourceFollowup }) {
  return <div role="status" className="space-y-1 break-words text-sm">
    <p>Historical follow-up {report.id} · instruction {report.instructionId}.</p>
    <p>Instruction at report: {report.instructionStateAtReport === 'WITHDRAWN' ? 'withdrawn' : 'recorded assessment'}.</p>
    <p>Operator report: {report.input.actionReport.replaceAll('_', ' ').toLowerCase()}. Evidence: {report.input.evidenceRef}.</p>
    {report.input.actionEvidenceRef ? <p>Reported action evidence {report.input.actionEvidenceRef}, time {report.input.actionReportedAt}.</p> : null}
    <p>Provider observation: {report.observation.status}. Checked {new Date(report.observation.checkedAt).toLocaleString('en-IE')}.</p>
    <p>Not observed can mean absence or restricted access. This saved report does not establish current state or authorise action. Attachments, earlier versions, backups and permanent erasure remain unverified.</p>
  </div>;
}

type Props = { actorId: string; onRecorded?: () => void } & (
  { kind: 'ISSUE'; referenceId: string; targetDigest: string; state?: never }
  | { kind: 'WITHDRAW' | 'FOLLOWUP'; state: SourceInstructionState; referenceId?: never; targetDigest?: never });
type Phase = 'READY' | 'SAVING' | 'UNKNOWN' | 'SAVED';
const buttonClass = 'h-auto max-w-full whitespace-normal break-words py-2';
export function SourceDecisionForm(props: Props) {
  const [requestId, setRequestId] = useState(''), [values, setValues] = useState<Record<string, string>>({});
  const [action, setAction] = useState('TRASH'), [reportedAction, setReportedAction] = useState('NOT_REPORTED');
  const [confirmed, setConfirmed] = useState(false), [phase, setPhase] = useState<Phase>('READY'), [error, setError] = useState('');
  const [savedState, setSavedState] = useState<SourceInstructionState | null>(null), [report, setReport] = useState<SourceFollowup | null>(null);
  const inFlight = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const get = (key: string) => values[key] || '';
  const frozen = phase !== 'READY';
  const accept = (data: { state?: SourceInstructionState; report?: SourceFollowup }) => {
    if (props.kind === 'FOLLOWUP') {
      const value = data.report;
      if (!value || !validSourceFollowup(value) || value.clientRequestId !== requestId || value.actorUserId !== props.actorId
        || value.instructionId !== props.state.instruction.id || value.instructionDigest !== props.state.instruction.inputDigest) throw new Error('Unbound report receipt');
      setReport(value);
    } else {
      const value = data.state;
      if (!value || !validInstructionState(value) || (props.kind === 'ISSUE'
        ? value.instruction.clientRequestId !== requestId || value.instruction.actorUserId !== props.actorId
          || value.instruction.referenceId !== props.referenceId || value.instruction.input.expectedTargetDigest !== props.targetDigest
        : value.instruction.id !== props.state.instruction.id || value.withdrawal?.clientRequestId !== requestId
          || value.withdrawal.actorUserId !== props.actorId)) throw new Error('Unbound instruction receipt');
      setSavedState(value);
    }
    setPhase('SAVED'); props.onRecorded?.();
  };
  const save = async () => {
    if (inFlight.current || phase !== 'READY' || !confirmed) return;
    setError('');
    const reason = get('reason').trim();
    if (!evidence.test(get('evidenceRef')) || Array.from(reason).length < 10 || Array.from(reason).length > 500
      || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) { setError('Give a controlled evidence reference and a reason of 10–500 characters without control characters.'); return; }
    let path: string, body: Record<string, unknown> = { clientRequestId: requestId, evidenceRef: get('evidenceRef'), reason };
    if (props.kind === 'ISSUE') {
      if (!['authorityEvidenceRef', 'retentionEvidenceRef', 'administratorRef'].every(key => evidence.test(get(key)))
        || !Number.isFinite(Date.parse(get('followUpAt'))) || Date.parse(get('followUpAt')) <= Date.now()) {
        setError('Review all three controlled references and choose a future follow-up target.'); return;
      }
      path = `/integrations/confluence/references/by-id/${props.referenceId}/instructions`;
      body = { ...body, expectedTargetDigest: props.targetDigest, action, authorityEvidenceRef: get('authorityEvidenceRef'),
        retentionEvidenceRef: get('retentionEvidenceRef'), administratorRef: get('administratorRef'),
        followUpAt: new Date(get('followUpAt')).toISOString(), assessmentConfirmed: true };
    } else {
      const i = props.state.instruction;
      path = `/integrations/confluence/source-instructions/${i.id}/${props.kind === 'WITHDRAW' ? 'withdraw' : 'followups'}`;
      body.expectedInstructionDigest = i.inputDigest;
      if (props.kind === 'FOLLOWUP') {
        if (!idPattern.test(get('controlPageId')) || get('controlPageId') === i.citation.pageId) { setError('Enter a different accessible current control page ID.'); return; }
        const actionTime = Date.parse(get('actionReportedAt'));
        if (reportedAction !== 'NOT_REPORTED' && (!evidence.test(get('actionEvidenceRef')) || !Number.isFinite(actionTime)
          || actionTime < Date.parse(i.recordedAt) || actionTime > Date.now())) {
          setError('A reported action needs evidence and a time between the instruction and now.'); return;
        }
        body = { ...body, expectedTargetDigest: i.input.expectedTargetDigest, controlPageId: get('controlPageId'), actionReport: reportedAction,
          actionEvidenceRef: reportedAction === 'NOT_REPORTED' ? null : get('actionEvidenceRef'),
          actionReportedAt: reportedAction === 'NOT_REPORTED' ? null : new Date(actionTime).toISOString(), evidenceReviewed: true };
      }
    }
    inFlight.current = true; setPhase('SAVING');
    try {
      const { data } = await api.post(path, body, { timeout: 60000, skipAuthRefresh: true });
      if (active.current) accept(data);
    } catch (cause) { if (active.current) {
      const refused = isAxiosError(cause) && cause.response && cause.response.status >= 400 && cause.response.status < 500;
      setPhase(refused ? 'READY' : 'UNKNOWN');
      if (refused) { setConfirmed(false); setRequestId(crypto.randomUUID()); }
      setError(apiErrorMessage(cause, refused ? 'Request refused. Review and confirm the fields again.' : 'Outcome unknown. Look up the original receipt before a new decision.'));
    } } finally { inFlight.current = false; }
  };
  const lookup = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setError('');
    try {
      const path = props.kind === 'FOLLOWUP' ? `/integrations/confluence/source-followups/${requestId}`
        : `/integrations/confluence/source-instructions/${props.kind === 'ISSUE' ? requestId : props.state.instruction.id}`;
      const { data } = await api.get(path, { timeout: 60000, skipAuthRefresh: true });
      if (active.current) accept(data);
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'The original receipt is not confirmed. A missing response does not prove the save failed.')); }
    finally { inFlight.current = false; }
  };
  const title = props.kind === 'ISSUE' ? 'source instruction' : props.kind === 'WITHDRAW' ? 'instruction withdrawal' : 'instruction follow-up';
  const Heading = props.kind === 'ISSUE' ? 'h5' : 'h3';
  if (!requestId) return <Button className={buttonClass} size="sm" variant="flat" onPress={() => setRequestId(crypto.randomUUID())}>Prepare {title}</Button>;
  const field = (key: string, label: string) => <Input key={key} label={label} value={get(key)} maxLength={120} isDisabled={frozen}
    onValueChange={value => setValues(previous => ({ ...previous, [key]: value }))} />;
  return <section aria-label={`Confluence ${title}`} className="min-w-0 space-y-3 rounded border border-gray-300 p-3 text-gray-900 dark:border-gray-600 dark:text-gray-100">
    <Heading className="font-medium">Record {title}</Heading>
    <p className="break-all text-sm">Original request reference: {requestId}</p>
    <p className="text-sm">Keep this reference for reconciliation. Recording does not notify anyone, grant access or change Confluence.</p>
    {props.kind !== 'ISSUE' ? <InstructionSummary state={props.state} /> : <p className="break-all text-sm">Exact citation {props.referenceId}. Reviewed target {props.targetDigest}.</p>}
    {props.kind === 'ISSUE' ? <>
      <label className="block text-sm">Intended administrator action<select aria-label="Intended administrator action" value={action} disabled={frozen}
        onChange={event => setAction(event.target.value)} className="mt-1 block w-full rounded border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <option value="TRASH">Move to recoverable Trash</option><option value="PURGE">Permanently purge</option>
      </select></label>
      {field('authorityEvidenceRef', 'Authority evidence reference')}{field('retentionEvidenceRef', 'Retention and hold assessment reference')}{field('administratorRef', 'Administrator archive reference')}
      <label className="block text-sm">Follow-up target (your local time)<input aria-label="Instruction follow-up target" type="datetime-local" value={get('followUpAt')}
        disabled={frozen} onChange={event => setValues(previous => ({ ...previous, followUpAt: event.target.value }))}
        className="mt-1 block w-full min-w-0 max-w-full rounded border p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100" /></label>
    </> : null}
    {props.kind === 'FOLLOWUP' ? <>
      {field('controlPageId', 'Follow-up control page ID')}
      <label className="block text-sm">Administrator action reported<select aria-label="Instruction action reported" value={reportedAction} disabled={frozen}
        onChange={event => setReportedAction(event.target.value)} className="mt-1 block w-full rounded border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <option value="NOT_REPORTED">No administrator action reported</option><option value="TRASH_REPORTED">Administrator reports moving to Trash</option><option value="PURGE_REPORTED">Administrator reports permanent deletion</option>
      </select></label>
      {reportedAction !== 'NOT_REPORTED' ? <>{field('actionEvidenceRef', 'Follow-up action evidence reference')}
        <label className="block text-sm">Reported action time (your local time)<input aria-label="Instruction reported action time" type="datetime-local" value={get('actionReportedAt')}
          disabled={frozen} onChange={event => setValues(previous => ({ ...previous, actionReportedAt: event.target.value }))}
          className="mt-1 block w-full min-w-0 max-w-full rounded border p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100" /></label></> : null}
    </> : null}
    {field('evidenceRef', 'Decision or report evidence reference')}
    <Textarea label="Decision or report reason" value={get('reason')} maxLength={500} isDisabled={frozen}
      onValueChange={value => setValues(previous => ({ ...previous, reason: value }))} />
    <Checkbox className="m-0 max-w-full items-start p-0" classNames={{ label: 'min-w-0 whitespace-normal break-words', wrapper: 'mt-0.5 shrink-0' }}
      isSelected={confirmed} isDisabled={frozen} onValueChange={setConfirmed}>I reviewed the exact target and these evidence references.</Checkbox>
    <Button className={buttonClass} size="sm" variant="flat" isDisabled={frozen || !confirmed} isLoading={phase === 'SAVING'} onPress={() => void save()}>Save {title}</Button>
    {phase === 'UNKNOWN' ? <><p role="status">Outcome needs reconciliation. Fields remain frozen.</p>
      <Button className={buttonClass} size="sm" variant="flat" onPress={() => void lookup()}>Look up original {title} receipt</Button></> : null}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {savedState ? <div role="status"><p>{props.kind === 'ISSUE' ? 'Instruction recorded.' : 'Instruction withdrawal recorded.'}</p><InstructionSummary state={savedState} /></div> : null}
    {report ? <FollowupSummary report={report} /> : null}
    {phase === 'SAVED' && props.kind === 'FOLLOWUP' ? <Button className={buttonClass} size="sm" variant="flat" onPress={() => {
      setRequestId(''); setValues({}); setConfirmed(false); setReport(null); setError(''); setPhase('READY');
    }}>Prepare another instruction follow-up</Button> : null}
  </section>;
}

export function SourceInstructionForm({ referenceId, targetDigest }: { referenceId: string; targetDigest: string }) {
  const { user } = useAuth();
  if (user?.role !== 'OWNER') return null;
  return <SourceDecisionForm key={`${user.id}:${referenceId}:${targetDigest}`} kind="ISSUE" actorId={user.id} referenceId={referenceId} targetDigest={targetDigest} />;
}
