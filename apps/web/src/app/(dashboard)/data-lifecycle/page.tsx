'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Input, Textarea } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useAuth } from '@/lib/auth-context';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, PermissionHint } from '@/components/ui/states';
import { DataLifecycleCoverage } from './data-lifecycle-coverage';

type Kind = 'ERASURE' | 'RETENTION_REVIEW';
type Scope = 'ACCOUNT' | 'GOVERNANCE' | 'DOCUMENT' | 'INTEGRATION' | 'ORGANISATION' | 'OTHER';
type ReviewState = 'OPEN' | 'ASSESSING' | 'DECISION_REQUIRED';
type RequestRecord = {
  id: string; caseReference: string; kind: Kind; scope: Scope;
  receivedAt: string; targetResponseAt: string | null; responseSentAt: string | null;
  reviewState: ReviewState; updatedAt: string;
};
type ReviewEvent = {
  id: string; previousState: ReviewState | null; nextState: ReviewState;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
type PageResult = { items: RequestRecord[]; nextCursor: string | null };
type EventPageResult = { items: ReviewEvent[]; nextCursor: string | null };
type TargetEvent = {
  id: string; previousTargetAt: string | null; nextTargetAt: string | null;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
type TargetEventPage = { items: TargetEvent[]; nextCursor: string | null };
type ResponseEvent = {
  id: string; previousResponseAt: string | null; nextResponseAt: string | null;
  reason: string; evidenceRef: string | null; actorUserId: string; occurredAt: string;
};
type ResponseEventPage = { items: ResponseEvent[]; nextCursor: string | null };
type StorageLink = {
  id: string; deletionId: string; actorUserId: string; reason: string; createdAt: string;
  withdrawal: { actorUserId: string; reason: string; createdAt: string } | null;
  deletion: { sourceDocumentId: string | null; provider: string; state: string; attempts: number; processedAt: string | null;
    activeObjectAbsentAt: string | null; terminalReason: string | null };
};
type StorageLinkPage = { items: StorageLink[]; nextCursor: string | null };
type DocumentLink = {
  id: string; documentId: string; actorUserId: string; reason: string; createdAt: string;
  withdrawal: { actorUserId: string; reason: string; createdAt: string } | null;
};
type DocumentLinkPage = { items: DocumentLink[]; nextCursor: string | null };
type SourceJob = {
  id: string; sourceDocumentId: string; provider: string; state: string;
  attempts: number; processedAt: string | null; activeObjectAbsentAt: string | null;
  terminalReason: string | null; createdAt: string;
};
type SourceJobPage = { items: SourceJob[]; nextCursor: string | null };

const stateLabels: Record<ReviewState, string> = {
  OPEN: 'Open', ASSESSING: 'Under review', DECISION_REQUIRED: 'Decision required',
};
const fieldClass = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-50';

function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function DataLifecyclePage() {
  useDocumentTitle('Data Requests');
  const { user } = useAuth();
  const canReview = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const [records, setRecords] = useState<RequestRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [dueRecords, setDueRecords] = useState<RequestRecord[]>([]);
  const [nextDueCursor, setNextDueCursor] = useState<string | null>(null);
  const [loadingDue, setLoadingDue] = useState(false);
  const [dueError, setDueError] = useState('');
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [nextEventCursor, setNextEventCursor] = useState<string | null>(null);
  const [targetEvents, setTargetEvents] = useState<TargetEvent[]>([]);
  const [nextTargetCursor, setNextTargetCursor] = useState<string | null>(null);
  const [responseEvents, setResponseEvents] = useState<ResponseEvent[]>([]);
  const [nextResponseCursor, setNextResponseCursor] = useState<string | null>(null);
  const [storageLinks, setStorageLinks] = useState<StorageLink[]>([]);
  const [nextStorageCursor, setNextStorageCursor] = useState<string | null>(null);
  const [documentLinks, setDocumentLinks] = useState<DocumentLink[]>([]);
  const [nextDocumentCursor, setNextDocumentCursor] = useState<string | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [loadingResponses, setLoadingResponses] = useState(false);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const selectedRequestId = useRef<string | null>(null);
  const sourceLookupGeneration = useRef(0);
  const listGeneration = useRef(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [caseReference, setCaseReference] = useState('');
  const [lookupReference, setLookupReference] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [kind, setKind] = useState<Kind>('ERASURE');
  const [scope, setScope] = useState<Scope>('ACCOUNT');
  const [receivedLocal, setReceivedLocal] = useState(localDateTime);
  const [nextState, setNextState] = useState<ReviewState>('ASSESSING');
  const [reason, setReason] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [targetLocal, setTargetLocal] = useState('');
  const [targetReason, setTargetReason] = useState('');
  const [targetEvidenceRef, setTargetEvidenceRef] = useState('');
  const [responseLocal, setResponseLocal] = useState('');
  const [responseReason, setResponseReason] = useState('');
  const [responseEvidenceRef, setResponseEvidenceRef] = useState('');
  const [deletionId, setDeletionId] = useState('');
  const [sourceDocumentId, setSourceDocumentId] = useState('');
  const [sourceJobs, setSourceJobs] = useState<SourceJob[]>([]);
  const [nextSourceCursor, setNextSourceCursor] = useState<string | null>(null);
  const [sourceLookupPerformed, setSourceLookupPerformed] = useState(false);
  const [sourceLookupBusy, setSourceLookupBusy] = useState(false);
  const [sourceLookupError, setSourceLookupError] = useState('');
  const [storageLinkReason, setStorageLinkReason] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [documentLinkReason, setDocumentLinkReason] = useState('');
  const [withdrawingDocumentLinkId, setWithdrawingDocumentLinkId] = useState<string | null>(null);
  const [documentWithdrawalReason, setDocumentWithdrawalReason] = useState('');
  const [withdrawingLinkId, setWithdrawingLinkId] = useState<string | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState('');

  const load = useCallback(async (before?: string) => {
    const generation = before ? listGeneration.current : ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const response = await api.get<PageResult>('/data-lifecycle/requests', {
        params: before ? { before } : undefined,
      });
      if (generation !== listGeneration.current) return;
      const data = response.data;
      setRecords((previous) => {
        if (!before) return data.items;
        const seen = new Set(previous.map((record) => record.id));
        return [...previous, ...data.items.filter((record) => !seen.has(record.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (cause) {
      if (generation === listGeneration.current) {
        setError(apiErrorMessage(cause, 'Data requests could not be loaded.'));
      }
    } finally {
      if (generation === listGeneration.current) setLoading(false);
    }
  }, []);

  const loadDue = useCallback(async (before?: string) => {
    setLoadingDue(true);
    setDueError('');
    try {
      const response = await api.get<PageResult>('/data-lifecycle/requests/due-targets', {
        params: before ? { before } : undefined,
      });
      setDueRecords((previous) => before
        ? [...previous, ...response.data.items.filter((item) => !previous.some((record) => record.id === item.id))]
        : response.data.items);
      setNextDueCursor(response.data.nextCursor);
    } catch (cause) {
      setDueError(apiErrorMessage(cause, 'Past response targets could not be loaded.'));
    } finally {
      setLoadingDue(false);
    }
  }, []);

  useEffect(() => { if (canReview) { void load(); void loadDue(); } }, [canReview, load, loadDue]);

  const selectRecord = async (record: RequestRecord) => {
    selectedRequestId.current = record.id;
    sourceLookupGeneration.current += 1;
    setSelected(record);
    setEvents([]);
    setNextEventCursor(null);
    setTargetEvents([]);
    setNextTargetCursor(null);
    setResponseEvents([]);
    setNextResponseCursor(null);
    setStorageLinks([]);
    setNextStorageCursor(null);
    setDocumentLinks([]);
    setNextDocumentCursor(null);
    setDocumentId('');
    setDocumentLinkReason('');
    setSourceDocumentId('');
    setSourceJobs([]);
    setNextSourceCursor(null);
    setSourceLookupPerformed(false);
    setSourceLookupBusy(false);
    setSourceLookupError('');
    setNextState(record.reviewState === 'OPEN' ? 'ASSESSING' : 'DECISION_REQUIRED');
    setReason('');
    setEvidenceRef('');
    setTargetLocal(toLocalDateTime(record.targetResponseAt));
    setTargetReason('');
    setTargetEvidenceRef('');
    setResponseLocal(toLocalDateTime(record.responseSentAt));
    setResponseReason('');
    setResponseEvidenceRef('');
    setWithdrawingLinkId(null);
    setWithdrawalReason('');
    setWithdrawingDocumentLinkId(null);
    setDocumentWithdrawalReason('');
    setError('');
    setLoadingEvents(true);
    setLoadingTargets(true);
    setLoadingResponses(true);
    setLoadingStorage(true);
    setLoadingDocuments(true);
    try {
      const [response, targets, sent, links, documents] = await Promise.all([
        api.get<EventPageResult>(`/data-lifecycle/requests/${record.id}/events`),
        api.get<TargetEventPage>(`/data-lifecycle/requests/${record.id}/target-events`),
        api.get<ResponseEventPage>(`/data-lifecycle/requests/${record.id}/response-events`),
        api.get<StorageLinkPage>(`/data-lifecycle/requests/${record.id}/storage-links`),
        api.get<DocumentLinkPage>(`/data-lifecycle/requests/${record.id}/document-links`),
      ]);
      if (selectedRequestId.current === record.id) {
        setEvents(response.data.items);
        setNextEventCursor(response.data.nextCursor);
        setTargetEvents(targets.data.items);
        setNextTargetCursor(targets.data.nextCursor);
        setResponseEvents(sent.data.items);
        setNextResponseCursor(sent.data.nextCursor);
        setStorageLinks(links.data.items);
        setNextStorageCursor(links.data.nextCursor);
        setDocumentLinks(documents.data.items);
        setNextDocumentCursor(documents.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === record.id) {
        setError(apiErrorMessage(cause, 'Case history or linked records could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === record.id) {
        setLoadingEvents(false);
        setLoadingTargets(false);
        setLoadingResponses(false);
        setLoadingStorage(false);
        setLoadingDocuments(false);
      }
    }
  };

  const loadOlderEvents = async () => {
    if (!selected || !nextEventCursor || loadingEvents) return;
    const requestId = selected.id;
    setLoadingEvents(true);
    setError('');
    try {
      const response = await api.get<EventPageResult>(`/data-lifecycle/requests/${requestId}/events?before=${encodeURIComponent(nextEventCursor)}`);
      if (selectedRequestId.current === requestId) {
        setEvents((previous) => [...previous, ...response.data.items]);
        setNextEventCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'Older review history could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === requestId) setLoadingEvents(false);
    }
  };

  const loadOlderTargetEvents = async () => {
    if (!selected || !nextTargetCursor || loadingTargets) return;
    const requestId = selected.id;
    setLoadingTargets(true);
    setError('');
    try {
      const response = await api.get<TargetEventPage>(
        `/data-lifecycle/requests/${requestId}/target-events?before=${encodeURIComponent(nextTargetCursor)}`,
      );
      if (selectedRequestId.current === requestId) {
        setTargetEvents((previous) => [...previous, ...response.data.items]);
        setNextTargetCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'Older response-target history could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === requestId) setLoadingTargets(false);
    }
  };

  const loadOlderResponseEvents = async () => {
    if (!selected || !nextResponseCursor || loadingResponses) return;
    const requestId = selected.id;
    setLoadingResponses(true);
    setError('');
    try {
      const response = await api.get<ResponseEventPage>(
        `/data-lifecycle/requests/${requestId}/response-events?before=${encodeURIComponent(nextResponseCursor)}`,
      );
      if (selectedRequestId.current === requestId) {
        setResponseEvents((previous) => [...previous, ...response.data.items]);
        setNextResponseCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'Older sent-response history could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === requestId) setLoadingResponses(false);
    }
  };

  const loadOlderStorageLinks = async () => {
    if (!selected || !nextStorageCursor || loadingStorage) return;
    const requestId = selected.id;
    setLoadingStorage(true);
    setError('');
    try {
      const response = await api.get<StorageLinkPage>(
        `/data-lifecycle/requests/${requestId}/storage-links?before=${encodeURIComponent(nextStorageCursor)}`,
      );
      if (selectedRequestId.current === requestId) {
        setStorageLinks((previous) => [...previous, ...response.data.items]);
        setNextStorageCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'Older storage links could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === requestId) setLoadingStorage(false);
    }
  };

  const loadOlderDocumentLinks = async () => {
    if (!selected || !nextDocumentCursor || loadingDocuments) return;
    const requestId = selected.id;
    setLoadingDocuments(true);
    setError('');
    try {
      const response = await api.get<DocumentLinkPage>(
        `/data-lifecycle/requests/${requestId}/document-links?before=${encodeURIComponent(nextDocumentCursor)}`,
      );
      if (selectedRequestId.current === requestId) {
        setDocumentLinks((previous) => [...previous, ...response.data.items]);
        setNextDocumentCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'Older Vault links could not be loaded.'));
      }
    } finally {
      if (selectedRequestId.current === requestId) setLoadingDocuments(false);
    }
  };

  const submitDocumentLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const requestId = selected.id;
    setSaving(true);
    setError('');
    try {
      await api.post(`/data-lifecycle/requests/${requestId}/document-links`, {
        documentId: documentId.trim(), reason: documentLinkReason.trim(),
      });
      const response = await api.get<DocumentLinkPage>(`/data-lifecycle/requests/${requestId}/document-links`);
      if (selectedRequestId.current === requestId) {
        setDocumentLinks(response.data.items);
        setNextDocumentCursor(response.data.nextCursor);
        setDocumentId('');
        setDocumentLinkReason('');
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'The Vault document could not be linked to this case.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const submitDocumentWithdrawal = async (event: FormEvent<HTMLFormElement>, linkId: string) => {
    event.preventDefault();
    if (!selected || withdrawingDocumentLinkId !== linkId) return;
    const requestId = selected.id;
    setSaving(true);
    setError('');
    try {
      await api.post(`/data-lifecycle/requests/${requestId}/document-links/${linkId}/withdraw`, {
        reason: documentWithdrawalReason.trim(),
      });
      const response = await api.get<DocumentLinkPage>(`/data-lifecycle/requests/${requestId}/document-links`);
      if (selectedRequestId.current === requestId) {
        setDocumentLinks(response.data.items);
        setNextDocumentCursor(response.data.nextCursor);
        setWithdrawingDocumentLinkId(null);
        setDocumentWithdrawalReason('');
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'The Vault link could not be withdrawn.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const submitStorageLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const requestId = selected.id;
    setSaving(true);
    setError('');
    try {
      await api.post(`/data-lifecycle/requests/${requestId}/storage-links`, {
        deletionId: deletionId.trim(), reason: storageLinkReason.trim(),
      });
      const response = await api.get<StorageLinkPage>(`/data-lifecycle/requests/${requestId}/storage-links`);
      if (selectedRequestId.current === requestId) {
        setStorageLinks(response.data.items);
        setNextStorageCursor(response.data.nextCursor);
        setDeletionId('');
        setStorageLinkReason('');
        sourceLookupGeneration.current += 1;
        setSourceDocumentId('');
        setSourceJobs([]);
        setNextSourceCursor(null);
        setSourceLookupPerformed(false);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'The storage job could not be linked to this case.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const findSourceJobs = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const requestId = selected.id;
    const generation = ++sourceLookupGeneration.current;
    setSourceLookupBusy(true);
    setSourceLookupPerformed(false);
    setSourceLookupError('');
    setSourceJobs([]);
    setNextSourceCursor(null);
    try {
      const response = await api.get<SourceJobPage>('/data-lifecycle/storage-deletions/by-source', {
        params: { sourceDocumentId: sourceDocumentId.trim() },
      });
      if (selectedRequestId.current === requestId && sourceLookupGeneration.current === generation) {
        setSourceJobs(response.data.items);
        setNextSourceCursor(response.data.nextCursor);
        setSourceLookupPerformed(true);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId && sourceLookupGeneration.current === generation) {
        setSourceLookupError(apiErrorMessage(cause, 'Storage jobs could not be found by this document ID.'));
      }
    } finally {
      if (sourceLookupGeneration.current === generation) setSourceLookupBusy(false);
    }
  };

  const loadOlderSourceJobs = async () => {
    if (!selected || !nextSourceCursor || sourceLookupBusy) return;
    const requestId = selected.id;
    const generation = sourceLookupGeneration.current;
    setSourceLookupBusy(true);
    setSourceLookupError('');
    try {
      const response = await api.get<SourceJobPage>('/data-lifecycle/storage-deletions/by-source', {
        params: { sourceDocumentId: sourceDocumentId.trim(), before: nextSourceCursor },
      });
      if (selectedRequestId.current === requestId && sourceLookupGeneration.current === generation) {
        setSourceJobs((previous) => {
          const seen = new Set(previous.map((job) => job.id));
          return [...previous, ...response.data.items.filter((job) => !seen.has(job.id))];
        });
        setNextSourceCursor(response.data.nextCursor);
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId && sourceLookupGeneration.current === generation) {
        setSourceLookupError(apiErrorMessage(cause, 'Older storage job matches could not be loaded.'));
      }
    } finally {
      if (sourceLookupGeneration.current === generation) setSourceLookupBusy(false);
    }
  };

  const submitWithdrawal = async (event: FormEvent<HTMLFormElement>, linkId: string) => {
    event.preventDefault();
    if (!selected || withdrawingLinkId !== linkId) return;
    const requestId = selected.id;
    setSaving(true);
    setError('');
    try {
      await api.post(`/data-lifecycle/requests/${requestId}/storage-links/${linkId}/withdraw`, {
        reason: withdrawalReason.trim(),
      });
      const response = await api.get<StorageLinkPage>(`/data-lifecycle/requests/${requestId}/storage-links`);
      if (selectedRequestId.current === requestId) {
        setStorageLinks(response.data.items);
        setNextStorageCursor(response.data.nextCursor);
        setWithdrawingLinkId(null);
        setWithdrawalReason('');
      }
    } catch (cause) {
      if (selectedRequestId.current === requestId) {
        setError(apiErrorMessage(cause, 'The storage link could not be withdrawn.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const lookupCase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLookingUp(true);
    setError('');
    try {
      const response = await api.get<RequestRecord>('/data-lifecycle/requests/by-reference', {
        params: { caseReference: lookupReference.trim() },
      });
      await selectRecord(response.data);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'No request was found for that case reference.'));
    } finally {
      setLookingUp(false);
    }
  };

  const submitIntake = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const receivedAt = new Date(receivedLocal);
      if (Number.isNaN(receivedAt.getTime())) throw new Error('Enter a valid received date and time.');
      await api.post('/data-lifecycle/requests', {
        caseReference: caseReference.trim(), kind, scope, receivedAt: receivedAt.toISOString(),
      });
      setCaseReference('');
      setReceivedLocal(localDateTime());
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The request could not be recorded.'));
    } finally {
      setSaving(false);
    }
  };

  const submitTriage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const response = await api.post<RequestRecord>(`/data-lifecycle/requests/${selected.id}/triage`, {
        expectedUpdatedAt: selected.updatedAt, nextState, reason: reason.trim(),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      });
      await load();
      await loadDue();
      await selectRecord(response.data);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The review could not be saved. Reload the case if it changed.'));
    } finally {
      setSaving(false);
    }
  };

  const submitResponseTarget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const targetResponseAt = targetLocal ? new Date(targetLocal) : null;
      if (targetResponseAt && Number.isNaN(targetResponseAt.getTime())) {
        throw new Error('Enter a valid response target date and time.');
      }
      const response = await api.post<RequestRecord>(`/data-lifecycle/requests/${selected.id}/response-target`, {
        expectedUpdatedAt: selected.updatedAt,
        targetResponseAt: targetResponseAt?.toISOString() ?? null,
        reason: targetReason.trim(),
        ...(targetEvidenceRef.trim() ? { evidenceRef: targetEvidenceRef.trim() } : {}),
      });
      await load();
      await loadDue();
      await selectRecord(response.data);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The response target could not be saved. Reload the case if it changed.'));
    } finally {
      setSaving(false);
    }
  };

  const submitResponseSent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const responseSentAt = responseLocal ? new Date(responseLocal) : null;
      if (responseSentAt && Number.isNaN(responseSentAt.getTime())) {
        throw new Error('Enter a valid actual response date and time.');
      }
      const response = await api.post<RequestRecord>(`/data-lifecycle/requests/${selected.id}/response-sent`, {
        expectedUpdatedAt: selected.updatedAt,
        responseSentAt: responseSentAt?.toISOString() ?? null,
        reason: responseReason.trim(),
        ...(responseEvidenceRef.trim() ? { evidenceRef: responseEvidenceRef.trim() } : {}),
      });
      await load();
      await loadDue();
      await selectRecord(response.data);
    } catch (cause) {
      setError(apiErrorMessage(cause, 'The actual response date could not be saved. Reload the case if it changed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppPage eyebrow="Admin review" title="Data Requests"
      description="Record erasure and retention review requests, then track assessment and evidence. A review state never means that data was deleted or permanently purged.">
      {!canReview ? <PermissionHint>Only Owners and Admins can review data requests.</PermissionHint> : <>
        <AppSection title="Before recording a request" description="Keep the requester's identity and correspondence in the controlled case archive. Enter only its opaque reference here; no names, email addresses, document contents or tokens.">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This queue records intake, triage and reviewed links to Vault records and technical deletion jobs. The approved schedule, holds, deleted-item recovery, object and backup expiry, and final purge proof remain separate work. See <Link className="text-teal-primary underline" href="/governance-audit">Governance Audit</Link> for existing document and integration histories.
          </p>
        </AppSection>

        <AppSection title="Record request">
          <form onSubmit={submitIntake} className="grid gap-4 md:grid-cols-2">
            <Input label="Opaque case reference" value={caseReference} onValueChange={setCaseReference}
              description="Uppercase letters, numbers and hyphens only; 3–120 characters." isRequired maxLength={120} />
            <label className="block text-sm font-medium">Request type
              <select className={`mt-2 ${fieldClass}`} value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                <option value="ERASURE">Erasure</option><option value="RETENTION_REVIEW">Retention review</option>
              </select>
            </label>
            <label className="block text-sm font-medium">Data area
              <select className={`mt-2 ${fieldClass}`} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
                <option value="ACCOUNT">Account and access</option><option value="GOVERNANCE">Governance records</option>
                <option value="DOCUMENT">Documents</option><option value="INTEGRATION">External integration</option>
                <option value="ORGANISATION">Whole organisation</option><option value="OTHER">Other</option>
              </select>
            </label>
            <label className="block text-sm font-medium">Received date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={receivedLocal}
                onChange={(event) => setReceivedLocal(event.target.value)} required />
            </label>
            <div className="md:col-span-2"><Button type="submit" color="primary" isLoading={saving} isDisabled={saving}>Record request</Button></div>
          </form>
        </AppSection>

        {error ? <ErrorState title="Data request action needs attention" description={error} action={<Button size="sm" onPress={() => void load()}>Reload requests</Button>} /> : null}
        <AppSection title="Past response targets" description="Reviewer-entered targets that have passed, ordered by target date. A past target needs case review; it does not prove a legal deadline was missed or that erasure is due.">
          <Button size="sm" variant="flat" onPress={() => void loadDue()} isLoading={loadingDue}>Refresh targets</Button>
          {dueError ? <ErrorState title="Past targets unavailable" description={dueError} action={<Button size="sm" onPress={() => void loadDue()}>Retry</Button>} /> : null}
          {!loadingDue && dueRecords.length === 0 && !dueError ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No past response targets recorded.</p> : null}
          <ol className="mt-3 space-y-2">{dueRecords.map((record) => <li key={record.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div><strong>{record.caseReference}</strong><p className="text-sm text-gray-600 dark:text-gray-300">
              Target {new Date(record.targetResponseAt!).toLocaleString('en-IE')} · {stateLabels[record.reviewState]}
            </p></div>
            <Button size="sm" variant="flat" onPress={() => void selectRecord(record)}>Review</Button>
          </li>)}</ol>
          {nextDueCursor ? <Button className="mt-3" size="sm" variant="flat" onPress={() => void loadDue(nextDueCursor)}
            isLoading={loadingDue} isDisabled={loadingDue}>Load later past targets</Button> : null}
        </AppSection>
        {loading && records.length === 0 ? <LoadingState title="Loading data requests" description="Reading the review queue." /> : null}
        <AppSection title="Review queue" description="All states below are unresolved assessment states. Older requests can be loaded in pages of 50.">
          <form onSubmit={lookupCase} className="mb-4 flex flex-wrap items-end gap-3">
            <Input className="max-w-sm" label="Find by case reference" value={lookupReference}
              onValueChange={setLookupReference} description="Exact opaque reference from the controlled case archive."
              maxLength={120} isRequired />
            <Button type="submit" variant="flat" isLoading={lookingUp}
              isDisabled={lookingUp || !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(lookupReference.trim())}>Find request</Button>
          </form>
          {records.length === 0 && !loading ? <p className="text-sm text-gray-600 dark:text-gray-300">No requests recorded.</p> : null}
          <ol className="space-y-2">
            {records.map((record) => <li key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div><strong>{record.caseReference}</strong><p className="text-sm text-gray-600 dark:text-gray-300">
                {record.kind.replace('_', ' ')} · {record.scope.replace('_', ' ')} · received {new Date(record.receivedAt).toLocaleString('en-IE')} · {stateLabels[record.reviewState]}
              </p>{record.targetResponseAt ? <p className="text-sm text-gray-600 dark:text-gray-300">
                Reviewer target: {new Date(record.targetResponseAt).toLocaleString('en-IE')}
                {dueRecords.some((due) => due.id === record.id) ? ' · past target' : ''}
              </p> : null}{record.responseSentAt ? <p className="text-sm text-gray-600 dark:text-gray-300">
                Response recorded: {new Date(record.responseSentAt).toLocaleString('en-IE')}
              </p> : null}</div>
              <Button size="sm" variant="flat" onPress={() => void selectRecord(record)}>Review</Button>
            </li>)}
          </ol>
          {nextCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loading} isDisabled={loading}
            onPress={() => void load(nextCursor)}>Load older requests</Button> : null}
        </AppSection>

        {selected ? <AppSection title={`Review ${selected.caseReference}`} description="Record a change in assessment state with its reason. This cannot mark erasure complete.">
          <h3 className="font-semibold">Response target</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            This is a case-specific operational target entered by a reviewer. CharityPilot does not calculate a statutory deadline or authorise deletion from it. Keep the legal basis and correspondence in the controlled case archive.
          </p>
          <form onSubmit={submitResponseTarget} className="mt-3 space-y-4">
            <label className="block text-sm font-medium">Target response date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={targetLocal}
                onChange={(event) => setTargetLocal(event.target.value)} />
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-300">Leave the date blank to withdraw a previously entered target.</p>
            <Textarea label="Reason for target change" value={targetReason} onValueChange={setTargetReason}
              minRows={2} isRequired description="Explain the target or its withdrawal without personal details." />
            <Input label="Opaque target evidence reference" value={targetEvidenceRef} onValueChange={setTargetEvidenceRef}
              description="Optional controlled-archive reference." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving}
              isDisabled={saving || targetReason.trim().length < 10}>Save response target</Button>
          </form>
          <h4 className="mt-5 font-semibold">Response-target history</h4>
          {targetEvents.length === 0 ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">No target has been recorded.</p> : null}
          <ol className="mt-2 space-y-2">{targetEvents.map((entry) => <li key={entry.id}
            className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousTargetAt ? new Date(entry.previousTargetAt).toLocaleString('en-IE') : 'No target'} → {entry.nextTargetAt ? new Date(entry.nextTargetAt).toLocaleString('en-IE') : 'No target'}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextTargetCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingTargets}
            onPress={() => void loadOlderTargetEvents()}>Load older target changes</Button> : null}

          <h3 className="mt-8 font-semibold">Actual response sent</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Record the date and controlled-archive reference only after checking that a response was sent. This is separate from the planned target and does not close the case, establish lawful retention expiry or prove erasure.
          </p>
          <form onSubmit={submitResponseSent} className="mt-3 space-y-4">
            <label className="block text-sm font-medium">Actual response date and time
              <input className={`mt-2 ${fieldClass}`} type="datetime-local" value={responseLocal}
                onChange={(event) => setResponseLocal(event.target.value)} />
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-300">Leave the date blank to withdraw an incorrect response entry. Its earlier event remains in history.</p>
            <Textarea label="Reason for response record or correction" value={responseReason} onValueChange={setResponseReason}
              minRows={2} isRequired description="Explain the entry or correction without personal details." />
            <Input label="Opaque response evidence reference" value={responseEvidenceRef} onValueChange={setResponseEvidenceRef}
              description="Required when recording a sent response; use the controlled correspondence archive reference." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving}
              isDisabled={saving || responseReason.trim().length < 10 || Boolean(responseLocal && !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(responseEvidenceRef.trim()))}>
              Save actual response date
            </Button>
          </form>
          <h4 className="mt-5 font-semibold">Sent-response history</h4>
          {responseEvents.length === 0 && !loadingResponses ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">No response date has been recorded.</p> : null}
          <ol className="mt-2 space-y-2">{responseEvents.map((entry) => <li key={entry.id}
            className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousResponseAt ? new Date(entry.previousResponseAt).toLocaleString('en-IE') : 'No response date'} → {entry.nextResponseAt ? new Date(entry.nextResponseAt).toLocaleString('en-IE') : 'No response date'}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextResponseCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingResponses}
            onPress={() => void loadOlderResponseEvents()}>Load older response changes</Button> : null}

          <h3 className="mt-8 font-semibold">Review state</h3>
          <form onSubmit={submitTriage} className="space-y-4">
            <label className="block text-sm font-medium">Review state
              <select className={`mt-2 ${fieldClass}`} value={nextState} onChange={(event) => setNextState(event.target.value as ReviewState)}>
                {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <Textarea label="Reason for change" value={reason} onValueChange={setReason} minRows={2} isRequired
              description="Keep personal details in the controlled case archive; record the assessment step here." />
            <Input label="Opaque evidence reference" value={evidenceRef} onValueChange={setEvidenceRef}
              description="Optional archive reference, uppercase letters, numbers and hyphens only." maxLength={120} />
            <Button type="submit" color="primary" isLoading={saving} isDisabled={saving || nextState === selected.reviewState || reason.trim().length < 10}>Save review state</Button>
          </form>
          <h3 className="mt-6 font-semibold">Review history</h3>
          <ol className="mt-2 space-y-2">{events.map((entry) => <li key={entry.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{entry.previousState ? stateLabels[entry.previousState] : 'Intake'} → {stateLabels[entry.nextState]}</strong>
            <span className="ml-2 text-gray-600 dark:text-gray-300">{new Date(entry.occurredAt).toLocaleString('en-IE')}</span>
            <p>{entry.reason}</p>{entry.evidenceRef ? <p>Evidence: {entry.evidenceRef}</p> : null}
          </li>)}</ol>
          {nextEventCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingEvents}
            onPress={() => void loadOlderEvents()}>Load older review events</Button> : null}

          <DataLifecycleCoverage key={selected.id} requestId={selected.id} />

          <h3 className="mt-8 font-semibold">Linked Vault documents</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Link an exact live Vault document ID only after checking the requester and record in the controlled case archive. This records a review association; it does not approve deletion or establish that every copy was found. The ID remains in case history if an eligible draft is later removed.
          </p>
          <form onSubmit={submitDocumentLink} className="mt-4 grid gap-3 md:grid-cols-2">
            <Input label="Vault document ID" value={documentId} onValueChange={setDocumentId}
              description="Server-issued ID from the controlled Vault record or Governance Audit; no names or file contents."
              maxLength={100} isRequired />
            <Input label="Reason for linking Vault document" value={documentLinkReason} onValueChange={setDocumentLinkReason}
              description="10–500 characters. Keep personal details in the controlled archive."
              maxLength={500} isRequired />
            <div className="md:col-span-2"><Button type="submit" variant="flat" isLoading={saving}
              isDisabled={saving || !/^[A-Za-z0-9_-]{1,100}$/.test(documentId.trim()) || documentLinkReason.trim().length < 10}>
              Link Vault document
            </Button></div>
          </form>
          {loadingDocuments && documentLinks.length === 0 ? <p className="mt-3 text-sm">Loading linked Vault records…</p> : null}
          <ol className="mt-3 space-y-2">{documentLinks.map((link) => <li key={link.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{link.documentId}</strong> · {link.withdrawal ? 'Withdrawn association' : 'Active association'}
            <p className="text-xs text-gray-600 dark:text-gray-300">Linked {new Date(link.createdAt).toLocaleString('en-IE')} by {link.actorUserId}. {link.reason}</p>
            {link.withdrawal ? <p className="text-xs text-amber-800 dark:text-amber-200">Withdrawn {new Date(link.withdrawal.createdAt).toLocaleString('en-IE')} by {link.withdrawal.actorUserId}: {link.withdrawal.reason}</p> : null}
            {!link.withdrawal && withdrawingDocumentLinkId === link.id ? <form className="mt-3 space-y-2" onSubmit={(event) => void submitDocumentWithdrawal(event, link.id)}>
              <Input label={`Reason for withdrawing ${link.documentId}`} value={documentWithdrawalReason} onValueChange={setDocumentWithdrawalReason}
                description="10–500 characters; explain the correction without personal details." maxLength={500} isRequired />
              <Button type="submit" size="sm" variant="flat" isLoading={saving} isDisabled={saving || documentWithdrawalReason.trim().length < 10}>Record withdrawal</Button>
              <Button type="button" size="sm" variant="light" onPress={() => { setWithdrawingDocumentLinkId(null); setDocumentWithdrawalReason(''); }}>Cancel</Button>
            </form> : null}
            {!link.withdrawal && withdrawingDocumentLinkId !== link.id ? <Button className="mt-2" size="sm" variant="light"
              onPress={() => { setWithdrawingDocumentLinkId(link.id); setDocumentWithdrawalReason(''); }}>Withdraw association</Button> : null}
          </li>)}</ol>
          {nextDocumentCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingDocuments}
            onPress={() => void loadOlderDocumentLinks()}>Load older Vault links</Button> : null}

          <h3 className="mt-8 font-semibold">Linked storage deletion jobs</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            These are reviewer-recorded associations with technical deletion jobs. A processed job does not establish that this case is complete, that the requester matches the job, or that versions, exports and backups were purged.
          </p>
          <form onSubmit={findSourceJobs} className="mt-4 flex flex-wrap items-end gap-3">
            <Input className="max-w-sm" label="Find jobs by source document ID" value={sourceDocumentId}
              onValueChange={(value) => {
                sourceLookupGeneration.current += 1;
                setSourceDocumentId(value);
                setSourceJobs([]);
                setNextSourceCursor(null);
                setSourceLookupPerformed(false);
                setSourceLookupBusy(false);
                setSourceLookupError('');
              }}
              description="Use the server-issued Vault document ID from the controlled record or audit. Older jobs may have no source ID."
              maxLength={100} isRequired />
            <Button type="submit" variant="flat" isLoading={sourceLookupBusy}
              isDisabled={sourceLookupBusy || !/^[A-Za-z0-9_-]{1,100}$/.test(sourceDocumentId.trim())}>Find jobs</Button>
          </form>
          {sourceLookupError ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{sourceLookupError}</p> : null}
          {sourceLookupPerformed && sourceJobs.length === 0 ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No source-labelled storage job was found for this document ID. Legacy and independent cleanup jobs may have no recorded source.</p> : null}
          {sourceJobs.length > 0 ? <ol className="mt-3 space-y-2">{sourceJobs.map((job) => <li key={job.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{job.id}</strong> · {job.provider} · {job.state} · {job.attempts} attempt(s)
            <p className="text-xs text-gray-600 dark:text-gray-300">Created {new Date(job.createdAt).toLocaleString('en-IE')}. Technical job metadata only; confirm the case association in the controlled archive.</p>
            <Button className="mt-2" size="sm" variant="flat" onPress={() => setDeletionId(job.id)}>Use job ID</Button>
          </li>)}</ol> : null}
          {nextSourceCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={sourceLookupBusy}
            isDisabled={sourceLookupBusy} onPress={() => void loadOlderSourceJobs()}>Load older job matches</Button> : null}
          <form onSubmit={submitStorageLink} className="mt-4 grid gap-3 md:grid-cols-2">
            <Input label="Storage deletion job ID" value={deletionId} onValueChange={setDeletionId}
              description="Copy the exact ID from Governance Audit after checking the controlled case archive."
              maxLength={100} isRequired />
            <Input label="Reason for linking" value={storageLinkReason} onValueChange={setStorageLinkReason}
              description="10–500 characters. Keep names and other personal details in the controlled archive."
              maxLength={500} isRequired />
            <div className="md:col-span-2"><Button type="submit" variant="flat" isLoading={saving}
              isDisabled={saving || !/^[A-Za-z0-9_-]{1,100}$/.test(deletionId.trim()) || storageLinkReason.trim().length < 10}>
              Link storage job
            </Button></div>
          </form>
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">Links and withdrawals remain in the audit history. A withdrawn pair cannot be linked again; record a corrected job ID as a new link.</p>
          {loadingStorage && storageLinks.length === 0 ? <p className="mt-3 text-sm">Loading linked jobs…</p> : null}
          <ol className="mt-3 space-y-2">{storageLinks.map((link) => <li key={link.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{link.deletionId}</strong> · {link.withdrawal ? 'Withdrawn association' : 'Active association'} · {link.deletion.provider} · {link.deletion.state} · {link.deletion.attempts} attempt(s)
            <p className="text-xs text-gray-600 dark:text-gray-300">Linked {new Date(link.createdAt).toLocaleString('en-IE')} by {link.actorUserId}. {link.reason}</p>
            {link.deletion.sourceDocumentId ? <p className="text-xs text-gray-600 dark:text-gray-300">Source Vault document ID recorded at removal: {link.deletion.sourceDocumentId}. This identifies the removed record, not every retained copy.</p> : <p className="text-xs text-gray-600 dark:text-gray-300">No source Vault document ID was recorded for this job.</p>}
            {link.withdrawal ? <p className="text-xs text-amber-800 dark:text-amber-200">Withdrawn {new Date(link.withdrawal.createdAt).toLocaleString('en-IE')} by {link.withdrawal.actorUserId}: {link.withdrawal.reason}</p> : null}
            {link.deletion.activeObjectAbsentAt ? <p className="text-xs text-gray-600 dark:text-gray-300">Active primary object observed absent {new Date(link.deletion.activeObjectAbsentAt).toLocaleString('en-IE')}; versions and backups remain unverified.</p> : null}
            {link.deletion.terminalReason ? <p className="text-xs text-red-700 dark:text-red-300">Needs operator review: {link.deletion.terminalReason}</p> : null}
            {!link.withdrawal && withdrawingLinkId === link.id ? <form className="mt-3 space-y-2" onSubmit={(event) => void submitWithdrawal(event, link.id)}>
              <Input label={`Reason for withdrawing ${link.deletionId}`} value={withdrawalReason} onValueChange={setWithdrawalReason}
                description="10–500 characters; explain the correction without personal details." maxLength={500} isRequired />
              <Button type="submit" size="sm" variant="flat" isLoading={saving} isDisabled={saving || withdrawalReason.trim().length < 10}>Record withdrawal</Button>
              <Button type="button" size="sm" variant="light" onPress={() => { setWithdrawingLinkId(null); setWithdrawalReason(''); }}>Cancel</Button>
            </form> : null}
            {!link.withdrawal && withdrawingLinkId !== link.id ? <Button className="mt-2" size="sm" variant="light"
              onPress={() => { setWithdrawingLinkId(link.id); setWithdrawalReason(''); }}>Withdraw association</Button> : null}
          </li>)}</ol>
          {nextStorageCursor ? <Button className="mt-3" size="sm" variant="flat" isLoading={loadingStorage}
            onPress={() => void loadOlderStorageLinks()}>Load older storage links</Button> : null}
        </AppSection> : null}
      </>}
    </AppPage>
  );
}
