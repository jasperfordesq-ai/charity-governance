'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Progress, Select, SelectItem, Chip, Button, Switch } from '@heroui/react';
import { ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import Link from 'next/link';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, ReviewWarningState } from '@/components/ui/states';
import { EvidenceReadiness } from '@/components/governance/evidence-readiness';
import type {
  GovernancePrincipleResponse,
  ComplianceSummary,
} from '@charitypilot/shared';
import { IRISH_COMPLIANCE_MATRIX } from '@charitypilot/shared';

type ApprovalReadiness = {
  ready: boolean;
  missingExplanations: Array<{
    standardId: string;
    standardCode: string;
    status: 'NOT_APPLICABLE' | 'EXPLAIN';
  }>;
};

export default function CompliancePage() {
  useDocumentTitle('Compliance');
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [principles, setPrinciples] = useState<GovernancePrincipleResponse[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [showAdditional, setShowAdditional] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [principlesRes, summaryRes] = await Promise.all([
        api.get('/compliance/principles'),
        api.get(`/compliance/summary?year=${year}`),
      ]);
      setPrinciples(principlesRes.data?.data ?? principlesRes.data ?? []);
      setSummary(summaryRes.data);

      try {
        const readinessRes = await api.get(`/compliance/approval-readiness?year=${year}`);
        setApprovalReadiness(readinessRes.data);
      } catch (readinessErr) {
        logClientError('Failed to load approval readiness', readinessErr);
        setApprovalReadiness(null);
      }
    } catch (err) {
      const message = apiErrorMessage(err, 'Compliance data could not be loaded. Please try again.');
      logClientError('Failed to load compliance data', err);
      setPrinciples([]);
      setSummary(null);
      setApprovalReadiness(null);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getPrincipleSummary = (principleId: string) => {
    return summary?.byPrinciple?.find((p) => p.principleId === principleId);
  };

  const scoreColour = (pct: number): 'success' | 'warning' | 'danger' => {
    if (pct >= 80) return 'success';
    if (pct >= 50) return 'warning';
    return 'danger';
  };

  const missingExplanations = approvalReadiness?.missingExplanations ?? [];
  const evidencePrompts = IRISH_COMPLIANCE_MATRIX
    .filter((entry) => entry.featureArea === 'compliance' || entry.featureArea === 'export' || entry.featureArea === 'deadlines')
    .slice(0, 4)
    .map((entry) => ({
      label: entry.userTask,
      status: 'review' as const,
      note: entry.applicabilityNote,
    }));

  return (
    <AppPage
      eyebrow={`Reporting year ${year}`}
      title="Compliance Overview"
      description="Track Governance Code records, explanation gaps, and evidence prompts for a review-ready trustee workspace. This is workflow support, not legal advice."
      actions={(
        <div className="flex items-center gap-3">
          <Select
            label="Reporting Year"
            selectedKeys={new Set([String(year)])}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              if (val) setYear(Number(val));
            }}
            className="w-40"
            size="sm"
          >
            {yearOptions.map((y) => (
              <SelectItem key={String(y)}>{String(y)}</SelectItem>
            ))}
          </Select>
        </div>
      )}
    >

      {missingExplanations.length > 0 && (
        <ReviewWarningState
          title="Approval explanations are incomplete"
          description={`${missingExplanations.length} standard${missingExplanations.length === 1 ? '' : 's'} marked not applicable or explain need an explanation before annual board approval can be saved.`}
          action={(
            <Button as={Link} href="#principles" size="sm" variant="flat">
              Edit explanations below
            </Button>
          )}
        />
      )}

      <EvidenceReadiness
        title="Evidence-led review prompts"
        description="Use these matrix prompts to decide what evidence trustees should review for this year; applicability still depends on the charity profile and professional judgement where needed."
        prompts={evidencePrompts}
        flags={[
          { label: 'Review-ready, not legal advice', tone: 'needs-review' },
          { label: `${IRISH_COMPLIANCE_MATRIX.length} Irish governance prompts mapped`, tone: 'draft' },
        ]}
      />

      {/* Overall summary bar */}
      {summary && (
        <Card className="p-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-shrink-0">
              <p className="text-sm text-gray-500 dark:text-gray-400">Overall Score</p>
              <p className={`text-3xl font-extrabold ${
                summary.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                : summary.percentComplete >= 50 ? 'text-amber-500 dark:text-amber-300'
                : 'text-red-500 dark:text-red-400'
              }`}>
                {Math.round(summary.percentComplete)}%
              </p>
            </div>
            <Progress
              aria-label="Overall compliance"
              value={summary.percentComplete}
              color={scoreColour(summary.percentComplete)}
              size="md"
              className="flex-1"
            />
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries({
                'Recorded compliant': summary.compliant,
                'Working Towards': summary.workingTowards,
                'Not Started': summary.notStarted,
                'N/A': summary.notApplicable,
                Explain: summary.explain,
              }).map(([label, count]) => (
                <span key={label} className="text-gray-500 dark:text-gray-400">
                  {label}: <strong>{count}</strong>
                </span>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Additional standards toggle */}
      <Switch
        size="sm"
        color="primary"
        isSelected={showAdditional}
        onValueChange={setShowAdditional}
        classNames={{
          label: 'text-sm text-gray-600 dark:text-gray-300',
        }}
      >
        Show additional standards (complex organisations)
      </Switch>

      <div id="principles">
        <AppSection title="Principles" description="Open a principle to edit standards, evidence, and explanations.">
        {loading ? (
          <LoadingState title="Loading compliance principles" description="Checking Governance Code principles, reporting-year progress, and approval-readiness." />
        ) : loadError ? (
          <ErrorState
            title="Compliance data could not be loaded"
            description={loadError}
            action={(
              <Button size="sm" variant="flat" onPress={fetchData}>
                Try again
              </Button>
            )}
          />
        ) : (
          <div className="space-y-4">
          {principles
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((principle) => {
              const pSummary = getPrincipleSummary(principle.id);
              const pct = pSummary?.percentComplete ?? 0;
              const isExpanded = expandedId === principle.id;
              const panelId = `principle-${principle.id}-standards`;

              const coreStandards = principle.standards.filter((s) => s.isCore);
              const additionalStandards = principle.standards.filter((s) => s.isAdditional);

              return (
                <Card
                  key={principle.id}
                  className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden"
                >
                  {/* Principle header */}
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-teal-primary/10 dark:bg-teal-light/10 text-teal-primary dark:text-teal-bright flex items-center justify-center text-sm font-bold">
                          {principle.number}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                            Principle {principle.number}: {principle.title}
                          </h3>
                          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                            {principle.description}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="text-right">
                          <span className={`text-lg font-bold ${
                            pct >= 80 ? 'text-green-600 dark:text-green-400' : pct >= 50 ? 'text-amber-500 dark:text-amber-300' : 'text-gray-400 dark:text-gray-400'
                          }`}>
                            {Math.round(pct)}%
                          </span>
                          <span className={`block text-[10px] font-medium ${
                            pct >= 80 ? 'text-green-600 dark:text-green-400' : pct >= 50 ? 'text-amber-500 dark:text-amber-300' : 'text-gray-400 dark:text-gray-400'
                          }`}>
                            {pct >= 80 ? 'Mostly recorded' : pct >= 50 ? 'Partly recorded' : pct > 0 ? 'Started' : 'Not started'}
                          </span>
                        </div>
                        <Button
                          type="button"
                          isIconOnly
                          size="sm"
                          radius="md"
                          variant="light"
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Principle ${principle.number}`}
                          aria-expanded={isExpanded}
                          aria-controls={panelId}
                          onPress={() => setExpandedId(isExpanded ? null : principle.id)}
                          className="min-w-9 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                        >
                          <ChevronDown
                            className={`w-5 h-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            aria-hidden="true"
                          />
                        </Button>
                      </div>
                    </div>
                    <Progress
                      aria-label={`Principle ${principle.number}`}
                      value={pct}
                      color={scoreColour(pct)}
                      size="sm"
                      className="mt-3"
                    />
                    {pSummary && (
                      <p className="text-xs text-gray-400 dark:text-gray-400 mt-2">
                        {pSummary.compliant} / {pSummary.totalApplicable} standards recorded compliant
                      </p>
                    )}
                  </div>

                  {/* Expanded standards list */}
                  {isExpanded && (
                    <div
                      id={panelId}
                      className="border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/60"
                    >
                      {/* Core standards */}
                      <div className="px-5 py-3">
                        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                          Core Standards
                        </p>
                        <div className="space-y-2">
                          {coreStandards.map((s) => (
                            <div
                              key={s.id}
                              className="flex items-start gap-3 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800"
                            >
                              <Chip size="sm" variant="flat" className="flex-shrink-0 mt-0.5 font-mono">
                                {s.code}
                              </Chip>
                              <p className="text-sm text-gray-700 dark:text-gray-300 flex-1">{s.title}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Additional standards */}
                      {showAdditional && additionalStandards.length > 0 && (
                        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
                          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                            Additional Standards (Complex)
                          </p>
                          <div className="space-y-2">
                            {additionalStandards.map((s) => (
                              <div
                                key={s.id}
                                className="flex items-start gap-3 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800"
                              >
                                <Chip size="sm" variant="flat" color="secondary" className="flex-shrink-0 mt-0.5 font-mono">
                                  {s.code}
                                </Chip>
                                <p className="text-sm text-gray-700 dark:text-gray-300 flex-1">{s.title}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Link to detailed editing */}
                      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
                        <Link href={`/compliance/${principle.id}`}>
                          <Button
                            size="sm"
                            className="bg-teal-primary text-white hover:bg-teal-dark"
                          >
                            Edit Compliance Records
                          </Button>
                        </Link>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
        </AppSection>
      </div>
    </AppPage>
  );
}
