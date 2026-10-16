'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { buildSyntheticCopyReview, SYNTHETIC_REVIEW_FIELDS, type CopyReviewActor } from '@/lib/retained-copy-review';

type Receipt = { id: string; reviewerId: string; snapshotSha256: string; evidenceRef: string | null;
  reviewedAt: string; expiresAt: string; withdrawnAt: string | null };
type Receipts = { reviews: Receipt[]; nextCursor: string | null; providerIOAuthorised: false;
  currentSourceChecked: false; absenceProvesFailure: false };
type Observation = { snapshot: Record<string, unknown>; sourceBytesObserved: boolean;
  actionAuthorized: false; syntheticVerified: false; allCopiesVerified: false };

export function RetainedCopyReview({ publicationId, actor }: { publicationId: string; actor: CopyReviewActor }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]), [next, setNext] = useState<string | null>(null);
  const [receiptsReady, setReceiptsReady] = useState(false), [observation, setObservation] = useState<Observation | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({}), [validity, setValidity] = useState('30');
  const [confirmed, setConfirmed] = useState(false), [saveState, setSaveState] = useState<'READY' | 'SAVING' | 'SAVED' | 'UNKNOWN'>('READY');
  const [savedId, setSavedId] = useState('');
  const [attemptedReview, setAttemptedReview] = useState<{ reference: string; reviewedAt: string } | null>(null);
  const active = useRef(true), locked = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const base = '/integrations/confluence/retained-copy-reviews';
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'The review could not be completed.')); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  };
  const loadReceipts = async (before?: string) => {
    try {
      const { data } = await api.get<Receipts>(`${base}/publications/${publicationId}/reviews`, { params: before ? { before } : undefined });
      if (!active.current) return;
      if (data.providerIOAuthorised !== false || data.currentSourceChecked !== false || data.absenceProvesFailure !== false) {
        throw new Error('Review receipt verification is unavailable.');
      }
      setReceipts(previous => before ? [...previous, ...data.reviews.filter(row => !previous.some(item => item.id === row.id))] : data.reviews);
      setNext(data.nextCursor); setReceiptsReady(true);
    } catch (cause) { if (active.current) setError(apiErrorMessage(cause, 'Review receipts could not be loaded.')); }
  };
  const observe = async () => {
    const { data } = await api.post<Observation>(`${base}/observe/${publicationId}`, {});
    if (active.current) { setObservation(data); setSaveState('READY'); setSavedId(''); setConfirmed(false); }
  };
  const save = async () => {
    if (!observation || saveState !== 'READY' || !receiptsReady) return;
    // Validation failures happen before submission and do not create uncertainty.
    const body = buildSyntheticCopyReview({ actor, observation, publicationId, references,
      validityMinutes: Number(validity), confirmed });
    setAttemptedReview({ reference: (references.evidenceRef ?? '').trim(), reviewedAt: body.reviewedAt });
    setSaveState('SAVING');
    try {
      const { data } = await api.post<{ id: string }>(`${base}/`, body);
      if (!active.current) return;
      setSaveState('SAVED'); setSavedId(data.id); setObservation(null);
    } catch (cause) {
      if (active.current) {
        setSaveState('UNKNOWN');
        setError(apiErrorMessage(cause, 'The save response was lost or refused. Check receipts before continuing.'));
      }
      return;
    }
    await loadReceipts();
  };
  if (!open) return <Button className="mt-3" size="sm" variant="flat" isDisabled={busy}
    onPress={() => { setOpen(true); void run(() => loadReceipts()); }}>Review retained synthetic copy</Button>;
  const frozen = busy || saveState !== 'READY';
  const inventory = observation?.snapshot.inventory;
  const inventoryDetails = inventory !== null && typeof inventory === 'object' && !Array.isArray(inventory)
    ? inventory as Record<string, unknown> : null;
  return <section aria-label="Retained synthetic copy review" aria-busy={busy} className="mt-4 space-y-3 rounded-lg border border-gray-300 p-4 dark:border-gray-600">
    <h4 className="font-semibold">Retain the Vault record; review its synthetic external copy</h4>
    <p className="text-sm">This records review evidence for synthetic test content. It does not authorise or execute erasure. Check existing receipts before making another decision.</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="flat" isDisabled={busy} onPress={() => void run(() => loadReceipts())}>Refresh review receipts</Button>
      <Button size="sm" variant="flat" isDisabled={busy || !receiptsReady || saveState === 'UNKNOWN'}
        onPress={() => void run(observe)}>Observe current source and copy</Button>
      <Button size="sm" variant="light" isDisabled={busy} onPress={() => setOpen(false)}>Close review</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {saveState === 'SAVING' ? <p role="status" className="text-sm">Recording review…</p> : null}
    {saveState === 'SAVED' ? <p role="status" className="text-sm">Review recorded: {savedId}. Disposal is not authorised.</p> : null}
    {saveState === 'UNKNOWN' ? <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
      The save outcome needs reconciliation. Refresh receipts and check the original decision reference, reviewer and time. An empty result does not prove failure. Another submission is blocked in this panel.
    </p> : null}
    {saveState === 'UNKNOWN' && attemptedReview ? <p className="text-sm">Attempted review: {attemptedReview.reference} · reviewer you · {new Date(attemptedReview.reviewedAt).toLocaleString('en-IE')}</p> : null}
    {observation ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(save); }}>
      <p className="break-all text-sm">Observed source SHA-256: {String(observation.snapshot.sourceSha256 ?? 'unavailable')}</p>
      <p className="text-sm">Recorded target: {String(observation.snapshot.siteOrigin ?? '')} / {String(observation.snapshot.pageId ?? '')}</p>
      <p className="text-sm">Observation time: {typeof inventoryDetails?.observedAt === 'string' ? new Date(inventoryDetails.observedAt).toLocaleString('en-IE') : 'unavailable'} · page version {String(inventoryDetails?.currentPageVersion ?? 'unknown')} · {Array.isArray(inventoryDetails?.pageVersions) ? inventoryDetails.pageVersions.length : 'unknown'} listed page versions · {Array.isArray(inventoryDetails?.attachments) ? inventoryDetails.attachments.length : 'unknown'} attachments.</p>
      <p className="text-sm">This observation does not establish every provider-held backup or copy.</p>
      {SYNTHETIC_REVIEW_FIELDS.map(({ key, label }) => <Input key={key} label={label} value={references[key] ?? ''}
        onValueChange={value => setReferences(previous => ({ ...previous, [key]: value }))} isRequired isDisabled={busy} isReadOnly={saveState !== 'READY'}
        classNames={{ label: 'text-gray-700 dark:text-gray-200', description: 'text-gray-600 dark:text-gray-300' }}
        description="Use an existing evidence reference: uppercase letters, numbers and hyphens." />)}
      <Input label="Review validity (minutes)" type="number" min={1} max={60} value={validity}
        onValueChange={setValidity} isRequired isDisabled={busy} isReadOnly={saveState !== 'READY'}
        classNames={{ label: 'text-gray-700 dark:text-gray-200', description: 'text-gray-600 dark:text-gray-300' }}
        description="30 minutes is suggested; choose 1–60. This is review validity, not a retention period." />
      <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={frozen}>
        I checked the receipts and evidence: this is synthetic test content and the local record must be retained.
      </Checkbox>
      <Button type="submit" color="primary" isLoading={saveState === 'SAVING'} isDisabled={frozen || !confirmed
        || SYNTHETIC_REVIEW_FIELDS.some(({ key }) => !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test((references[key] ?? '').trim()))
        || !Number.isInteger(Number(validity)) || Number(validity) < 1 || Number(validity) > 60}>Record synthetic copy review</Button>
    </form> : null}
    <h5 className="font-medium">Stored review receipts</h5>
    {receiptsReady && receipts.length === 0 ? <p className="text-sm">No review receipts are listed. This is not proof that an earlier in-flight save failed.</p> : null}
    <ul className="space-y-2">{receipts.map(receipt => <li key={receipt.id} className="break-all text-sm">
      <strong>{receipt.evidenceRef ?? 'Unidentified review reference'}</strong> · {receipt.id}
      <p>Reviewer {receipt.reviewerId === actor.id ? 'you' : receipt.reviewerId} · reviewed {new Date(receipt.reviewedAt).toLocaleString('en-IE')} · expires {new Date(receipt.expiresAt).toLocaleString('en-IE')}{receipt.withdrawnAt ? ' · withdrawn' : ''}</p>
      <p>Snapshot digest: {receipt.snapshotSha256}</p>
    </li>)}</ul>
    {next ? <Button size="sm" variant="flat" isDisabled={busy} onPress={() => void run(() => loadReceipts(next))}>Load more review receipts</Button> : null}
  </section>;
}
