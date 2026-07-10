'use client';

import { logClientError } from '@/lib/client-logger';
import { api } from '@/lib/api';
import {
  ComplianceAutosaveQueue,
  type ComplianceAutosaveFlushOutcome,
  type ComplianceRevisionConflict,
} from '@/lib/compliance-autosave-queue';
import { apiErrorMessage } from '@/lib/errors';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComplianceRecordResponse,
  GovernancePrincipleResponse,
} from '@charitypilot/shared';
import { ComplianceStatus, getMatrixEntriesForStandard } from '@charitypilot/shared';
import type { SaveState, StandardFormState } from './principle-standard-list';

type ApprovalReadiness = {
  ready: boolean;
  missingExplanations: Array<{
    standardId: string;
    standardCode: string;
    status: 'NOT_APPLICABLE' | 'EXPLAIN';
  }>;
};

type RevisionConflictPayload = {
  response?: {
    data?: {
      code?: string;
      details?: {
        expectedRevision?: number;
        currentRevision?: number;
      };
    };
  };
};

function parseRevisionConflict(error: unknown): ComplianceRevisionConflict | null {
  const payload = (error as RevisionConflictPayload)?.response?.data;
  if (
    payload?.code !== 'COMPLIANCE_RECORD_REVISION_CONFLICT' ||
    !Number.isInteger(payload.details?.expectedRevision) ||
    !Number.isInteger(payload.details?.currentRevision)
  ) {
    return null;
  }

  return {
    expectedRevision: payload.details?.expectedRevision as number,
    currentRevision: payload.details?.currentRevision as number,
  };
}

function complianceRecordToForm(record?: ComplianceRecordResponse): StandardFormState {
  return {
    status: record?.status ?? ComplianceStatus.NOT_STARTED,
    actionTaken: record?.actionTaken ?? '',
    evidence: record?.evidence ?? '',
    notes: record?.notes ?? '',
    explanationIfNA: record?.explanationIfNA ?? '',
  };
}

export function usePrincipleDetailWorkflow() {
  const params = useParams();
  const router = useRouter();
  const principleId = params.principleId as string;

  const currentYear = new Date().getFullYear();
  const [principle, setPrinciple] = useState<GovernancePrincipleResponse | null>(null);
  const [formState, setFormState] = useState<Record<string, StandardFormState>>({});
  const [saveState, setSaveState] = useState<SaveState>({});
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [navigationConfirmOpen, setNavigationConfirmOpen] = useState(false);
  const [navigationConfirmBusy, setNavigationConfirmBusy] = useState(false);
  const [navigationConfirmError, setNavigationConfirmError] = useState('');
  const [pendingNavigationHref, setPendingNavigationHref] = useState('/compliance');

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // The former pendingSaveData ref was not request-generation aware. Each
  // standard now owns a serialized revision-aware queue instead.
  const saveQueues = useRef<Record<string, ComplianceAutosaveQueue<StandardFormState>>>({});
  const formStateRef = useRef<Record<string, StandardFormState>>({});
  const skipNextUnmountFlush = useRef(false);
  const readinessRequestSeq = useRef(0);
  const principleLoadRequestSeq = useRef(0);

  const clearPendingSaveTimers = useCallback(() => {
    Object.values(debounceTimers.current).forEach(clearTimeout);
    debounceTimers.current = {};
  }, []);

  const refreshApprovalReadiness = useCallback(async () => {
    const requestSeq = ++readinessRequestSeq.current;
    try {
      const readinessRes = await api.get(`/compliance/approval-readiness?year=${currentYear}`);
      if (requestSeq === readinessRequestSeq.current) {
        setApprovalReadiness(readinessRes.data);
      }
    } catch (readinessErr) {
      logClientError('Failed to load approval readiness', readinessErr);
      if (requestSeq === readinessRequestSeq.current) {
        setApprovalReadiness(null);
      }
    }
  }, [currentYear]);

  const createSaveQueue = useCallback(
    (standardId: string, initialRevision: number) => {
      const queue = new ComplianceAutosaveQueue<StandardFormState>({
        initialRevision,
        parseConflict: parseRevisionConflict,
        onError: (error) => logClientError(`Failed to save standard ${standardId}`, error),
        save: async (data, expectedRevision) => {
          const response = await api.put(`/compliance/records/${standardId}`, {
            reportingYear: currentYear,
            expectedRevision,
            status: data.status,
            actionTaken: data.actionTaken || null,
            evidence: data.evidence || null,
            notes: data.notes || null,
            explanationIfNA: data.explanationIfNA || null,
          });
          const revision = Number((response.data as { revision?: number } | null)?.revision);
          if (!Number.isInteger(revision) || revision < 1) {
            throw new Error('Compliance save response did not include a valid revision');
          }
          return { revision };
        },
        onStateChange: (snapshot) => {
          if (snapshot.phase === 'saved') {
            const durableGeneration = snapshot.durableGeneration;
            void (async () => {
              await refreshApprovalReadiness();
              const latest = saveQueues.current[standardId]?.getSnapshot();
              if (
                latest?.phase === 'saved' &&
                latest.localGeneration === durableGeneration &&
                latest.durableGeneration === durableGeneration
              ) {
                setSaveState((prev) => ({ ...prev, [standardId]: 'saved' }));
              }
            })();
            return;
          }

          setSaveState((prev) => ({ ...prev, [standardId]: snapshot.phase }));
        },
      });
      return queue;
    },
    [currentYear, refreshApprovalReadiness],
  );

  useEffect(() => {
    const requestSeq = ++principleLoadRequestSeq.current;
    const controller = new AbortController();
    let active = true;

    async function fetchData() {
      setLoading(true);
      setLoadError('');
      try {
        const [principleRes, recordsRes] = await Promise.all([
          api.get(`/compliance/principles/${principleId}`, { signal: controller.signal }),
          api.get(`/compliance/records?principleId=${principleId}&year=${currentYear}`, { signal: controller.signal }),
        ]);
        if (!active || requestSeq !== principleLoadRequestSeq.current) return;

        const nextPrinciple = principleRes.data as GovernancePrincipleResponse;
        setPrinciple(nextPrinciple);

        const records = recordsRes.data?.data ?? recordsRes.data ?? [];
        const initialForm: Record<string, StandardFormState> = {};
        const initialQueues: Record<string, ComplianceAutosaveQueue<StandardFormState>> = {};

        for (const standard of nextPrinciple.standards ?? []) {
          const record = records.find((item: ComplianceRecordResponse) => item.standardId === standard.id);
          initialForm[standard.id] = complianceRecordToForm(record);
          initialQueues[standard.id] = createSaveQueue(standard.id, record?.revision ?? 0);
        }

        Object.values(saveQueues.current).forEach((queue) => queue.dispose());
        saveQueues.current = initialQueues;
        formStateRef.current = initialForm;
        setFormState(initialForm);
        setSaveState({});
        await refreshApprovalReadiness();
      } catch (err) {
        if (!active || requestSeq !== principleLoadRequestSeq.current) return;
        const message = apiErrorMessage(err, 'Compliance principle could not be loaded. Please try again.');
        logClientError('Failed to load principle data', err);
        setPrinciple(null);
        setLoadError(message);
      } finally {
        if (active && requestSeq === principleLoadRequestSeq.current) {
          setLoading(false);
        }
      }
    }

    void fetchData();
    return () => {
      active = false;
      controller.abort();
    };
  }, [principleId, currentYear, createSaveQueue, refreshApprovalReadiness]);

  const flushSave = useCallback(
    async (standardId: string): Promise<ComplianceAutosaveFlushOutcome | undefined> => {
      if (debounceTimers.current[standardId]) {
        clearTimeout(debounceTimers.current[standardId]);
        delete debounceTimers.current[standardId];
      }

      const queue = saveQueues.current[standardId];
      if (!queue) return undefined;
      return queue.flush();
    },
    [],
  );

  const flushAllPendingComplianceSaves = useCallback(
    async () => {
      clearPendingSaveTimers();
      const queues = Object.values(saveQueues.current).filter((queue) => queue.hasUnsettledChanges());
      const outcomes = await Promise.all(queues.map((queue) => queue.flush()));
      return outcomes.every((outcome) => outcome.status === 'saved');
    },
    [clearPendingSaveTimers],
  );

  const discardPendingComplianceSaves = useCallback(() => {
    clearPendingSaveTimers();
    Object.values(saveQueues.current).forEach((queue) => {
      queue.discardQueuedChanges();
      queue.dispose();
    });
    saveQueues.current = {};
    setSaveState({});
  }, [clearPendingSaveTimers]);

  const autoSave = useCallback(
    (standardId: string, data: StandardFormState) => {
      const queue = saveQueues.current[standardId];
      if (!queue) return;
      queue.enqueue(data);

      if (debounceTimers.current[standardId]) {
        clearTimeout(debounceTimers.current[standardId]);
      }

      debounceTimers.current[standardId] = setTimeout(() => {
        void flushSave(standardId);
      }, 800);
    },
    [flushSave],
  );

  const updateField = (standardId: string, field: keyof StandardFormState, value: string) => {
    const current = formStateRef.current[standardId];
    if (!current) return;

    const nextForm = {
      ...current,
      [field]: value,
    };
    formStateRef.current = {
      ...formStateRef.current,
      [standardId]: nextForm,
    };
    setFormState(formStateRef.current);
    autoSave(standardId, nextForm);
  };

  useEffect(() => {
    return () => {
      clearPendingSaveTimers();
      // Async React cleanup cannot guarantee delivery. Explicit navigation
      // drains the queues before leaving; any other unmount only disposes local
      // callbacks and never starts a late background write.
      if (skipNextUnmountFlush.current) return;
      Object.values(saveQueues.current).forEach((queue) => queue.dispose());
    };
  }, [clearPendingSaveTimers]);

  const hasPendingComplianceSaves = useCallback(() => {
    return Object.values(saveQueues.current).some((queue) => queue.hasUnsettledChanges());
  }, []);

  const requestComplianceNavigation = useCallback(
    (href = '/compliance') => {
      if (!hasPendingComplianceSaves()) {
        router.push(href);
        return;
      }

      clearPendingSaveTimers();
      setNavigationConfirmError('');
      setPendingNavigationHref(href);
      setNavigationConfirmOpen(true);
    },
    [clearPendingSaveTimers, hasPendingComplianceSaves, router],
  );

  const stayOnCompliancePage = useCallback(() => {
    if (navigationConfirmBusy) return;
    Object.entries(saveQueues.current).forEach(([standardId, queue]) => {
      const snapshot = queue.getSnapshot();
      if (snapshot.phase === 'dirty' && snapshot.hasQueuedSave) {
        debounceTimers.current[standardId] = setTimeout(() => {
          void flushSave(standardId);
        }, 800);
      }
    });
    setNavigationConfirmError('');
    setNavigationConfirmOpen(false);
  }, [flushSave, navigationConfirmBusy]);

  const leaveWithoutSaving = useCallback(() => {
    skipNextUnmountFlush.current = true;
    discardPendingComplianceSaves();
    setNavigationConfirmError('');
    setNavigationConfirmOpen(false);
    router.push(pendingNavigationHref);
  }, [discardPendingComplianceSaves, pendingNavigationHref, router]);

  const saveAndContinueNavigation = useCallback(async () => {
    setNavigationConfirmBusy(true);
    try {
      const allSaved = await flushAllPendingComplianceSaves();
      if (!allSaved || hasPendingComplianceSaves()) {
        const hasConflict = Object.values(saveQueues.current).some(
          (queue) => queue.getSnapshot().phase === 'conflict',
        );
        setNavigationConfirmError(
          hasConflict
            ? 'A newer saved version needs review. Your local draft is preserved; resolve the conflict before leaving.'
            : 'Could not save every pending edit. Please retry or keep editing.',
        );
        return;
      }

      setNavigationConfirmError('');
      setNavigationConfirmOpen(false);
      router.push(pendingNavigationHref);
    } finally {
      setNavigationConfirmBusy(false);
    }
  }, [flushAllPendingComplianceSaves, hasPendingComplianceSaves, pendingNavigationHref, router]);

  useEffect(() => {
    const interceptInAppNavigation = (event: MouseEvent | PointerEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const anchor = element?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;

      const current = new URL(window.location.href);
      const isSamePageHash =
        destination.pathname === current.pathname &&
        destination.search === current.search &&
        destination.hash.length > 0;
      if (isSamePageHash || !hasPendingComplianceSaves()) return;

      event.preventDefault();
      event.stopPropagation();
      requestComplianceNavigation(`${destination.pathname}${destination.search}${destination.hash}`);
    };

    document.addEventListener('pointerdown', interceptInAppNavigation, true);
    document.addEventListener('mousedown', interceptInAppNavigation, true);
    document.addEventListener('click', interceptInAppNavigation, true);
    return () => {
      document.removeEventListener('pointerdown', interceptInAppNavigation, true);
      document.removeEventListener('mousedown', interceptInAppNavigation, true);
      document.removeEventListener('click', interceptInAppNavigation, true);
    };
  }, [hasPendingComplianceSaves, requestComplianceNavigation]);

  useEffect(() => {
    const warnIfUnsaved = (event: BeforeUnloadEvent) => {
      if (!hasPendingComplianceSaves()) return;

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warnIfUnsaved);
    return () => window.removeEventListener('beforeunload', warnIfUnsaved);
  }, [hasPendingComplianceSaves]);

  const navigateBackToCompliance = useCallback(() => {
    requestComplianceNavigation('/compliance');
  }, [requestComplianceNavigation]);

  const principleMatrixEntries = principle
    ? Array.from(
      new Map(
        principle.standards
          .flatMap((standard) => getMatrixEntriesForStandard(standard.code))
          .map((entry) => [entry.id, entry]),
      ).values(),
    )
    : [];
  const principleMissingExplanations = (approvalReadiness?.missingExplanations ?? []).filter((item) =>
    principle?.standards.some((standard) => standard.id === item.standardId || standard.code === item.standardCode),
  );

  const retrySave = useCallback(
    (standardId: string) => {
      const queue = saveQueues.current[standardId];
      if (!queue) return;
      void queue.retry();
    },
    [],
  );

  const resolveConflictFromServer = useCallback(
    async (standardId: string): Promise<string | null> => {
      const conflictedQueue = saveQueues.current[standardId];
      if (!conflictedQueue || conflictedQueue.getSnapshot().phase !== 'conflict') {
        return 'This standard no longer has a revision conflict.';
      }
      const conflictGeneration = conflictedQueue.getSnapshot().localGeneration;

      try {
        const recordsRes = await api.get(`/compliance/records?principleId=${principleId}&year=${currentYear}`);
        const records = (recordsRes.data?.data ?? recordsRes.data ?? []) as ComplianceRecordResponse[];
        const record = records.find((item: ComplianceRecordResponse) => item.standardId === standardId);

        const latestQueue = saveQueues.current[standardId];
        if (latestQueue !== conflictedQueue) return null;
        if (latestQueue.getSnapshot().localGeneration !== conflictGeneration) {
          return 'Your local draft changed while the saved version was loading, so nothing was discarded. Review the latest draft and try again.';
        }

        const serverForm = complianceRecordToForm(record);
        conflictedQueue.dispose();
        saveQueues.current = {
          ...saveQueues.current,
          [standardId]: createSaveQueue(standardId, record?.revision ?? 0),
        };
        formStateRef.current = {
          ...formStateRef.current,
          [standardId]: serverForm,
        };
        setFormState(formStateRef.current);
        setSaveState((previous) => ({ ...previous, [standardId]: 'idle' }));
        return null;
      } catch (error) {
        logClientError(`Failed to reload conflicted standard ${standardId}`, error);
        return apiErrorMessage(
          error,
          'The latest saved version could not be loaded. Your local draft is still preserved; try again when the connection recovers.',
        );
      }
    },
    [createSaveQueue, currentYear, principleId],
  );

  return {
    currentYear,
    flushSave,
    formState,
    leaveWithoutSaving,
    loadError,
    loading,
    navigateBackToCompliance,
    navigationConfirmBusy,
    navigationConfirmError,
    navigationConfirmOpen,
    principle,
    principleMatrixEntries,
    principleMissingExplanations,
    retrySave,
    resolveConflictFromServer,
    saveState,
    saveAndContinueNavigation,
    stayOnCompliancePage,
    updateField,
  };
}
