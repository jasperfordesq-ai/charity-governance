'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@heroui/react';
import { ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, LoadingState, ReviewWarningState } from '@/components/ui/states';
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
  const [loadError, setLoadError] = useState('');

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
      setLoadError('');
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
      <AppPage
        eyebrow={`Reporting year ${currentYear}`}
        title="Loading principle"
        description="Preparing the standard editor and evidence prompts for this reporting year."
      >
        <LoadingState
          variant="page"
          title="Loading compliance principle"
          description="Checking standards, records, evidence prompts, and approval-readiness."
        />
      </AppPage>
    );
  }

  if (!principle) {
    return (
      <AppPage
        eyebrow={`Reporting year ${currentYear}`}
        title="Compliance principle"
        description="Open a valid Governance Code principle to edit standards, evidence, and explanations."
      >
        <ErrorState
          variant="page"
          title={loadError ? 'Compliance principle could not be loaded' : 'Principle not found'}
          description={loadError || 'This principle is not available for the current organisation workspace.'}
          action={(
            <Button className="bg-teal-primary text-white" onPress={navigateBackToCompliance}>
              Back to Compliance
            </Button>
          )}
        />
      </AppPage>
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
          type="button"
          onClick={navigateBackToCompliance}
          className="text-sm text-teal-primary dark:text-teal-bright hover:underline mb-3 inline-flex items-center gap-1"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
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
