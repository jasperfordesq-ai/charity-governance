'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { ErasureReview } from './erasure-review';

type Observation = {
  deletionId: string; controlPageId: string; targetDigest: string; checkedAt: string;
  status: 'VISIBLE' | 'TRASHED' | 'NOT_OBSERVED' | 'UNKNOWN';
  reason: string | null; controlPageReadable: boolean; scope: 'RECORDED_TARGET_IDS_ONLY';
  permanentErasureVerified: false; allCopiesVerified: false; jobUpdated: false;
  providerMutationIssued: false; actionAuthorized: false;
};
const labels: Record<Observation['status'], string> = {
  VISIBLE: 'Recorded content is visible', TRASHED: 'Recorded content is in Trash',
  NOT_OBSERVED: 'Not observed — absence or restricted access', UNKNOWN: 'Outcome unknown',
};
const reasons: Record<string, string> = {
  NOT_CONNECTED: 'Connect the recorded Confluence site before checking its content.',
  CONNECTION_CHANGED: 'The connection changed. Review the connected site before checking again.',
  CONTROL_UNAVAILABLE: 'The control page could not be read. Choose a different current page you can access.',
  READ_FAILED: 'A provider read could not be completed. Review the connection and try again.',
  IDENTITY_MISMATCH: 'The returned page did not match the recorded target. Review the original record.',
  PAGE_STATE_UNVERIFIED: 'The page state could not be established. Review it in Confluence.',
  TARGET_CHANGED: 'The recorded target changed. Refresh the copies list before checking again.',
};

/** An explicit transient observation, never an erasure or job-completion form. */
export function ErasureObservation({ deletionId }: { deletionId: string }) {
  const [open, setOpen] = useState(false), [controlPageId, setControlPageId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [observation, setObservation] = useState<Observation | null>(null);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const observe = async () => {
    if (busy || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(controlPageId)) return;
    const current = ++generation.current;
    setBusy(true); setError(''); setObservation(null);
    try {
      const { data } = await api.get<{ observation: Observation }>(`/integrations/confluence/erasures/${encodeURIComponent(deletionId)}/observation`, { params: { controlPageId } });
      if (!active.current || current !== generation.current) return;
      const value = data.observation;
      if (!value || value.deletionId !== deletionId || value.controlPageId !== controlPageId
        || !Object.hasOwn(labels, value.status) || value.scope !== 'RECORDED_TARGET_IDS_ONLY'
        || !/^[a-f0-9]{64}$/.test(value.targetDigest) || !Number.isFinite(Date.parse(value.checkedAt))
        || [value.permanentErasureVerified, value.allCopiesVerified, value.jobUpdated, value.providerMutationIssued, value.actionAuthorized].some(flag => flag !== false)) {
        throw new Error('The observation response could not be verified.');
      }
      setObservation(value);
    } catch (cause) {
      if (active.current && current === generation.current) setError(apiErrorMessage(cause, 'The recorded target could not be observed.'));
    } finally { if (active.current && current === generation.current) setBusy(false); }
  };
  if (!open) return <Button size="sm" variant="flat" className="mt-2" onPress={() => setOpen(true)}>Observe recorded Confluence target</Button>;
  return <section aria-label="Recorded Confluence target observation" className="mt-3 space-y-3 rounded border border-gray-300 p-3 text-gray-900 dark:border-gray-600 dark:text-gray-100">
    <h4 className="font-medium">Observe recorded Confluence target</h4>
    <p className="break-all text-xs">Recorded deletion job: {deletionId}</p>
    <p className="text-sm">This reads the recorded page and attachments without deleting content or completing a job.
      An operator’s report of external remediation remains separate from this provider observation.</p>
    <Input label="Accessible control page ID" value={controlPageId} isDisabled={busy}
      classNames={{ description: 'text-gray-600 dark:text-gray-300' }}
      description="Use a different current page in the same connected site that you know you can read."
      onValueChange={value => { generation.current++; setControlPageId(value); setObservation(null); setError(''); }} />
    <Button size="sm" variant="flat" isLoading={busy} isDisabled={busy || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(controlPageId)}
      onPress={() => void observe()}>Read recorded target</Button>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    <div aria-live="polite">{observation ? <div className="space-y-1 text-sm">
      <p className="font-medium">{labels[observation.status]}</p>
      {observation.reason && Object.hasOwn(reasons, observation.reason) ? <p>{reasons[observation.reason]}</p> : null}
      <p>Checked {new Date(observation.checkedAt).toLocaleString('en-IE')}. Control page {observation.controlPageReadable ? 'readable' : 'not confirmed readable'}.</p>
      <p className="break-all">Recorded target digest: {observation.targetDigest}</p>
      <p>Missing content may be hidden by permissions. This does not verify permanent erasure, every copy, historical versions or backups. The job is unchanged.</p>
      <ErasureReview key={`${deletionId}:${observation.checkedAt}`} deletionId={deletionId} targetDigest={observation.targetDigest} controlPageId={observation.controlPageId} />
    </div> : null}</div>
  </section>;
}
