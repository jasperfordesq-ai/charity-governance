'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { canManageGovernance } from '@/lib/governance-permissions';

export type DocumentCitation = {
  id: string; documentId: string; cloudId: string; pageId: string;
  pageTitle: string; pageVersion: number; citedAt: string;
};
type CitationTarget = { siteId: string | null; siteUrl: string | null };

export function useDocumentCitations(documentId: string) {
  const { user, refreshUser } = useAuth();
  const [citations, setCitations] = useState<DocumentCitation[]>([]);
  const [connection, setConnection] = useState<CitationTarget | null>(null);
  const [pageId, setPageId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const canManage = canManageGovernance(user?.role) && !accessRevoked;
  const path = `/integrations/confluence/references/${encodeURIComponent(documentId)}`;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const [references, status] = await Promise.all([
        api.get<{ references: DocumentCitation[] }>(path, { timeout: 15000 }),
        api.get<CitationTarget>('/integrations/confluence/reference-target', { timeout: 15000 }),
      ]);
      if (current !== generation.current) return;
      setCitations(references.data.references); setConnection(status.data);
      setNeedsRefresh(false);
    } catch (cause) {
      if (current === generation.current) {
        setError(apiErrorMessage(cause, 'Citations could not be loaded. Refresh before making changes.'));
        setNeedsRefresh(true);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [path]);

  const invalidateLoads = useCallback(() => { generation.current++; }, []);
  useEffect(() => { void load(); return invalidateLoads; }, [load, invalidateLoads]);

  const failMutation = async (cause: unknown) => {
    if (isApiForbiddenError(cause)) {
      setAccessRevoked(true);
      setError('Your role no longer allows citation changes.');
      await refreshUser().catch(() => undefined);
      return;
    }
    setError(apiErrorMessage(cause, 'The citation change could not be confirmed. Refresh the list before trying again.'));
    setNeedsRefresh(true);
  };

  const add = async () => {
    const target = pageId.trim();
    if (!canManage || loading || needsRefresh || inFlight.current || !connection?.siteId || !connection.siteUrl) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target)) {
      setError('Enter a page ID, not a URL. You can find it after /pages/ in the Confluence page address.');
      return;
    }
    if (citations.some(row => row.pageId === target)) {
      setError('This page ID is already cited for this document. Review the existing citation below.');
      return;
    }
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await api.post<{ reference: DocumentCitation }>(path, { pageId: target, expectedSiteId: connection.siteId }, { skipAuthRefresh: true, timeout: 30000 });
      setCitations(rows => [response.data.reference, ...rows]); setPageId('');
      setNotice(`Cited ${response.data.reference.pageTitle} at version ${response.data.reference.pageVersion}. The Confluence page was not changed.`);
    } catch (cause) { await failMutation(cause); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const remove = async (referenceId: string) => {
    if (!canManage || loading || needsRefresh || inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.delete(`/integrations/confluence/references/by-id/${encodeURIComponent(referenceId)}`, { skipAuthRefresh: true, timeout: 30000 });
      setCitations(rows => rows.filter(row => row.id !== referenceId));
      setNotice('Citation removed. The Confluence page and its attachments were not changed.');
      return true;
    } catch (cause) { await failMutation(cause); return false; }
    finally { inFlight.current = false; setBusy(false); }
  };

  return { citations, connection, pageId, setPageId, loading, busy, error, notice,
    needsRefresh, canManage, load, add, remove };
}
