'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, Chip, Select, SelectItem, Textarea, Button } from '@heroui/react';
import { api } from '@/lib/api';
import { AppPage } from '@/components/ui/app-page';
import { ReviewWarningState } from '@/components/ui/states';
import { EvidenceReadiness } from '@/components/governance/evidence-readiness';
import type {
  GovernancePrincipleResponse,
  ComplianceRecordResponse,
} from '@charitypilot/shared';
import { ComplianceStatus, COMPLIANCE_STATUS_META, getMatrixEntriesForStandard } from '@charitypilot/shared';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface StandardFormState {
  status: ComplianceStatus;
  actionTaken: string;
  evidence: string;
  notes: string;
  explanationIfNA: string;
}

interface SaveState {
  [standardId: string]: 'idle' | 'saving' | 'saved' | 'error';
}

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

  useEffect(() => {
    const warnIfUnsaved = (event: BeforeUnloadEvent) => {
      const hasPending = Object.keys(pendingSaveData.current).length > 0;
      const hasSaving = Object.values(saveState).includes('saving');
      if (!hasPending && !hasSaving) return;

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warnIfUnsaved);
    return () => window.removeEventListener('beforeunload', warnIfUnsaved);
  }, [saveState]);

  const statusOptions = [
    { key: ComplianceStatus.COMPLIANT, label: 'Compliant' },
    { key: ComplianceStatus.WORKING_TOWARDS, label: 'Working Towards' },
    { key: ComplianceStatus.NOT_STARTED, label: 'Not Yet Started' },
    { key: ComplianceStatus.NOT_APPLICABLE, label: 'Not Applicable' },
    { key: ComplianceStatus.EXPLAIN, label: 'Explain Non-Compliance' },
    ];

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
          onPress={() => router.push('/compliance')}
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
          onClick={() => router.push('/compliance')}
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

            const meta = COMPLIANCE_STATUS_META[form.status] ?? COMPLIANCE_STATUS_META.NOT_STARTED;
            const save = saveState[standard.id] ?? 'idle';
            const showExplanation =
              form.status === ComplianceStatus.NOT_APPLICABLE ||
              form.status === ComplianceStatus.EXPLAIN;

            return (
              <Card
                key={standard.id}
                className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden"
              >
                {/* Standard header with status indicator */}
                <div
                  className="h-1"
                  style={{ backgroundColor: meta.colour }} /* replace meta.colour with a dark-mode-aware token (e.g. meta.colourDark resolved via theme) so the accent does not stay light-tuned in dark mode */
                />
                <div className="p-5 sm:p-6 space-y-5">
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <Chip
                        size="sm"
                        variant="flat"
                        className="flex-shrink-0 font-mono font-semibold"
                        style={{ backgroundColor: meta.bgColour, color: meta.colour }} /* supply dark-mode-aware bg/text (e.g. meta.bgColourDark/meta.colourDark) so the code chip keeps contrast in dark mode */
                      >
                        {standard.code}
                      </Chip>
                      <div>
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{standard.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {standard.isAdditional && (
                            <Chip size="sm" variant="flat" color="secondary" className="text-xs">
                              Additional
                            </Chip>
                          )}
                          {standard.isCore && (
                            <Chip size="sm" variant="flat" color="primary" className="text-xs">
                              Core
                            </Chip>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0" aria-live="polite">
                      {save === 'saving' && (
                        <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-400">
                          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          Saving...
                        </span>
                      )}
                      {save === 'saved' && (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                          Saved
                        </span>
                      )}
                      {save === 'error' && (
                        <span className="flex items-center gap-2 text-xs text-red-500 dark:text-red-400 font-medium">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                          Save failed
                          <button
                            type="button"
                            className="rounded border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-950/40"
                            onClick={() => {
                              pendingSaveData.current[standard.id] = form;
                              void flushSave(standard.id);
                            }}
                          >
                            Retry
                          </button>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status dropdown */}
                  <Select
                    label="Status"
                    selectedKeys={new Set([form.status])}
                    onBlur={() => void flushSave(standard.id)}
                    onSelectionChange={(keys) => {
                      const val = Array.from(keys)[0] as ComplianceStatus;
                      if (val) updateField(standard.id, 'status', val);
                    }}
                    size="sm"
                    className="max-w-xs"
                    renderValue={(items) => {
                      const item = items[0];
                      if (!item) return null;
                      const m = COMPLIANCE_STATUS_META[item.key as ComplianceStatus];
                      return (
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                            style={{ backgroundColor: m?.colour }}
                          />
                          <span>{m?.label ?? item.textValue}</span>
                        </div>
                      );
                    }}
                  >
                    {statusOptions.map((opt) => (
                      <SelectItem key={opt.key} textValue={opt.label}>
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full inline-block"
                            style={{ backgroundColor: COMPLIANCE_STATUS_META[opt.key].colour }}
                          />
                          {opt.label}
                        </div>
                      </SelectItem>
                    ))}
                  </Select>

                  {/* Action taken */}
                  <Textarea
                    label="Action Taken"
                    placeholder="Describe what your organisation has done to address this standard..."
                    value={form.actionTaken}
                    onValueChange={(val) => updateField(standard.id, 'actionTaken', val)}
                    onBlur={() => void flushSave(standard.id)}
                    minRows={2}
                    maxRows={6}
                    size="sm"
                  />

                  {/* Evidence */}
                  <Textarea
                    label="Evidence"
                    placeholder="List supporting evidence (e.g. policies, minutes, documents)..."
                    value={form.evidence}
                    onValueChange={(val) => updateField(standard.id, 'evidence', val)}
                    onBlur={() => void flushSave(standard.id)}
                    minRows={2}
                    maxRows={6}
                    size="sm"
                  />

                  {/* Internal notes */}
                  <Textarea
                    label="Internal Notes"
                    description="Not included in CRA submission"
                    placeholder="Any internal notes or reminders for your team..."
                    value={form.notes}
                    onValueChange={(val) => updateField(standard.id, 'notes', val)}
                    onBlur={() => void flushSave(standard.id)}
                    minRows={2}
                    maxRows={4}
                    size="sm"
                    classNames={{
                      description: 'text-amber-700 dark:text-amber-300 font-medium',
                    }}
                  />

                  {/* Explanation (conditional) */}
                  {showExplanation && (
                    <Textarea
                      label={
                        form.status === ComplianceStatus.NOT_APPLICABLE
                          ? 'Explanation for Not Applicable'
                          : 'Explanation for Non-Compliance'
                      }
                      placeholder="Please explain why this standard does not apply or why your organisation is not compliant..."
                      value={form.explanationIfNA}
                      onValueChange={(val) => updateField(standard.id, 'explanationIfNA', val)}
                      onBlur={() => void flushSave(standard.id)}
                      minRows={2}
                      maxRows={6}
                      size="sm"
                      isRequired
                      classNames={{
                        label: 'text-red-600 dark:text-red-400',
                      }}
                    />
                  )}
                </div>
              </Card>
            );
          })}
      </div>
    </AppPage>
  );
}
