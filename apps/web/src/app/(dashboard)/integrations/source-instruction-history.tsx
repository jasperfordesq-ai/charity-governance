'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { AppSection } from '@/components/ui/app-page';
import { sourceIdentifierPattern, validInstructionState, validSourceFollowup,
  type SourceInstructionState, type SourceFollowup } from '@/lib/confluence-source-instructions';
import { SourceDecisionForm, InstructionSummary, FollowupSummary } from './source-instruction-forms';
const buttonClass = 'h-auto max-w-full whitespace-normal break-words py-2';

function FollowupHistory({ state, actorId, onChanged }: { state: SourceInstructionState; actorId: string; onChanged: () => void }) {
  const [reports, setReports] = useState<SourceFollowup[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = async (before?: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const { data } = await api.get<{ items: SourceFollowup[]; nextCursor: string | null }>(
        `/integrations/confluence/source-instructions/${state.instruction.id}/followups`, { params: before ? { before } : undefined });
      if (!Array.isArray(data.items) || data.items.some(item => !validSourceFollowup(item) || item.instructionId !== state.instruction.id)
        || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !sourceIdentifierPattern.test(data.nextCursor)))) throw new Error('Unbound follow-up history');
      if (active.current) { setReports(previous => before ? [...previous, ...data.items] : data.items); setCursor(data.nextCursor); }
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'Saved follow-up reports could not be verified.')); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return <div className="mt-3 space-y-3 border-t border-gray-300 pt-3 dark:border-gray-600">
    {!state.withdrawal ? <SourceDecisionForm kind="WITHDRAW" actorId={actorId} state={state} onRecorded={onChanged} /> : null}
    <p className="text-sm">A new provider observation needs the local citation to remain available. Saved reports remain readable after unciting or disconnecting.</p>
    <SourceDecisionForm kind="FOLLOWUP" actorId={actorId} state={state} />
    <Button className={buttonClass} size="sm" variant="flat" isLoading={busy} onPress={() => void load()}>Read saved instruction follow-ups</Button>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    <ol className="space-y-3">{reports.map(report => <li key={report.id} className="rounded border p-3"><FollowupSummary report={report} /></li>)}</ol>
    {cursor ? <Button className={buttonClass} size="sm" variant="flat" isDisabled={busy} onPress={() => void load(cursor)}>Load more instruction follow-ups</Button> : null}
  </div>;
}

function OwnerInstructionHistory({ actorId }: { actorId: string }) {
  const [items, setItems] = useState<SourceInstructionState[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reference, setReference] = useState(''), [lookupKind, setLookupKind] = useState('instruction');
  const [lookedUp, setLookedUp] = useState<SourceInstructionState | null>(null), [report, setReport] = useState<SourceFollowup | null>(null);
  const active = useRef(true), inFlight = useRef(false);
  const load = useCallback(async (before?: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const { data } = await api.get<{ items: SourceInstructionState[]; nextCursor: string | null }>(
        '/integrations/confluence/source-instructions', { params: before ? { before } : undefined });
      if (!Array.isArray(data.items) || data.items.some(item => !validInstructionState(item))
        || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !sourceIdentifierPattern.test(data.nextCursor)))) throw new Error('Unbound instruction history');
      if (active.current) { setItems(previous => before ? [...previous, ...data.items] : data.items); setCursor(data.nextCursor); }
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'Source instruction history could not be verified.')); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }, []);
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, [load]);
  const lookup = async () => {
    if (inFlight.current || !sourceIdentifierPattern.test(reference)) return;
    inFlight.current = true; setBusy(true); setError(''); setLookedUp(null); setReport(null);
    try {
      if (lookupKind === 'instruction') {
        const { data } = await api.get<{ state: SourceInstructionState }>(`/integrations/confluence/source-instructions/${reference}`);
        if (!validInstructionState(data.state) || ![data.state.instruction.id, data.state.instruction.clientRequestId].includes(reference)) throw new Error('Unbound original instruction');
        if (active.current) setLookedUp(data.state);
      } else {
        const { data } = await api.get<{ report: SourceFollowup }>(`/integrations/confluence/source-followups/${reference}`);
        if (!validSourceFollowup(data.report) || ![data.report.id, data.report.clientRequestId].includes(reference)) throw new Error('Unbound original follow-up');
        if (active.current) setReport(data.report);
      }
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'The original source receipt could not be verified.')); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return <section aria-label="Source instructions and follow-up"><AppSection title="Source instructions and follow-up" description="Owner-recorded assessments for exact cited Confluence pages. The history remains available after a local citation is removed. It does not establish legal disposal authority or prove erasure.">
    <Button className={buttonClass} size="sm" variant="flat" isLoading={busy} onPress={() => void load()}>Refresh source instructions</Button>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {!busy && items.length === 0 ? <p className="mt-3 text-sm">No source instructions are recorded.</p> : null}
    <ol className="mt-3 space-y-3">{items.map(state => <li key={state.instruction.id} className="rounded border border-gray-300 p-3 text-gray-900 dark:border-gray-600 dark:text-gray-100">
      <InstructionSummary state={state} />
      <Button className={`mt-2 ${buttonClass}`} size="sm" variant="flat" onPress={() => setExpanded(previous => previous === state.instruction.id ? null : state.instruction.id)}>Review instruction</Button>
      {expanded === state.instruction.id ? <FollowupHistory key={state.instruction.id} state={state} actorId={actorId} onChanged={() => void load()} /> : null}
    </li>)}</ol>
    {cursor ? <Button className={`mt-3 ${buttonClass}`} size="sm" variant="flat" isDisabled={busy} onPress={() => void load(cursor)}>Load more source instructions</Button> : null}
    <section aria-label="Historical source receipt lookup" className="mt-4 space-y-3 rounded border p-3 text-gray-900 dark:text-gray-100">
      <p className="text-sm">Use an original request reference or audit event ID. This reads saved history without contacting Confluence.</p>
      <label className="block text-sm">Source receipt type<select aria-label="Source receipt type" value={lookupKind} disabled={busy}
        onChange={event => { setLookupKind(event.target.value); setLookedUp(null); setReport(null); }}
        className="mt-1 block w-full rounded border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <option value="instruction">Instruction</option><option value="followup">Follow-up report</option>
      </select></label>
      <Input label="Source instruction or follow-up reference" value={reference} isDisabled={busy}
        onValueChange={value => { setReference(value); setLookedUp(null); setReport(null); }} />
      <Button className={buttonClass} size="sm" variant="flat" isLoading={busy} isDisabled={busy || !sourceIdentifierPattern.test(reference)} onPress={() => void lookup()}>Read source receipt</Button>
      {lookedUp ? <div role="status"><InstructionSummary state={lookedUp} /></div> : null}
      {report ? <FollowupSummary report={report} /> : null}
    </section>
  </AppSection></section>;
}

export function ConfluenceSourceInstructions() {
  const { user } = useAuth();
  return user?.role === 'OWNER' ? <OwnerInstructionHistory key={user.id} actorId={user.id} /> : null;
}
