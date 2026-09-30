'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

type Area = 'ACCOUNT_AUTH' | 'GOVERNANCE_RECORDS' | 'VAULT_FILES' | 'EXTERNAL_COPIES'
  | 'EXPORTS' | 'AUDIT_LOGS' | 'BACKUPS' | 'BILLING_PROVIDER';
type Disposition = 'IN_SCOPE' | 'NEEDS_FOLLOW_UP' | 'NOT_APPLICABLE';
type Event = {
  id: string; area: Area; disposition: Disposition; actorUserId: string;
  reason: string; evidenceRef: string | null; occurredAt: string;
};
type Coverage = { area: Area; latest: Event | null };
type EventPage = { items: Event[]; nextCursor: string | null };

const labels: Record<Area, string> = {
  ACCOUNT_AUTH: 'Accounts and authentication',
  GOVERNANCE_RECORDS: 'Governance records and registers',
  VAULT_FILES: 'Vault files and primary storage',
  EXTERNAL_COPIES: 'Integrations, Confluence and provider mail',
  EXPORTS: 'Reports, downloads and temporary files',
  AUDIT_LOGS: 'Audit trails and operational logs',
  BACKUPS: 'Database, object and recovery backups',
  BILLING_PROVIDER: 'Billing and payment provider',
};
const outcomes: Record<Disposition, string> = {
  IN_SCOPE: 'In scope for assessment',
  NEEDS_FOLLOW_UP: 'Needs follow-up',
  NOT_APPLICABLE: 'Assessed as not applicable',
};
const evidencePattern = /^[A-Z0-9][A-Z0-9-]{2,119}$/;

export function DataLifecycleCoverage({ requestId }: { requestId: string }) {
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [history, setHistory] = useState<Event[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [area, setArea] = useState<Area>('ACCOUNT_AUTH');
  const [disposition, setDisposition] = useState<Disposition>('NEEDS_FOLLOW_UP');
  const [reason, setReason] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [current, events] = await Promise.all([
      api.get<Coverage[]>(`/data-lifecycle/requests/${requestId}/coverage`),
      api.get<EventPage>(`/data-lifecycle/requests/${requestId}/coverage-events`),
    ]);
    setCoverage(current.data);
    setHistory(events.data.items);
    setNextCursor(events.data.nextCursor);
  }, [requestId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<Coverage[]>(`/data-lifecycle/requests/${requestId}/coverage`),
      api.get<EventPage>(`/data-lifecycle/requests/${requestId}/coverage-events`),
    ]).then(([current, events]) => {
      if (!active) return;
      setCoverage(current.data);
      setHistory(events.data.items);
      setNextCursor(events.data.nextCursor);
    }).catch((cause) => {
      if (active) setError(apiErrorMessage(cause, 'Coverage review could not be loaded.'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requestId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    let recorded = false;
    try {
      await api.post(`/data-lifecycle/requests/${requestId}/coverage`, {
        area, disposition, reason: reason.trim(),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      });
      recorded = true;
      await reload();
      setReason('');
      setEvidenceRef('');
    } catch (cause) {
      setError(recorded
        ? 'Assessment recorded, but the current view could not refresh. Reload this case to see it.'
        : apiErrorMessage(cause, 'Coverage decision could not be recorded.'));
    } finally { setSaving(false); }
  }

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError('');
    try {
      const response = await api.get<EventPage>(
        `/data-lifecycle/requests/${requestId}/coverage-events?before=${encodeURIComponent(nextCursor)}`,
      );
      setHistory((previous) => [...previous, ...response.data.items.filter(
        (item) => !previous.some((known) => known.id === item.id),
      )]);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Older coverage history could not be loaded.'));
    } finally { setLoadingOlder(false); }
  }

  return <section className="mt-8" aria-labelledby="coverage-title">
    <h3 id="coverage-title" className="font-semibold">Data-source coverage review</h3>
    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
      Check each area against the controlled case archive. An unreviewed area stays unreviewed.
      These assessments do not authorise deletion, prove erasure, or close the request.
      Keep names and personal details out of reasons and references.
    </p>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {loading ? <p className="mt-3 text-sm">Loading coverage…</p> : <ul className="mt-3 grid gap-2 md:grid-cols-2">
      {coverage.map((item) => <li key={item.area} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
        <strong>{labels[item.area]}</strong>
        <p>{item.latest ? outcomes[item.latest.disposition] : 'Not reviewed'}</p>
        {item.latest ? <p className="text-xs text-gray-600 dark:text-gray-300">
          Reviewed {new Date(item.latest.occurredAt).toLocaleString('en-IE')}.
        </p> : null}
      </li>)}
    </ul>}
    <form onSubmit={submit} className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="text-sm"><label htmlFor="coverage-source-area">Source area</label>
        <select id="coverage-source-area" className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 dark:border-gray-700 dark:bg-gray-950" value={area}
          onChange={(event) => setArea(event.target.value as Area)}>
          {(Object.keys(labels) as Area[]).map((key) => <option key={key} value={key}>{labels[key]}</option>)}
        </select>
      </div>
      <div className="text-sm"><label htmlFor="coverage-assessment">Assessment</label>
        <select id="coverage-assessment" className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 dark:border-gray-700 dark:bg-gray-950" value={disposition}
          onChange={(event) => setDisposition(event.target.value as Disposition)}>
          {(Object.keys(outcomes) as Disposition[]).map((key) => <option key={key} value={key}>{outcomes[key]}</option>)}
        </select>
      </div>
      <Input label="Reason for assessment" value={reason} onValueChange={setReason} maxLength={500} isRequired
        description="10–500 characters; no personal details." />
      <Input label="Controlled-archive evidence reference (optional)" value={evidenceRef} onValueChange={setEvidenceRef}
        maxLength={120} description="Opaque uppercase reference, not a name or email." />
      <div className="md:col-span-2"><Button type="submit" variant="flat" isLoading={saving}
        isDisabled={saving || reason.trim().length < 10 || reason.trim().length > 500
          || (evidenceRef.trim().length > 0 && !evidencePattern.test(evidenceRef.trim()))}>
        Record coverage assessment
      </Button></div>
    </form>
    <h4 className="mt-5 font-medium">Coverage history</h4>
    {history.length === 0 ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No areas have been assessed.</p> : null}
    <ol className="mt-2 space-y-2">{history.map((item) => <li key={item.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
      <strong>{labels[item.area]} · {outcomes[item.disposition]}</strong>
      <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(item.occurredAt).toLocaleString('en-IE')}</span>
      <p>{item.reason}</p>
      {item.evidenceRef ? <p>Evidence: {item.evidenceRef}</p> : null}
    </li>)}</ol>
    {nextCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingOlder}
      onPress={() => void loadOlder()}>Load older coverage assessments</Button> : null}
  </section>;
}
