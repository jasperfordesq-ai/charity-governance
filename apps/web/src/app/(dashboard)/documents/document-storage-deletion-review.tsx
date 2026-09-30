'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { statusPanelClassName } from '@/components/ui/status';

const CONFIRMATION = 'REQUEUE DOCUMENT STORAGE DELETION';

type FailedDeletion = {
  id: string;
  provider: string;
  attempts: number;
  deadLetteredAt: string;
  lastAttemptAt: string | null;
  terminalReason: string | null;
};

type FailedDeletionPage = { data: FailedDeletion[]; nextCursor: string | null };

export function DocumentStorageDeletionReview() {
  const [jobs, setJobs] = useState<FailedDeletion[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [requeueing, setRequeueing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get<FailedDeletionPage>('/documents/storage-deletions/dead-letter');
      setJobs(response.data.data);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Failed deletion jobs could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };

  const loadOlder = async () => {
    if (!nextCursor || loading || loadingOlder || requeueing) return;
    setLoadingOlder(true);
    setError('');
    try {
      const response = await api.get<FailedDeletionPage>('/documents/storage-deletions/dead-letter',
        { params: { after: nextCursor } });
      setJobs((current) => {
        const seen = new Set((current ?? []).map((job) => job.id));
        return [...(current ?? []), ...response.data.data.filter((job) => !seen.has(job.id))];
      });
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Older failed deletion jobs could not be loaded.'));
    } finally {
      setLoadingOlder(false);
    }
  };

  const chooseJob = (id: string | null) => {
    setSelectedId(id);
    setReason('');
    setConfirmation('');
    setError('');
    setMessage('');
  };

  const requeue = async () => {
    if (!selectedId || requeueing || confirmation !== CONFIRMATION
      || Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500) return;
    setRequeueing(true);
    setError('');
    setMessage('');
    try {
      await api.post(`/documents/storage-deletions/${selectedId}/requeue`, {
        reason: reason.trim(), confirmation: CONFIRMATION, disposition: 'REQUEUE_UNCHANGED',
      });
      chooseJob(null);
      await load();
      setMessage('Cleanup retry queued. Review the deletion attempt and active-object evidence in Governance Audit.');
    } catch (cause) {
      setError(apiErrorMessage(cause, 'Cleanup retry could not be queued.'));
    } finally {
      setRequeueing(false);
    }
  };

  return (
    <section className={statusPanelClassName('neutral', 'p-5')} aria-label="Failed storage deletion jobs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Failed storage deletion jobs</h2>
          <p className="text-sm">Review provider cleanup jobs that stopped after retries. Requeueing asks the worker to try deleting the recorded target again; it does not restore a deleted document or prove permanent purge. Jobs can be reviewed 50 at a time.</p>
        </div>
        <Button size="sm" variant="flat" onPress={load} isLoading={loading} isDisabled={loadingOlder || requeueing}>Load failed jobs</Button>
      </div>
      <p className="mt-2 text-sm"><Link className="text-teal-primary underline" href="/governance-audit">Open Governance Audit</Link> for deletion status, attempt outcomes and recovery decisions.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
      {jobs?.length === 0 ? <p className="mt-3 text-sm">No failed storage deletion jobs are recorded for this charity.</p> : null}
      {jobs && jobs.length > 0 ? <ol className="mt-4 space-y-3">{jobs.map((job) => (
        <li key={job.id} className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
          <p className="font-medium">{job.provider} · {job.terminalReason ?? 'Reason unavailable'} · {job.attempts} attempts</p>
          <p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-400">Job {job.id} · stopped {new Date(job.deadLetteredAt).toLocaleString('en-IE')}</p>
          {job.lastAttemptAt ? <p className="text-xs text-gray-600 dark:text-gray-400">Last attempt {new Date(job.lastAttemptAt).toLocaleString('en-IE')}</p> : null}
          {job.terminalReason === 'PERMANENT_STORAGE_PATH_REJECTED'
            ? <p className="mt-2 text-xs">This target needs platform review; it cannot be retried unchanged here.</p>
            : <Button className="mt-2" size="sm" variant="flat" onPress={() => chooseJob(job.id)} isDisabled={requeueing}>Review cleanup retry</Button>}
        </li>
      ))}</ol> : null}
      {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={loadOlder} isLoading={loadingOlder} isDisabled={loading || requeueing}>Load older failed jobs</Button> : null}
      {selectedId ? <div className="mt-4 space-y-3 rounded-md border border-amber-300 p-4 dark:border-amber-700">
        <h3 className="font-semibold">Retry cleanup for job {selectedId}</h3>
        <p className="text-sm">Confirm that the provider issue has been reviewed. The worker may delete the recorded storage target after this request. This action cannot recover a document.</p>
        <Textarea label="Reason for cleanup retry" value={reason} onValueChange={setReason} minRows={2} maxLength={500} />
        <Input label={`Type ${CONFIRMATION}`} value={confirmation} onValueChange={setConfirmation} autoComplete="off" />
        <div className="flex flex-wrap gap-2">
          <Button color="warning" onPress={() => void requeue()} isLoading={requeueing}
            isDisabled={confirmation !== CONFIRMATION || Array.from(reason.trim()).length < 10 || Array.from(reason.trim()).length > 500}>
            Queue cleanup retry
          </Button>
          <Button variant="flat" onPress={() => chooseJob(null)} isDisabled={requeueing}>Cancel</Button>
        </div>
      </div> : null}
    </section>
  );
}
