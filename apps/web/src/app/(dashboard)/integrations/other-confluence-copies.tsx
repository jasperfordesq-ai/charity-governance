'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { AppSection } from '@/components/ui/app-page';
import { ErrorState } from '@/components/ui/states';

type Copy = {
  id: string;
  documentId: string;
  pageTitle: string | null;
  recordedSiteId: string | null;
  recordedSpaceId: string | null;
  recordedPageId: string | null;
  publicationState: string;
  publishedAt: string | null;
  lastObservedRemoteState: string | null;
  lastObservedAt: string | null;
  documentName: string | null;
  documentLifecycle: string | null;
  publicationApproved: boolean | null;
  approvalMatchesRecordedPage: boolean | null;
};
type Page = { copies: Copy[]; nextCursor: string | null };

export function OtherConfluenceCopies() {
  const [copies, setCopies] = useState<Copy[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(async (before?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const response = await api.get<Page>('/integrations/confluence/copy-inventory', {
        params: before ? { before } : undefined,
      });
      if (current !== generation.current) return;
      setCopies((previous) => before
        ? [...previous, ...response.data.copies.filter((row) => !previous.some((item) => item.id === row.id))]
        : response.data.copies);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      if (current === generation.current) setError(apiErrorMessage(cause, 'Recorded copies could not be loaded.'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <AppSection title="Other recorded Confluence copies" description="Recorded pages for documents outside the retired-copy queue, including files whose lifecycle or publication approval later changed. This is local evidence, not a live scan of your Confluence site or proof of its current audience.">
    <Button size="sm" variant="flat" onPress={() => void load()} isLoading={loading}>Refresh recorded copies</Button>
    {error ? <ErrorState title="Copy inventory needs attention" description={error}
      action={<Button size="sm" onPress={() => void load()}>Retry</Button>} /> : null}
    {!loading && copies.length === 0 && !error ? <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No other recorded Confluence pages are listed.</p> : null}
    <ol className="mt-3 space-y-3">{copies.map((copy) => <li key={copy.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <strong>{copy.pageTitle || copy.documentName || `Document ${copy.documentId}`}</strong>
      <p className="text-xs text-gray-600 dark:text-gray-300">Publication {copy.id} · document {copy.documentId} · job state {copy.publicationState}</p>
      <p className="text-sm">Recorded Confluence target: site {copy.recordedSiteId || 'unknown'} · space {copy.recordedSpaceId || 'unknown'} · page {copy.recordedPageId || 'unknown'}</p>
      {copy.documentName ? <p className="text-sm"><Link className="text-teal-primary underline" href="/documents">Review {copy.documentName} in the Vault</Link></p>
        : <p className="text-sm">The linked Vault document was not found. Review this reference before any copy disposition.</p>}
      <p className="text-sm">Document lifecycle: {copy.documentLifecycle || 'unknown'} · approval flag: {copy.publicationApproved === null ? 'unknown' : copy.publicationApproved ? 'recorded' : 'withdrawn'} · approval target matches this recorded page: {copy.approvalMatchesRecordedPage === null ? 'unknown' : copy.approvalMatchesRecordedPage ? 'yes' : 'no'}</p>
      {copy.documentLifecycle !== 'CURRENT' || copy.publicationApproved !== true || copy.approvalMatchesRecordedPage !== true
        ? <p className="text-sm text-amber-800 dark:text-amber-300">Review this recorded external copy and its audience. The current document status or approval does not establish authority for this recorded target.</p> : null}
      <p className="text-xs text-gray-600 dark:text-gray-300">Last observed provider state: {copy.lastObservedRemoteState || 'unknown'}{copy.lastObservedAt ? ` at ${new Date(copy.lastObservedAt).toLocaleString('en-IE')}` : ' (no recorded observation)'}. It may have changed since then.</p>
    </li>)}</ol>
    {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
      isLoading={loading} isDisabled={loading}>Load more recorded copies</Button> : null}
  </AppSection>;
}
