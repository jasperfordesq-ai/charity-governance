'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { ErasureReview } from '../integrations/erasure-review';

type Observation = {
  referenceId: string; targetDigest: string; checkedAt: string; controlPageId: string;
  status: 'VISIBLE' | 'TRASHED' | 'NOT_OBSERVED' | 'UNKNOWN'; reason: string | null;
  scope: 'CITED_PAGE_ONLY'; attachmentsObserved: false; permanentErasureVerified: false;
  allCopiesVerified: false; jobCreated: false; citationUpdated: false;
  providerMutationIssued: false; actionAuthorized: false;
};

export function CitationObservation({ referenceId, pageId, disabled }: {
  referenceId: string; pageId: string; disabled: boolean;
}) {
  const { user } = useAuth();
  const [controlPageId, setControlPageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [observation, setObservation] = useState<Observation | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { generation.current++; }, [referenceId]);
  if (user?.role !== 'OWNER') return null;

  const observe = async () => {
    if (disabled || inFlight.current) return;
    const control = controlPageId.trim();
    setObservation(null); setError('');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(control) || control === pageId) {
      setError('Enter a different accessible current page ID as the access control.'); return;
    }
    const current = ++generation.current;
    inFlight.current = true; setBusy(true);
    try {
      const { data } = await api.get<{ observation: Observation }>(
        `/integrations/confluence/references/by-id/${encodeURIComponent(referenceId)}/observation?controlPageId=${encodeURIComponent(control)}`,
        { timeout: 60000, skipAuthRefresh: true });
      if (current !== generation.current) return;
      const value = data.observation;
      if (value.referenceId !== referenceId || value.controlPageId !== control || value.scope !== 'CITED_PAGE_ONLY'
        || !/^[a-f0-9]{64}$/.test(value.targetDigest) || !Number.isFinite(Date.parse(value.checkedAt))
        || !['VISIBLE', 'TRASHED', 'NOT_OBSERVED', 'UNKNOWN'].includes(value.status)
        || ['attachmentsObserved', 'permanentErasureVerified', 'allCopiesVerified', 'jobCreated',
          'citationUpdated', 'providerMutationIssued', 'actionAuthorized'].some(key => value[key as keyof Observation] !== false)) {
        throw new Error('Unbound observation');
      }
      setObservation(value);
    } catch (cause) {
      if (current === generation.current) setError(apiErrorMessage(cause, 'The cited page could not be observed. Review the connection and try again.'));
    } finally {
      inFlight.current = false;
      if (current === generation.current) setBusy(false);
    }
  };

  return <section className="mt-3 space-y-2 rounded-md border border-gray-300 p-3 text-gray-900 dark:border-gray-600 dark:text-gray-100" aria-label="Cited page lifecycle observation">
    <p className="text-sm">Observe this cited page without requesting deletion. Attachments, earlier versions and backups are outside this check.</p>
    <Input label="Separate accessible control page ID" value={controlPageId} isDisabled={disabled || busy}
      onValueChange={value => { setControlPageId(value); setObservation(null); setError(''); }} />
    <Button size="sm" variant="flat" onPress={observe} isLoading={busy} isDisabled={disabled}>Observe cited page</Button>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    {observation ? <div role="status" className="space-y-1 break-words text-sm">
      <p>{observation.status === 'VISIBLE' ? 'Page visible at check.' : observation.status === 'TRASHED' ? 'Page observed in recoverable Trash.'
        : observation.status === 'NOT_OBSERVED' ? 'Page not observed. Absence or restricted access may explain this.'
          : 'Unknown: review the connection, control-page access and whether this citation still exists.'}</p>
      <p>Checked {new Date(observation.checkedAt).toLocaleString('en-IE')}. Target {observation.targetDigest}.</p>
      <p>This grants no disposal authority and does not prove permanent erasure. No deletion job was created; the citation is unchanged.</p>
      <ErasureReview key={`${referenceId}:${observation.checkedAt}`} referenceId={referenceId} targetDigest={observation.targetDigest} controlPageId={observation.controlPageId} />
    </div> : null}
  </section>;
}
