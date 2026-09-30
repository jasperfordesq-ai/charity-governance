'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, PermissionHint } from '@/components/ui/states';

type AuditEvent = Record<string, unknown>;
type AuditFeed = { key: string; label: string; path: string; href: string; events: AuditEvent[]; nextCursor: string | null; error?: string };
const feedDefinitions = [
  { key: 'organisation', label: 'Organisation profile changes', path: '/governance-audit/organisation', href: '/organisation' },
  { key: 'deadlines', label: 'Deadline changes', path: '/governance-audit/deadlines', href: '/deadlines' },
  { key: 'reminders', label: 'Reminder state changes', path: '/governance-audit/reminders', href: '/deadlines' },
  { key: 'minute-book', label: 'Minute Book changes', path: '/governance-audit/minute-book', href: '/minute-book' },
  { key: 'document-controls', label: 'Document changes and controls', path: '/governance-audit/document-controls', href: '/documents' },
  { key: 'document-downloads', label: 'Vault download preparations', path: '/governance-audit/document-downloads', href: '/documents' },
  { key: 'document-visibility', label: 'Document visibility decisions', path: '/governance-audit/document-visibility', href: '/documents' },
  { key: 'risks', label: 'Risk changes', path: '/governance-audit/risks', href: '/registers' },
  { key: 'registers', label: 'Register record actions', path: '/governance-audit/registers', href: '/registers' },
  { key: 'complaint-resolution', label: 'Complaint resolution reviews', path: '/governance-audit/complaint-resolution', href: '/registers' },
  { key: 'controls', label: 'Control verification', path: '/governance-audit/controls', href: '/registers' },
  { key: 'compliance', label: 'Compliance changes', path: '/governance-audit/compliance', href: '/compliance' },
  { key: 'reports', label: 'Compliance report preparations', path: '/governance-audit/reports', href: '/export' },
  { key: 'deletions', label: 'Storage deletion queue status', path: '/governance-audit/deletions', href: '/documents' },
  { key: 'deletion-attempts', label: 'Storage deletion attempt outcomes', path: '/governance-audit/deletion-attempts', href: '/documents' },
  { key: 'deletion-recoveries', label: 'Storage deletion recovery decisions', path: '/governance-audit/deletion-recoveries', href: '/documents' },
  { key: 'data-requests', label: 'Data request review changes', path: '/governance-audit/data-requests', href: '/data-lifecycle' },
  { key: 'data-request-targets', label: 'Data request response targets', path: '/governance-audit/data-request-targets', href: '/data-lifecycle' },
  { key: 'data-request-responses', label: 'Actual data request responses', path: '/governance-audit/data-request-responses', href: '/data-lifecycle' },
  { key: 'data-request-coverage', label: 'Data request source-area reviews', path: '/governance-audit/data-request-coverage', href: '/data-lifecycle' },
  { key: 'data-request-links', label: 'Data request evidence links', path: '/governance-audit/data-request-links', href: '/data-lifecycle' },
  { key: 'action-approvals', label: 'Human action approvals', path: '/governance-audit/action-approvals', href: '/approvals' },
  { key: 'connector-actions', label: 'Connector change attempts', path: '/governance-audit/connector-actions', href: '/team' },
  { key: 'integrations', label: 'Confluence integration events', path: '/governance-audit/integrations', href: '/integrations' },
] as const;

function auditPage(value: unknown): { events: AuditEvent[]; nextCursor: string | null } {
  if (!value || typeof value !== 'object') return { events: [], nextCursor: null };
  const page = value as { data?: unknown; nextCursor?: unknown };
  return {
    events: Array.isArray(page.data) ? page.data as AuditEvent[] : [],
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  };
}

function eventDate(event: AuditEvent): string | null {
  const value = event.occurredAt ?? event.createdAt;
  return typeof value === 'string' ? value : null;
}

function eventDescription(event: AuditEvent, feed: string): string {
  if (feed === 'reminders') {
    if (event.previousStatus === event.nextStatus && event.reconciliationOutcome) {
      return `Reminder reconciliation ${String(event.reconciliationOutcome).replaceAll('_', ' ').toLowerCase()} · deadline ${String(event.deadlineId ?? 'unknown')}`;
    }
    const transition = event.previousStatus
      ? `${String(event.previousStatus)} → ${String(event.nextStatus ?? 'unknown')}`
      : `Created as ${String(event.nextStatus ?? 'unknown')}`;
    return `Reminder ${transition} · deadline ${String(event.deadlineId ?? 'unknown')}`;
  }
  if (feed === 'document-downloads') {
    return `Download prepared · document ${String(event.documentId ?? 'unknown')}`;
  }
  if (feed === 'reports') {
    const version = event.reportVersion === 'approved' ? 'approved snapshot' : 'working report';
    const audience = event.audience === 'minimised' ? 'minimised review draft' : 'internal';
    return `Report prepared · ${version} · ${audience} · ${String(event.reportingYear ?? 'year unknown')}`;
  }
  if (feed === 'action-approvals') {
    const state = { REQUESTED: 'Requested', RENEWED: 'Renewed', GRANTED: 'Granted', CONSUMED: 'Used' }[String(event.kind)] ?? 'Approval change';
    return `${state} · ${String(event.method)} ${String(event.routePattern)}`
      + (typeof event.resourceId === 'string' ? ` · record ${event.resourceId}` : '');
  }
  if (feed === 'connector-actions') {
    return `${String(event.method ?? 'Action')} ${String(event.routePattern ?? 'route unknown')}`
      + ` · HTTP ${String(event.statusCode ?? 'unknown')}`
      + (typeof event.resourceId === 'string' ? ` · record ${event.resourceId}` : '');
  }
  if (feed === 'deletion-recoveries') {
    return `${String(event.disposition ?? 'Recovery decision')} · deletion ${String(event.deletionId ?? 'unknown')}`;
  }
  if (feed === 'deletion-attempts') {
    return `${String(event.outcome ?? 'Attempt')} · deletion ${String(event.deletionId ?? 'unknown')} · attempt ${String(event.attemptNumber ?? '?')}`;
  }
  if (feed === 'data-request-links') {
    const action = event.action === 'WITHDRAWN' ? 'Association withdrawn' : 'Association recorded';
    const subject = event.kind === 'VAULT_DOCUMENT'
      ? `Vault ${String(event.documentId ?? `link ${String(event.linkId ?? 'unknown')}`)}`
      : `storage ${String(event.deletionId ?? `link ${String(event.linkId ?? 'unknown')}`)}`;
    return `${action} · ${subject} · request ${String(event.requestId ?? 'unknown')}`;
  }
  if (feed === 'data-request-targets') {
    const target = typeof event.nextTargetAt === 'string'
      ? `set to ${new Date(event.nextTargetAt).toLocaleString('en-IE')}` : 'cleared';
    return `Response target ${target} · request ${String(event.requestId ?? 'unknown')}`;
  }
  if (feed === 'data-request-responses') {
    const response = typeof event.nextResponseAt === 'string'
      ? `recorded as sent ${new Date(event.nextResponseAt).toLocaleString('en-IE')}` : 'record withdrawn';
    return `Actual response ${response} · request ${String(event.requestId ?? 'unknown')}`;
  }
  if (feed === 'data-request-coverage') {
    const area = String(event.area ?? 'unknown area').replaceAll('_', ' ').toLowerCase();
    const disposition = String(event.disposition ?? 'reviewed').replaceAll('_', ' ').toLowerCase();
    return `${area} · ${disposition} · request ${String(event.requestId ?? 'unknown')}`;
  }
  if (feed === 'integrations') {
    const label = {
      INTEGRATION_CONNECTED: 'Connection established',
      INTEGRATION_SITE_SELECTED: 'Site selected',
      INTEGRATION_DISCONNECTED: 'Connection removed',
      INTEGRATION_PUBLISH_TARGET_CHANGED: 'Publication target changed',
  INTEGRATION_ENVIRONMENT_DECLARED: 'Environment declaration changed',
      INTEGRATION_REAUTHORISATION_REQUIRED: 'Reauthorisation required',
      DOCUMENT_PUBLICATION_DEAD_LETTERED: 'Publication needs review',
      CONFLUENCE_ERASURE_REQUESTED: 'Erasure requested',
    }[String(event.type)] ?? 'Integration event';
    return `${label} · event ${String(event.id ?? 'unknown')}`;
  }
  const action = event.action ?? event.kind ?? event.type ?? event.next ?? event.nextState ?? event.state ?? 'Change';
  const subject = event.recordId ?? event.requestId ?? event.documentId ?? event.riskId ?? event.standardId ?? event.id;
  return `${String(action)}${subject ? ` · ${String(subject)}` : ''}`;
}

export default function GovernanceAuditPage() {
  useDocumentTitle('Governance Audit');
  const { user } = useAuth();
  const canReview = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const [feeds, setFeeds] = useState<AuditFeed[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(feedDefinitions.map(async (feed): Promise<AuditFeed> => {
      try {
        const response = await api.get(feed.path);
        return { ...feed, ...auditPage(response.data) };
      } catch (cause) {
        return { ...feed, events: [], nextCursor: null, error: apiErrorMessage(cause, 'History could not be loaded.') };
      }
    }));
    setFeeds(results);
    setLoading(false);
  }, []);

  const loadOlder = async (feed: AuditFeed) => {
    if (!feed.nextCursor || loading || loadingOlder) return;
    setLoadingOlder(feed.key);
    try {
      const response = await api.get(feed.path, { params: { before: feed.nextCursor } });
      const page = auditPage(response.data);
      setFeeds((current) => current?.map((item) => {
        if (item.key !== feed.key) return item;
        const seen = new Set(item.events.map((event) => String(event.id)));
        return { ...item, events: [...item.events, ...page.events.filter((event) => !seen.has(String(event.id)))], nextCursor: page.nextCursor, error: undefined };
      }) ?? null);
    } catch (cause) {
      setFeeds((current) => current?.map((item) => item.key === feed.key
        ? { ...item, error: apiErrorMessage(cause, 'Older history could not be loaded.') } : item) ?? null);
    } finally {
      setLoadingOlder(null);
    }
  };

  useEffect(() => { if (canReview) void load(); }, [canReview, load]);

  return (
    <AppPage eyebrow="Admin review" title="Governance Audit"
      description="Review recorded changes to the organisation profile, deadlines and reminders, Minute Book, documents, registers, controls and compliance, plus Vault and report preparation, data requests, human action approvals and connector change attempts. Security events remain on the Team page. Older retained entries can be loaded 50 at a time.">
      {!canReview ? <PermissionHint>Only Owners and Admins can review governance change history.</PermissionHint> : (
        <>
          <AppSection title="Where to review controls" description="The audit feeds below cover the named operations from the point their histories were introduced; they are not a complete historical ledger for every application action. This overview shows event metadata; open the related record for its controlled detailed history.">
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              <li><Link className="text-teal-primary underline" href="/minute-book">Minute Book</Link> — governing acts, written resolutions and void history.</li>
              <li><Link className="text-teal-primary underline" href="/organisation">Organisation</Link> — submitted profile fields, actor and revision times, without copied profile values.</li>
              <li><Link className="text-teal-primary underline" href="/deadlines">Deadlines</Link> — manual changes, generated and superseded occurrences, completions and archived records. Reminder state transitions begin when their database audit is deployed; earlier transitions cannot be reconstructed from current log status.</li>
              <li><Link className="text-teal-primary underline" href="/documents">Documents</Link> — uploads, metadata edits, standard links, visibility, lifecycle, publication approval, record deletion, storage attempt outcomes, recovery decisions and download preparation history. The deletion queue shows current status. Attempt events begin with the new audit and require a committed queue transition, so an in-flight or stale worker call may not appear. A download preparation event does not prove receipt.</li>
              <li><Link className="text-teal-primary underline" href="/registers">Registers</Link> — risk edits, statutory membership and other register actions, and dated control evidence.</li>
              <li><Link className="text-teal-primary underline" href="/compliance">Compliance</Link> — restricted status, evidence and approval decision history for a selected reporting year.</li>
              <li><Link className="text-teal-primary underline" href="/export">Compliance Record</Link> — report preparation by year, audience and actor, without report content in the audit row.</li>
              <li><Link className="text-teal-primary underline" href="/team">Team</Link> — separate security and ownership events.</li>
              <li><Link className="text-teal-primary underline" href="/integrations">Integrations</Link> — Confluence connection and erasure status. Its recorded connection, target, environment declaration, failure and erasure-request events also appear below without site URLs or document names; the Team security audit retains the detailed restricted event.</li>
              <li><Link className="text-teal-primary underline" href="/data-lifecycle">Data Requests</Link> — intake, review-state, source-area coverage, Vault/job association and withdrawal history. Case reasons and evidence references remain in the individual request.</li>
              <li><Link className="text-teal-primary underline" href="/approvals">Action approvals</Link> — retained request, renewal, grant and use events for connector approvals. Use means the request passed the approval gate; check the action history for its outcome. Older events reconstructed from saved timestamps are labelled. Refused grant attempts appear in the separate Team security audit without the attempted ID or cause.</li>
              <li><Link className="text-teal-primary underline" href="/team">Connector change attempts</Link> — recorded method, matched route, status and request ID for connector writes, including refusals. The overview omits session IDs and supplied reasons; a successful HTTP response should be checked against the relevant record history.</li>
            </ul>
          </AppSection>
          <AppSection title="Security and data administration" description="The current tenant controls and their limits are listed on a separate administration page.">
            <Link className="text-sm text-teal-primary underline" href="/security-data">Open Security & Data</Link>
          </AppSection>
          <div><Button size="sm" variant="flat" onPress={load} isLoading={loading} isDisabled={Boolean(loadingOlder)}>Refresh history</Button></div>
          {loading && !feeds ? <LoadingState title="Loading governance history" description="Reading the available audit feeds." /> : null}
          {feeds?.map((feed) => (
            <AppSection key={feed.key} title={feed.label} actions={<Link className="text-sm text-teal-primary underline" href={feed.href}>Open records</Link>}>
              {feed.error ? <ErrorState title={`${feed.label} unavailable`} description={feed.error} action={<Button size="sm" onPress={load}>Retry</Button>} /> : null}
              {feed.events.length === 0 && !feed.error ? <p className="text-sm text-gray-600 dark:text-gray-300">No recorded events in this feed.</p> : null}
              {feed.events.length > 0 ? <ol className="space-y-2">{feed.events.map((event, index) => (
                    <li key={String(event.id ?? `${feed.key}-${index}`)} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                      <div className="flex flex-wrap justify-between gap-2"><strong>{eventDescription(event, feed.key)}</strong><time>{eventDate(event) ? new Date(eventDate(event)!).toLocaleString('en-IE') : 'Date unavailable'}</time></div>
                      {feed.key === 'deletions' && (event.provider === 'local' || event.provider === 'supabase') ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                        {typeof event.activeObjectAbsentAt === 'string'
                          ? `Active primary object observed absent ${new Date(event.activeObjectAbsentAt).toLocaleString('en-IE')}. Versions and backups need separate review.`
                          : 'No active-object absence receipt recorded for this row; this does not establish byte purge.'}
                      </p> : null}
                      {feed.key === 'deletion-attempts' && event.outcome === 'PROCESSED' && (event.provider === 'local' || event.provider === 'supabase') ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                        {typeof event.activeObjectAbsentAt === 'string'
                          ? `Active primary object observed absent ${new Date(event.activeObjectAbsentAt).toLocaleString('en-IE')}. Versions and backups need separate review.`
                          : 'No active-object absence receipt for this outcome; this does not establish byte purge.'}
                      </p> : null}
                      {feed.key === 'action-approvals' && event.backfilled === true ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">Reconstructed from the retained approval row; original expiry and any renewals are unknown.</p> : null}
                      <details className="mt-2"><summary className="cursor-pointer">Inspect event details</summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(event, null, 2)}</pre>
                      </details>
                    </li>
                  ))}</ol> : null}
              {feed.nextCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void loadOlder(feed)} isLoading={loadingOlder === feed.key} isDisabled={loading || Boolean(loadingOlder)}>Load older entries</Button> : null}
            </AppSection>
          ))}
        </>
      )}
    </AppPage>
  );
}
