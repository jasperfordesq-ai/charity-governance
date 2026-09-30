'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, SelectItem, Textarea } from '@heroui/react';
import type { RiskRecordResponse } from '@charitypilot/shared';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { statusPanelClassName } from '@/components/ui/status';
import { riskReviewAttention } from './risk-review-attention';
import { activeVerifiedClaimIds, riskClaimRevisionCue } from './risk-claim-revision';

type RiskAudit = {
  id: string; riskId: string; actorUserId: string | null; action: string;
  beforeState: unknown; afterState: unknown; occurredAt: string;
};
type RiskVerification = {
  id: string; riskId: string; actorUserId: string; controlReference: string;
  state: 'VERIFIED' | 'WITHDRAWN'; verifiedAt: string | null;
  riskRevision?: number | null;
  evidenceReference: string | null; affectedRelease: string | null;
  reason: string; occurredAt: string;
};
type RiskHistory = {
  riskId: string; controlReference: string; riskRevision: number | null;
  events: RiskVerification[]; nextCursor: string | null;
};
type ControlReviewItem = {
  claimId: string; riskId: string; controlReference: string;
  riskRevision: number | null; currentRiskRevision: number;
};
type ControlReviewPage = { items: ControlReviewItem[]; nextCursor: string | null };
type RiskAuditPage = { items: RiskAudit[]; nextCursor: string | null };

const rows = <T,>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && 'data' in value && Array.isArray(value.data)) return value.data as T[];
  return [];
};

function RevisionReviewCue({ claim, currentRiskRevision }: { claim: RiskVerification; currentRiskRevision: number | null }) {
  const cue = riskClaimRevisionCue(claim, currentRiskRevision);
  return cue ? <p className="text-xs text-amber-800 dark:text-amber-300">{cue}</p> : null;
}

export function RiskControlEvidencePanel({ risks }: { risks: RiskRecordResponse[] }) {
  const [audits, setAudits] = useState<RiskAudit[] | null>(null);
  const [auditNextCursor, setAuditNextCursor] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState('');
  const auditRequestId = useRef(0);
  const [verifications, setVerifications] = useState<RiskVerification[] | null>(null);
  const [riskHistory, setRiskHistory] = useState<RiskHistory | null>(null);
  const [controlReview, setControlReview] = useState<ControlReviewPage | null>(null);
  const [controlReviewBusy, setControlReviewBusy] = useState(false);
  const [controlReviewError, setControlReviewError] = useState('');
  const controlReviewRequestId = useRef(0);
  const [historyReference, setHistoryReference] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [riskId, setRiskId] = useState('');
  const [controlReference, setControlReference] = useState('');
  const [state, setState] = useState<'VERIFIED' | 'WITHDRAWN'>('VERIFIED');
  const [verifiedDate, setVerifiedDate] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [affectedRelease, setAffectedRelease] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadControlReview = useCallback(async (after?: string) => {
    const requestId = ++controlReviewRequestId.current;
    setControlReviewBusy(true);
    setControlReviewError('');
    if (!after) setControlReview(null);
    try {
      const response = await api.get('/governance-registers/risks/control-review-attention', {
        params: after ? { after } : {},
      });
      const page = response.data as ControlReviewPage;
      if (requestId !== controlReviewRequestId.current) return;
      const items = rows<ControlReviewItem>(page?.items);
      const nextCursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
      setControlReview((current) => {
        if (!after || !current) return { items, nextCursor };
        const seen = new Set(current.items.map((item) => item.claimId));
        return { items: [...current.items, ...items.filter((item) => !seen.has(item.claimId))], nextCursor };
      });
    } catch (cause) {
      if (requestId === controlReviewRequestId.current) {
        setControlReviewError(apiErrorMessage(cause, 'Control review attention could not be loaded.'));
      }
    } finally {
      if (requestId === controlReviewRequestId.current) setControlReviewBusy(false);
    }
  }, []);

  // A risk edit changes the revision against which a verification is judged.
  // The parent replaces this array after a register reload, so refresh the
  // attention list even when no new verification was submitted here.
  useEffect(() => { void loadControlReview(); }, [loadControlReview, risks]);

  const load = async () => {
    const requestId = ++auditRequestId.current;
    setBusy(true);
    setAuditBusy(false);
    setError('');
    try {
      const [auditResponse, verificationResponse] = await Promise.all([
        api.get('/governance-registers/risks/audit'),
        api.get('/governance-registers/risks/control-verifications'),
      ]);
      const page = auditResponse.data as RiskAuditPage;
      if (requestId !== auditRequestId.current) return;
      setAudits(rows<RiskAudit>(page?.items));
      setAuditNextCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : null);
      setAuditError('');
      setVerifications(rows<RiskVerification>(verificationResponse.data));
    } catch (cause) {
      if (requestId === auditRequestId.current) {
        setAudits(null);
        setAuditNextCursor(null);
        setVerifications(null);
        setError(apiErrorMessage(cause, 'Risk history could not be loaded.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const loadOlderAudits = async () => {
    if (!auditNextCursor) return;
    const requestId = ++auditRequestId.current;
    const before = auditNextCursor;
    setAuditBusy(true);
    setAuditError('');
    try {
      const response = await api.get('/governance-registers/risks/audit', { params: { before } });
      const page = response.data as RiskAuditPage;
      if (requestId !== auditRequestId.current) return;
      const incoming = rows<RiskAudit>(page?.items);
      setAudits((current) => {
        const seen = new Set((current ?? []).map((item) => item.id));
        return [...(current ?? []), ...incoming.filter((item) => !seen.has(item.id))];
      });
      setAuditNextCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : null);
    } catch (cause) {
      if (requestId === auditRequestId.current) {
        setAuditError(apiErrorMessage(cause, 'Older risk changes could not be loaded.'));
      }
    } finally {
      if (requestId === auditRequestId.current) setAuditBusy(false);
    }
  };

  const loadRiskHistory = async (before?: string) => {
    if (!riskId) return;
    const selectedRiskId = riskId;
    const selectedReference = historyReference.trim();
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const response = await api.get(`/governance-registers/risks/${encodeURIComponent(selectedRiskId)}/control-verifications`, {
        params: {
          ...(selectedReference ? { controlReference: selectedReference } : {}),
          ...(before ? { before } : {}),
        },
      });
      const page = response.data as { events?: unknown; nextCursor?: unknown; riskRevision?: unknown } | undefined;
      const events = rows<RiskVerification>(page?.events);
      const nextCursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
      const riskRevision = typeof page?.riskRevision === 'number' ? page.riskRevision : null;
      setRiskHistory((current) => {
        if (!before || current?.riskId !== selectedRiskId || current.controlReference !== selectedReference) {
          return { riskId: selectedRiskId, controlReference: selectedReference, riskRevision, events, nextCursor };
        }
        const seen = new Set(current.events.map((event) => event.id));
        return { ...current, riskRevision, events: [...current.events, ...events.filter((event) => !seen.has(event.id))], nextCursor };
      });
    } catch (cause) {
      setHistoryError(apiErrorMessage(cause, 'This risk’s control history could not be loaded.'));
    } finally {
      setHistoryBusy(false);
    }
  };

  const save = async () => {
    if (!riskId || controlReference.trim().length < 2 || reason.trim().length < 10 ||
      (state === 'VERIFIED' && (!verifiedDate || evidenceReference.trim().length < 3))) {
      setError('Choose a risk and control, then provide a reason and dated evidence for a verification.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/governance-registers/risks/${encodeURIComponent(riskId)}/control-verifications`, {
        state, controlReference: controlReference.trim(), reason: reason.trim(),
        ...(affectedRelease.trim() ? { affectedRelease: affectedRelease.trim() } : {}),
        ...(state === 'VERIFIED' ? {
          verifiedAt: `${verifiedDate}T00:00:00.000Z`, evidenceReference: evidenceReference.trim(),
        } : {}),
      });
      setReason('');
      await load();
      if (riskHistory?.riskId === riskId) await loadRiskHistory();
      await loadControlReview();
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Control evidence could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const riskName = (id: string) => risks.find((risk) => risk.id === id)?.title ?? `Deleted risk ${id}`;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const reviewAttention = riskReviewAttention(risks, today);
  const activeClaimIds = activeVerifiedClaimIds(riskHistory?.events ?? []);
  return (
    <section className={statusPanelClassName('neutral', 'p-5')} aria-label="Risk and control evidence">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Risk changes and control evidence</h2>
          <p className="text-sm">Append-only history records risk edits and dated control claims. A recorded claim still needs its cited source reviewed.</p>
        </div>
        <Button size="sm" variant="flat" onPress={load} isLoading={busy} isDisabled={auditBusy}>Load history</Button>
      </div>
      <div className="mt-4 rounded border p-3" aria-label="Risk review attention">
        <h3 className="font-medium">Risk reviews to check</h3>
        <p className="text-sm">{reviewAttention.due.length} due or past due · {reviewAttention.unscheduled.length} without a review date. A due date prompts review; it does not establish whether a control passed or failed.</p>
        <div className="mt-3 border-t pt-3" aria-label="Control claims needing review">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-medium">Control claims needing evidence review</h4>
            <Button size="sm" variant="flat" onPress={() => void loadControlReview()} isLoading={controlReviewBusy}>Refresh</Button>
          </div>
          <p className="text-xs">Latest active claims are checked against the current risk revision when this page loads. A mismatch or unknown older revision prompts review; it does not declare a control invalid.</p>
          {controlReviewError ? <p role="alert" className="mt-2 text-sm text-red-700">{controlReviewError}</p> : null}
          {controlReview?.items.length === 0 ? <p className="mt-2 text-sm">No active control claim currently needs revision review.</p> : null}
          {controlReview && controlReview.items.length > 0 ? <ul className="mt-2 list-inside list-disc text-sm">
            {controlReview.items.map((item) => <li key={item.claimId}>
              {risks.find((risk) => risk.id === item.riskId)?.title ?? `Risk ${item.riskId}`} · {item.controlReference} · {item.riskRevision === null ? 'older claim with unknown revision' : item.riskRevision < item.currentRiskRevision ? `record changed after revision ${item.riskRevision}` : 'risk revision mismatch'}
            </li>)}
          </ul> : null}
          {controlReview?.nextCursor ? <Button className="mt-2" size="sm" variant="flat" onPress={() => void loadControlReview(controlReview.nextCursor!)} isLoading={controlReviewBusy} isDisabled={controlReviewBusy}>Load more claims</Button> : null}
        </div>
        {reviewAttention.due.length > 0 ? <ul className="mt-2 list-inside list-disc text-sm">
          {reviewAttention.due.slice(0, 10).map((risk) => <li key={risk.id}>{risk.title} · review date {risk.reviewDate!.slice(0, 10)}</li>)}
        </ul> : null}
        {reviewAttention.due.length > 10 ? <p className="text-xs">Showing the first 10 due reviews. See the Risk register for the full list.</p> : null}
        <p className="mt-2 text-xs">Use Edit in the Risk register to update the review date and wording. Record any verified control with its date, actor and evidence reference below.</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Select label="Risk" selectedKeys={riskId ? new Set([riskId]) : new Set()} onSelectionChange={(keys) => {
          const value = Array.from(keys)[0];
          setRiskId(value ? String(value) : '');
          setRiskHistory(null);
          setHistoryError('');
        }}>
          {risks.map((risk) => <SelectItem key={risk.id}>{risk.title}</SelectItem>)}
        </Select>
        <Input label="Control reference" value={controlReference} onValueChange={setControlReference} description="Use the same reference for later withdrawal or reverification." />
        <Select label="Evidence state" selectedKeys={new Set([state])} onSelectionChange={(keys) => {
          const value = Array.from(keys)[0];
          if (value === 'VERIFIED' || value === 'WITHDRAWN') setState(value);
        }}>
          <SelectItem key="VERIFIED">Record verification</SelectItem>
          <SelectItem key="WITHDRAWN">Withdraw verification</SelectItem>
        </Select>
        {state === 'VERIFIED' ? <Input type="date" label="Verified on" value={verifiedDate} onValueChange={setVerifiedDate} /> : null}
        {state === 'VERIFIED' ? <Input label="Evidence reference" value={evidenceReference} onValueChange={setEvidenceReference} description="Reference the controlled evidence; do not paste secrets or personal records." /> : null}
        <Input label="Affected release" value={affectedRelease} onValueChange={setAffectedRelease} />
      </div>
      <Textarea className="mt-3" label="Reason" value={reason} onValueChange={setReason} />
      <Button className="mt-3" onPress={save} isDisabled={busy || risks.length === 0} isLoading={busy}>Record control evidence</Button>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}

      <div className="mt-6 rounded border p-3" aria-label="Selected risk control history">
        <h3 className="font-medium">Review one risk’s retained control evidence</h3>
        <p className="text-sm">Select a risk above. An exact control reference can narrow its history. An absent claim in the recent charity-wide list below does not mean the control was never verified.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Input className="min-w-48 flex-1" label="Control reference filter (optional)" value={historyReference} onValueChange={(value) => {
            setHistoryReference(value);
            setRiskHistory(null);
          }} />
          <Button size="sm" variant="flat" onPress={() => void loadRiskHistory()} isDisabled={!riskId || historyBusy} isLoading={historyBusy}>Load this risk’s history</Button>
        </div>
        {historyError ? <p role="alert" className="mt-2 text-sm text-red-700">{historyError}</p> : null}
        {riskHistory?.riskId === riskId && riskHistory.controlReference === historyReference.trim() ? <div className="mt-3">
          <p className="text-xs">{riskHistory.controlReference ? `Exact reference: ${riskHistory.controlReference}. ` : ''}Showing {riskHistory.events.length} retained claim{riskHistory.events.length === 1 ? '' : 's'} for {riskName(riskId)}.</p>
          {riskHistory.events.length === 0 ? <p className="mt-2 text-sm">No matching retained claim was found.</p> : <ol className="mt-2 space-y-2 text-sm">{riskHistory.events.map((item) => <li key={item.id} className="rounded border p-3">
            <strong>{item.controlReference} · {item.state}</strong>
            <p>{item.reason}</p>
            {activeClaimIds.has(item.id) ? <RevisionReviewCue claim={item} currentRiskRevision={riskHistory.riskRevision} /> : null}
            <p className="text-xs">Verified {item.verifiedAt?.slice(0, 10) ?? 'withdrawn'} · Evidence {item.evidenceReference ?? 'not applicable'} · Release {item.affectedRelease ?? 'not recorded'} · Actor {item.actorUserId} · Recorded {new Date(item.occurredAt).toLocaleString('en-IE')}</p>
          </li>)}</ol>}
          {riskHistory.nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void loadRiskHistory(riskHistory.nextCursor!)} isLoading={historyBusy} isDisabled={historyBusy}>Load older claims</Button> : null}
        </div> : null}
      </div>

      {verifications ? <div className="mt-6">
        <h3 className="font-medium">Recent control evidence across the charity (up to 100)</h3>
        {verifications.length === 0 ? <p className="text-sm">No control evidence recorded.</p> : (
          <ol className="mt-2 space-y-2 text-sm">{verifications.map((item) => <li key={item.id} className="rounded border p-3">
            <strong>{riskName(item.riskId)} · {item.controlReference} · {item.state}</strong>
            <p>{item.reason}</p>
            <p className="text-xs">Verified {item.verifiedAt?.slice(0, 10) ?? 'withdrawn'} · Evidence {item.evidenceReference ?? 'not applicable'} · Release {item.affectedRelease ?? 'not recorded'} · Actor {item.actorUserId} · Recorded {new Date(item.occurredAt).toLocaleString('en-IE')}</p>
          </li>)}</ol>
        )}
      </div> : null}
      {audits ? <div className="mt-6">
        <h3 className="font-medium">Recent risk changes</h3>
        <p className="text-xs">Showing {audits.length} retained change{audits.length === 1 ? '' : 's'}. Load older pages for the detailed before and after record.</p>
        {audits.length === 0 ? <p className="text-sm">No risk changes recorded since this audit was introduced.</p> : (
          <ol className="mt-2 space-y-2 text-sm">{audits.map((item) => <li key={item.id} className="rounded border p-3">
            <strong>{item.action} · {riskName(item.riskId)}</strong>
            <p className="text-xs">Actor {item.actorUserId ?? 'not recorded'} · {new Date(item.occurredAt).toLocaleString('en-IE')}</p>
            <details className="mt-2"><summary>Inspect retained before and after record</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ before: item.beforeState, after: item.afterState }, null, 2)}</pre>
            </details>
          </li>)}</ol>
        )}
        {auditError ? <p role="alert" className="mt-2 text-sm text-red-700">{auditError}</p> : null}
        {auditNextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void loadOlderAudits()} isLoading={auditBusy} isDisabled={busy || auditBusy}>Load older risk changes</Button> : null}
      </div> : null}
    </section>
  );
}
