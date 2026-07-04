'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, Button } from '@heroui/react';
import { api } from '@/lib/api';
import { AppPage } from '@/components/ui/app-page';
import { ReviewWarningState } from '@/components/ui/states';
import { EvidenceReadiness } from '@/components/governance/evidence-readiness';
import { StandardEditorCard, type SaveState, type StandardFormState } from './standard-editor-card';
import type {
  GovernancePrincipleResponse,
  ComplianceRecordResponse,
} from '@charitypilot/shared';
import { ComplianceStatus, getMatrixEntriesForStandard } from '@charitypilot/shared';

type ApprovalReadiness = {
  ready: boolean;
  missingExplanations: Array<{
    standardId: string;
    standardCode: string;
    status: 'NOT_APPLICABLE' | 'EXPLAIN';
  }>;
};

/* ------------------------------------------------------------------ */
/*  Page component                                                    */
/* ------------------------------------------------------------------ */

export default function PrincipleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const principleId = params.principleId as string;

  const currentYear = new Date().getFullYear();
  const [principle, setPrinciple] = useState<GovernancePrincipleResponse | null>(null);
  const [formState, setFormState] = useState<Record<string, StandardFormState>>({});
  const [saveState, setSaveState] = useState<SaveState>({});
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  // Debounce timers
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

  // Fetch principle and compliance records
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [principleRes, recordsRes] = await Promise.all([
          api.get(`/compliance/principles/${principleId}`),
          api.get(`/compliance/records?principleId=${principleId}&year=${currentYear}`),
        ]);

        const p = principleRes.data;
        setPrinciple(p);

        const recs = recordsRes.data?.data ?? recordsRes.data ?? [];
        const recsMap: Record<string, ComplianceRecordResponse> = {};
        const initialForm: Record<string, StandardFormState> = {};

        for (const standard of p.standards ?? []) {
          const rec = recs.find((r: ComplianceRecordResponse) => r.standardId === standard.id);
          if (rec) {
            recsMap[standard.id] = rec;
            initialForm[standard.id] = {
              status: rec.status,
              actionTaken: rec.actionTaken ?? '',
              evidence: rec.evidence ?? '',
              notes: rec.notes ?? '',
              explanationIfNA: rec.explanationIfNA ?? '',
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
        logClientError('Failed to load principle data', err);
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

  // Auto-save with debounce
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

  // Update field and trigger auto-save
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

  // Flush pending debounce saves on unmount so quick in-app navigation does not drop edits.
  useEffect(() => {
    const timers = debounceTimers.current;
    const pending = pendingSaveData.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
      void Promise.all(
        Object.entries(pending).map(([standardId, data]) =>
          saveStandardNow(standardId, data, { silent: true }),
        ),
      );
    };
  }, [saveStandardNow]);

  const hasPendingComplianceSaves = useCallback(() => {
    const hasPending = Object.keys(pendingSaveData.current).length > 0;
    const hasSaving = Object.values(saveState).includes('saving');
    return hasPending || hasSaving;
  }, [saveState]);

  const confirmComplianceNavigation = useCallback(() => {
    if (!hasPendingComplianceSaves()) return true;
    return window.confirm('CharityPilot is still saving compliance edits. Leave this page only if you are happy to rely on the last saved state.');
  }, [hasPendingComplianceSaves]);

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
      if (isSamePageHash || confirmComplianceNavigation()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('click', handleInAppNavigationClick, true);
    return () => document.removeEventListener('click', handleInAppNavigationClick, true);
  }, [confirmComplianceNavigation]);

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
    if (confirmComplianceNavigation()) {
      router.push('/compliance');
    }
  }, [confirmComplianceNavigation, router]);


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

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-1/2 mb-3" />
          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4 mb-8" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-6 animate-pulse bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/4 mb-3" />
            <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-full mb-4" />
            <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded w-1/3 mb-3" />
            <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded w-full" />
          </Card>
        ))}
      </div>
    );
  }

  if (!principle) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">Principle not found.</p>
        <Button
          className="mt-4 bg-teal-primary text-white"
          onPress={navigateBackToCompliance}
        >
          Back to Compliance
        </Button>
      </div>
    );
  }

  return (
    <AppPage
      eyebrow={`Reporting year ${currentYear}`}
      title={`Principle ${principle.number}: ${principle.title}`}
      description={(
        <>
          {principle.description}{' '}
          Changes auto-save after 800ms. Evidence prompts are review aids and not legal advice.
        </>
      )}
      actions={(
        <button
          onClick={navigateBackToCompliance}
          className="text-sm text-teal-primary dark:text-teal-bright hover:underline mb-3 inline-flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Compliance
        </button>
      )}
    >

      {principleMissingExplanations.length > 0 && (
        <ReviewWarningState
          title="This principle has approval blockers"
          description={`${principleMissingExplanations.length} standard${principleMissingExplanations.length === 1 ? '' : 's'} in this principle need explanations before annual board approval can be saved.`}
        />
      )}

      <EvidenceReadiness
        title="Principle evidence prompts"
        description="Use these prompts to decide what trustee evidence should be recorded for this principle. Applicability depends on your charity profile and trustee judgement."
        prompts={principleMatrixEntries.map((entry) => ({
          label: entry.userTask,
          status: 'review' as const,
          note: entry.evidenceRequired.join(', '),
        }))}
        flags={[
          { label: 'Evidence-led review aid', tone: 'needs-review' },
          { label: 'Not legal advice', tone: 'draft' },
        ]}
      />

      {/* Standards */}
      <div className="space-y-6">
        {principle.standards
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((standard) => {
            const form = formState[standard.id];
            if (!form) return null;

            const save = saveState[standard.id] ?? 'idle';

            return (
              <StandardEditorCard
                key={standard.id}
                standard={standard}
                form={form}
                save={save}
                updateField={updateField}
                flushSave={flushSave}
                onRetrySave={(standardId, retryForm) => {
                  pendingSaveData.current[standardId] = retryForm;
                  void flushSave(standardId);
                }}
              />
            );
          })}
      </div>
    </AppPage>
  );
}
