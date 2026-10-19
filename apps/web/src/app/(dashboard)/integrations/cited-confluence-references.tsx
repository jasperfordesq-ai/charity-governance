'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { isAxiosError } from 'axios';
import { Button, Checkbox, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { AppSection } from '@/components/ui/app-page';
import { ErrorState } from '@/components/ui/states';
import { CitationObservation } from '../documents/citation-observation';

type Citation = {
  id: string;
  documentId: string | null;
  recordedSiteId: string;
  recordedPageId: string;
  recordedTitle: string;
  citedVersion: number;
  citedAt: string;
  documentName: string | null;
  documentLifecycle: string | null;
  documentVisibility: string | null;
};
type Page = { references: Citation[]; nextCursor: string | null };

function SourceRegistration({ onRegistered }: { onRegistered: () => void }) {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [pageId, setPageId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ pageId: string; expectedSiteId: string; clientRequestId: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void api.get<{ siteId: string | null }>('/integrations/confluence/reference-target')
      .then(response => { if (active) setSiteId(response.data.siteId); })
      .catch(() => { if (active) setError('The connected site could not be reviewed. Refresh this page to try again.'); });
    return () => { active = false; };
  }, []);
  const register = async () => {
    if (inFlight.current || !siteId || !reviewed || !pageId.trim()) return;
    inFlight.current = true; setBusy(true); setError('');
    const body = request.current ?? { pageId: pageId.trim(), expectedSiteId: siteId, clientRequestId: crypto.randomUUID() };
    request.current = body; setPending(true);
    try {
      await api.post('/integrations/confluence/sources', body);
      request.current = null; setPending(false); setPageId(''); setReviewed(false); onRegistered();
    } catch (cause) {
      const refused = isAxiosError(cause) && cause.response && cause.response.status >= 400 && cause.response.status < 500;
      if (refused) { request.current = null; setPending(false); setReviewed(false); }
      setError(`${apiErrorMessage(cause, 'Source registration could not be confirmed.')}${refused
        ? ' Review the page and connection before a new registration.'
        : ' Retry uses the same request; it will not recite a newer version.'}`);
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <section aria-label="Register a Confluence document" className="my-4 space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
    <h3 className="font-semibold">Register a Confluence document</h3>
    <p className="text-sm">Keep the authoritative document in Confluence. CharityPilot records its page and version without uploading a Vault file or copying page content. This register is restricted to Owners and Admins; it grants no Confluence access and does not approve the document.</p>
    <p className="break-all text-sm">Connected site ID: {siteId || 'No connected site available'}</p>
    <Input label="Confluence source page ID" value={pageId} isDisabled={!siteId || busy || pending}
      onValueChange={value => { setPageId(value); setReviewed(false); }}
      classNames={{ description: 'text-gray-600 dark:text-gray-300' }}
      description="Enter the identifier of a current page you can read on the connected site." />
    <Checkbox isSelected={reviewed} onValueChange={setReviewed} isDisabled={!siteId || busy || pending}>
      I reviewed the connected site and selected page for this restricted register.
    </Checkbox>
    <Button size="sm" onPress={() => void register()} isLoading={busy} isDisabled={!siteId || !reviewed || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pageId.trim())}>
      {pending ? 'Retry original source registration' : 'Verify and register external document'}
    </Button>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
  </section>;
}

function SourceControls({ reference, onRemoved }: { reference: Citation; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const check = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await api.get<{ check: { status: string; currentVersion: number | null } }>(`/integrations/confluence/references/by-id/${reference.id}/check`);
      const result = response.data.check;
      setStatus(result.status === 'CURRENT' ? `Current at check: version ${result.currentVersion}.`
        : result.status === 'SUPERSEDED' ? `Superseded: upstream version ${result.currentVersion}; cited version remains ${reference.citedVersion}.`
          : 'Unknown: current upstream version could not be verified. This does not prove erasure.');
    } catch (cause) { setError(apiErrorMessage(cause, 'Version check could not be completed.')); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await api.delete(`/integrations/confluence/references/by-id/${reference.id}`); onRemoved(); }
    catch (cause) { setError(apiErrorMessage(cause, 'Local reference removal could not be confirmed. Refresh citations before trying again.')); }
    finally { inFlight.current = false; setBusy(false); setConfirming(false); }
  };
  return <div className="mt-3 space-y-3">
    <Button size="sm" variant="flat" onPress={() => void check()} isDisabled={busy}>Check external source version</Button>
    {status ? <p role="status" className="text-sm">{status}</p> : null}
    <CitationObservation referenceId={reference.id} pageId={reference.recordedPageId} disabled={busy} />
    {confirming ? <div className="space-y-2 rounded border border-amber-400 p-3">
      <p className="text-sm">Remove this local reference to page {reference.recordedPageId}? The Confluence page remains untouched. Governance audit and saved review reports remain available.</p>
      <Button size="sm" color="danger" onPress={() => void remove()} isLoading={busy}>Confirm local reference removal</Button>
      <Button size="sm" variant="flat" onPress={() => setConfirming(false)} isDisabled={busy}>Cancel removal</Button>
    </div> : <Button size="sm" variant="flat" onPress={() => setConfirming(true)} isDisabled={busy}>Remove local source reference</Button>}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
  </div>;
}

export function CitedConfluenceReferences() {
  const [references, setReferences] = useState<Citation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(async (before?: string) => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const response = await api.get<Page>('/integrations/confluence/reference-inventory', {
        params: before ? { before } : undefined,
      });
      if (current !== generation.current) return;
      setReferences((previous) => before
        ? [...previous, ...response.data.references.filter((row) => !previous.some((item) => item.id === row.id))]
        : response.data.references);
      setNextCursor(response.data.nextCursor);
    } catch (cause) {
      if (current === generation.current) setError(apiErrorMessage(cause, 'Cited pages could not be loaded.'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <AppSection title="Cited Confluence evidence pages" description="These are current retained references to pages managed by the charity, not copies CharityPilot published. Each citation records the page and version seen when it was added. The page, its version and its audience may have changed since then. Review and remove a document’s citations before moving it to Deleted Items. Removing a citation leaves the Confluence page unchanged. This list shows current citations, not their full audit history.">
    <SourceRegistration onRegistered={() => void load()} />
    <Button size="sm" variant="flat" onPress={() => void load()} isLoading={loading}>Refresh citations</Button>
    {error ? <ErrorState title="Citation review needs attention" description={error}
      action={<Button size="sm" onPress={() => void load()}>Retry</Button>} /> : null}
    {!loading && references.length === 0 && !error ? <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No current Confluence citations are listed.</p> : null}
    <ol className="mt-3 space-y-3">{references.map((reference) => <li key={reference.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <strong>{reference.recordedTitle}</strong>
      <p className="break-words text-xs text-gray-600 dark:text-gray-300">Citation {reference.id} · {reference.documentId === null ? 'External document — no Vault upload' : `document ${reference.documentId}`}</p>
      <p className="break-words text-sm">Recorded Confluence target: site {reference.recordedSiteId} · page {reference.recordedPageId} · cited version {reference.citedVersion}</p>
      <p className="text-sm">Cited {new Date(reference.citedAt).toLocaleString('en-IE')}; current provider version and audience have not been checked here.</p>
      {reference.documentId === null ? <><p className="text-sm">Restricted external-source register. Confluence controls access to the page content.</p>
        <SourceControls reference={reference} onRemoved={() => void load()} /></> : reference.documentName ? <p className="text-sm"><Link className="text-teal-primary underline" href="/documents">Review {reference.documentName} in the Vault</Link> · lifecycle {reference.documentLifecycle || 'unknown'} · visibility {reference.documentVisibility || 'unknown'}</p>
        : <p className="text-sm text-amber-800 dark:text-amber-300">The linked Vault document was not found. Review this citation before relying on it.</p>}
      {reference.documentId !== null && reference.documentLifecycle !== 'CURRENT'
        ? <p className="text-sm text-amber-800 dark:text-amber-300">This citation is attached to a document that is not currently classified as CURRENT.</p> : null}
    </li>)}</ol>
    {nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void load(nextCursor)}
      isLoading={loading} isDisabled={loading}>Load more citations</Button> : null}
  </AppSection>;
}
