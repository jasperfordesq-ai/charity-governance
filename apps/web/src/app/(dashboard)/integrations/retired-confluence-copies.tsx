'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { AppSection } from '@/components/ui/app-page';
import { ErrorState } from '@/components/ui/states';

type RetiredCopy = {
  id: string;
  documentId: string;
  pageTitle: string | null;
  recordedSiteId: string | null;
  recordedSpaceId: string | null;
  recordedPageId: string | null;
  retiredAt: string | null;
  erasureRequested: boolean;
};
type Page = { publications: RetiredCopy[]; nextCursor: string | null };
const CONFIRMATION = 'ERASE CONFLUENCE COPY';

export function RetiredConfluenceCopies() {
  const [copies, setCopies] = useState<RetiredCopy[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (before?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const response = await api.get<Page>('/integrations/confluence/publications', {
        params: before ? { before } : undefined,
      });
      if (current !== generation.current) return;
      setCopies((previous) => before
        ? [...previous, ...response.data.publications.filter((row) => !previous.some((item) => item.id === row.id))]
        : response.data.publications);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      if (current === generation.current) setError(apiErrorMessage(cause, 'Retired copies could not be loaded.'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = (id: string) => {
    setSelectedId(id);
    setReason('');
    setConfirmation('');
    setSubmittedJobId(null);
    setError('');
  };

  const requestErasure = async (copy: RetiredCopy) => {
    if (submitting || selectedId !== copy.id || copy.erasureRequested
      || !copy.recordedSiteId || !copy.recordedPageId) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await api.post<{ storageDeletionId: string }>(
        `/integrations/confluence/publications/${copy.id}/erase`,
        { reason: reason.trim(), confirmation },
      );
      setSubmittedJobId(response.data.storageDeletionId);
      setSelectedId(null);
      setReason('');
      setConfirmation('');
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The Confluence erasure request could not be recorded.'));
    } finally {
      setSubmitting(false);
    }
  };

  return <AppSection title="Retired Confluence copies" description="Review recorded external pages left after a CharityPilot document was removed. This list is paged and includes only this charity’s retained publication records. A recorded reference does not prove that a page still exists or identify every external copy.">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="flat" onPress={() => void load()} isLoading={loading}>Refresh copies</Button>
      <Link className="self-center text-sm text-teal-primary underline" href="/governance-audit">Review deletion history</Link>
    </div>
    {error ? <ErrorState title="Confluence copy review needs attention" description={error}
      action={<Button size="sm" onPress={() => void load()}>Retry</Button>} /> : null}
    {submittedJobId ? <p className="mt-3 text-sm text-gray-700 dark:text-gray-200">
      Erasure request recorded as technical job {submittedJobId}. Check its later attempt and provider outcome in Governance Audit; this request does not prove permanent purge.
    </p> : null}
    {!loading && copies.length === 0 && !error ? <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No retired Confluence publication records are listed.</p> : null}
    <ol className="mt-3 space-y-3">{copies.map((copy) => <li key={copy.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><strong>{copy.pageTitle || `Document ${copy.documentId}`}</strong>
          <p className="text-xs text-gray-600 dark:text-gray-300">Publication {copy.id} · document {copy.documentId}</p>
          <p className="text-sm">Recorded Confluence target: site {copy.recordedSiteId || 'unknown'} · space {copy.recordedSpaceId || 'unknown'} · page {copy.recordedPageId || 'unknown'}</p>
          <p className="text-xs text-gray-600 dark:text-gray-300">{copy.retiredAt
            ? `Retired ${new Date(copy.retiredAt).toLocaleString('en-IE')}` : 'Retirement time not recorded'}</p>
          {copy.erasureRequested ? <p className="mt-1 text-sm">Erasure request recorded; check the deletion job outcome.</p> : null}
        </div>
        {!copy.erasureRequested && copy.recordedSiteId && copy.recordedPageId ? <Button size="sm" variant="flat" color="danger"
          onPress={() => open(copy.id)}>Review erasure request</Button> : null}
        {!copy.erasureRequested && (!copy.recordedSiteId || !copy.recordedPageId)
          ? <p className="text-sm text-amber-800 dark:text-amber-300">The recorded site or page ID is missing. Review the original publication record; this screen cannot request erasure of an unidentified target.</p> : null}
      </div>
      {selectedId === copy.id && !copy.erasureRequested && copy.recordedSiteId && copy.recordedPageId ? <div className="mt-4 space-y-3">
        <p className="text-sm text-gray-700 dark:text-gray-200">This separately requests removal of the Confluence page and attachments. Confirm the page, retention decision, legal hold and external audience before proceeding. Provider versions and backups need separate proof.</p>
        <Textarea label={`Reason for erasing ${copy.pageTitle || copy.documentId}`} value={reason}
          onValueChange={setReason} minRows={2} isRequired description="Record the case or approved decision; avoid unnecessary personal details." />
        <Input label="Type ERASE CONFLUENCE COPY" value={confirmation} onValueChange={setConfirmation}
          isRequired description="Exact phrase required for this separate external action." />
        <div className="flex gap-2">
          <Button color="danger" onPress={() => void requestErasure(copy)} isLoading={submitting}
            isDisabled={submitting || Array.from(reason.trim()).length < 10 || confirmation !== CONFIRMATION}>
            Request Confluence erasure
          </Button>
          <Button variant="flat" onPress={() => setSelectedId(null)} isDisabled={submitting}>Cancel</Button>
        </div>
      </div> : null}
    </li>)}</ol>
    {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
      isLoading={loading} isDisabled={loading}>Load more recorded copies</Button> : null}
  </AppSection>;
}
