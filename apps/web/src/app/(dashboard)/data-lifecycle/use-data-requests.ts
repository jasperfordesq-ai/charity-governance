'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import type { Kind, Scope, ReviewState, RequestRecord, ReviewEvent, PageResult, EventPageResult, TargetEvent, TargetEventPage, ResponseEvent, ResponseEventPage, StorageLink, StorageLinkPage, DocumentLink, DocumentLinkPage, SourceJob, SourceJobPage } from './data-request-types';

function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function useDataRequests(canReview: boolean) {
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

  return {
    records,
    nextCursor,
    dueRecords,
    nextDueCursor,
    loadingDue,
    dueError,
    selected,
    events,
    nextEventCursor,
    targetEvents,
    nextTargetCursor,
    responseEvents,
    nextResponseCursor,
    storageLinks,
    nextStorageCursor,
    documentLinks,
    nextDocumentCursor,
    loadingEvents,
    loadingTargets,
    loadingResponses,
    loadingStorage,
    loadingDocuments,
    sourceLookupGeneration,
    loading,
    saving,
    error,
    caseReference,
    setCaseReference,
    lookupReference,
    setLookupReference,
    lookingUp,
    kind,
    setKind,
    scope,
    setScope,
    receivedLocal,
    setReceivedLocal,
    nextState,
    setNextState,
    reason,
    setReason,
    evidenceRef,
    setEvidenceRef,
    targetLocal,
    setTargetLocal,
    targetReason,
    setTargetReason,
    targetEvidenceRef,
    setTargetEvidenceRef,
    responseLocal,
    setResponseLocal,
    responseReason,
    setResponseReason,
    responseEvidenceRef,
    setResponseEvidenceRef,
    deletionId,
    setDeletionId,
    sourceDocumentId,
    setSourceDocumentId,
    sourceJobs,
    setSourceJobs,
    nextSourceCursor,
    setNextSourceCursor,
    sourceLookupPerformed,
    setSourceLookupPerformed,
    sourceLookupBusy,
    setSourceLookupBusy,
    sourceLookupError,
    setSourceLookupError,
    storageLinkReason,
    setStorageLinkReason,
    documentId,
    setDocumentId,
    documentLinkReason,
    setDocumentLinkReason,
    withdrawingDocumentLinkId,
    setWithdrawingDocumentLinkId,
    documentWithdrawalReason,
    setDocumentWithdrawalReason,
    withdrawingLinkId,
    setWithdrawingLinkId,
    withdrawalReason,
    setWithdrawalReason,
    load,
    loadDue,
    selectRecord,
    loadOlderEvents,
    loadOlderTargetEvents,
    loadOlderResponseEvents,
    loadOlderStorageLinks,
    loadOlderDocumentLinks,
    submitDocumentLink,
    submitDocumentWithdrawal,
    submitStorageLink,
    findSourceJobs,
    loadOlderSourceJobs,
    submitWithdrawal,
    lookupCase,
    submitIntake,
    submitTriage,
    submitResponseTarget,
    submitResponseSent,
  };
}
