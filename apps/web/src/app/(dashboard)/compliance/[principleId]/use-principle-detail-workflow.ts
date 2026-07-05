'use client';

import { logClientError } from '@/lib/client-logger';
import { api } from '@/lib/api';
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
  const pendingSaveData = useRef<Record<string, StandardFormState>>({});
  const readinessRequestSeq = useRef(0);

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

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setLoadError('');
      try {
        const [principleRes, recordsRes] = await Promise.all([
          api.get(`/compliance/principles/${principleId}`),
          api.get(`/compliance/records?principleId=${principleId}&year=${currentYear}`),
        ]);

        const nextPrinciple = principleRes.data as GovernancePrincipleResponse;
        setPrinciple(nextPrinciple);

        const records = recordsRes.data?.data ?? recordsRes.data ?? [];
        const initialForm: Record<string, StandardFormState> = {};

        for (const standard of nextPrinciple.standards ?? []) {
          const record = records.find((item: ComplianceRecordResponse) => item.standardId === standard.id);
          if (record) {
            initialForm[standard.id] = {
              status: record.status,
              actionTaken: record.actionTaken ?? '',
              evidence: record.evidence ?? '',
              notes: record.notes ?? '',
              explanationIfNA: record.explanationIfNA ?? '',
            };
          } else {
            initialForm[standard.id] = {
              status: ComplianceStatus.NOT_STARTED,
              actionTaken: '',
              evidence: '',
              notes: '',
              explanationIfNA: '',
            };
          }
        }

        setFormState(initialForm);
        await refreshApprovalReadiness();
      } catch (err) {
        const message = apiErrorMessage(err, 'Compliance principle could not be loaded. Please try again.');
        logClientError('Failed to load principle data', err);
        setPrinciple(null);
        setLoadError(message);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [principleId, currentYear, refreshApprovalReadiness]);

  const saveStandardNow = useCallback(
    async (standardId: string, data: StandardFormState, options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setSaveState((prev) => ({ ...prev, [standardId]: 'saving' }));
      }

      try {
        await api.put(`/compliance/records/${standardId}`, {
          reportingYear: currentYear,
          status: data.status,
          actionTaken: data.actionTaken || null,
          evidence: data.evidence || null,
          notes: data.notes || null,
          explanationIfNA: data.explanationIfNA || null,
        });

        delete pendingSaveData.current[standardId];

        if (!options.silent) {
          await refreshApprovalReadiness();
          setSaveState((prev) => ({ ...prev, [standardId]: 'saved' }));

          setTimeout(() => {
            setSaveState((prev) => ({ ...prev, [standardId]: 'idle' }));
          }, 2000);
        }
      } catch (err) {
        logClientError(`Failed to save standard ${standardId}`, err);
        if (!options.silent) {
          setSaveState((prev) => ({ ...prev, [standardId]: 'error' }));
        }
      }
    },
    [currentYear, refreshApprovalReadiness],
  );

  const flushSave = useCallback(
    async (standardId: string, options: { silent?: boolean } = {}) => {
      if (debounceTimers.current[standardId]) {
        clearTimeout(debounceTimers.current[standardId]);
        delete debounceTimers.current[standardId];
      }

      const pending = pendingSaveData.current[standardId];
      if (!pending) return;
      await saveStandardNow(standardId, pending, options);
    },
    [saveStandardNow],
  );

  const flushAllPendingComplianceSaves = useCallback(
    async (options: { silent?: boolean } = {}) => {
      Object.values(debounceTimers.current).forEach(clearTimeout);
      debounceTimers.current = {};

      const pendingEntries = Object.entries({ ...pendingSaveData.current });
      await Promise.all(
        pendingEntries.map(([standardId, data]) =>
          saveStandardNow(standardId, data, options),
        ),
      );
    },
    [saveStandardNow],
  );

  const autoSave = useCallback(
    (standardId: string, data: StandardFormState) => {
      pendingSaveData.current[standardId] = data;

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
    setFormState((prev) => {
      const updated = {
        ...prev,
        [standardId]: {
          ...prev[standardId],
          [field]: value,
        },
      };
      autoSave(standardId, updated[standardId]);
      return updated;
    });
  };

  useEffect(() => {
    return () => {
      void flushAllPendingComplianceSaves({ silent: true });
    };
  }, [flushAllPendingComplianceSaves]);

  const hasPendingComplianceSaves = useCallback(() => {
    const hasPending = Object.keys(pendingSaveData.current).length > 0;
    const hasSaving = Object.values(saveState).includes('saving');
    return hasPending || hasSaving;
  }, [saveState]);

  const requestComplianceNavigation = useCallback(
    (href = '/compliance') => {
      if (!hasPendingComplianceSaves()) {
        router.push(href);
        return;
      }

      setNavigationConfirmError('');
      setPendingNavigationHref(href);
      setNavigationConfirmOpen(true);
    },
    [hasPendingComplianceSaves, router],
  );

  const stayOnCompliancePage = useCallback(() => {
    if (navigationConfirmBusy) return;
    setNavigationConfirmError('');
    setNavigationConfirmOpen(false);
  }, [navigationConfirmBusy]);

  const leaveWithoutSaving = useCallback(() => {
    setNavigationConfirmError('');
    setNavigationConfirmOpen(false);
    router.push(pendingNavigationHref);
  }, [pendingNavigationHref, router]);

  const saveAndContinueNavigation = useCallback(async () => {
    setNavigationConfirmBusy(true);
    try {
      await flushAllPendingComplianceSaves();
      if (Object.keys(pendingSaveData.current).length > 0) {
        setNavigationConfirmError('Could not save every pending edit. Please retry or keep editing.');
        return;
      }

      setNavigationConfirmError('');
      setNavigationConfirmOpen(false);
      router.push(pendingNavigationHref);
    } finally {
      setNavigationConfirmBusy(false);
    }
  }, [flushAllPendingComplianceSaves, pendingNavigationHref, router]);

  useEffect(() => {
    const handleInAppNavigationClick = (event: MouseEvent) => {
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

    document.addEventListener('click', handleInAppNavigationClick, true);
    return () => document.removeEventListener('click', handleInAppNavigationClick, true);
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
    (standardId: string, retryForm: StandardFormState) => {
      pendingSaveData.current[standardId] = retryForm;
      void flushSave(standardId);
    },
    [flushSave],
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
    saveState,
    saveAndContinueNavigation,
    stayOnCompliancePage,
    updateField,
  };
}
