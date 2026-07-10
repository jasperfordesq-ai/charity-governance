'use client';

import Link from 'next/link';
import { Button, Card, Progress } from '@heroui/react';
import { ChevronDown } from 'lucide-react';
import { AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import type { ComplianceSummary, GovernancePrincipleResponse } from '@charitypilot/shared';

function scoreColour(pct: number): 'success' | 'warning' | 'danger' {
  if (pct >= 80) return 'success';
  if (pct >= 50) return 'warning';
  return 'danger';
}

export function CompliancePrincipleList({
  loading,
  loadError,
  principles,
  summary,
  showAdditional,
  expandedId,
  onExpandedIdChange,
  onRetry,
}: {
  loading: boolean;
  loadError: string;
  principles: GovernancePrincipleResponse[];
  summary: ComplianceSummary | null;
  showAdditional: boolean;
  expandedId: string | null;
  onExpandedIdChange: (principleId: string | null) => void;
  onRetry: () => void;
}) {
  const getPrincipleSummary = (principleId: string) => {
    return summary?.byPrinciple?.find((p) => p.principleId === principleId);
  };

  return (
    <div id="principles">
      <AppSection title="Principles" description="Open a principle to edit standards, evidence, and explanations.">
        {loading ? (
          <LoadingState title="Loading compliance principles" description="Checking Governance Code principles, reporting-year progress, and approval-readiness." />
        ) : loadError ? (
          <ErrorState
            title="Compliance data could not be loaded"
            description={loadError}
            action={(
              <Button size="sm" variant="flat" onPress={onRetry}>
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
                    className={statusPanelClassName('neutral', 'shadow-sm overflow-hidden')}
                  >
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
                        <div className="flex flex-col items-end gap-2 flex-shrink-0 sm:flex-row sm:items-center sm:gap-3">
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
                            as={Link}
                            href={`/compliance/${principle.id}`}
                            size="sm"
                            className={primaryActionButtonClassName}
                          >
                            Edit records
                          </Button>
                          <Button
                            type="button"
                            isIconOnly
                            size="sm"
                            radius="md"
                            variant="light"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Principle ${principle.number}`}
                            aria-expanded={isExpanded}
                            aria-controls={panelId}
                            onPress={() => onExpandedIdChange(isExpanded ? null : principle.id)}
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

                    {isExpanded && (
                      <div
                        id={panelId}
                        className="border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/60"
                      >
                        <div className="px-5 py-3">
                          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                            Core Standards
                          </p>
                          <div className="space-y-2">
                            {coreStandards.map((s) => (
                              <div
                                key={s.id}
                                className={statusPanelClassName('neutral', 'flex items-start gap-3 p-3')}
                              >
                                <StatusChip tone="neutral" className="mt-0.5 flex-shrink-0 font-mono">
                                  {s.code}
                                </StatusChip>
                                <p className="text-sm text-gray-700 dark:text-gray-300 flex-1">{s.title}</p>
                              </div>
                            ))}
                          </div>
                        </div>

                        {showAdditional && additionalStandards.length > 0 && (
                          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
                            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                              Additional Standards (Complex)
                            </p>
                            <div className="space-y-2">
                              {additionalStandards.map((s) => (
                                <div
                                  key={s.id}
                                  className={statusPanelClassName('brand', 'flex items-start gap-3 p-3')}
                                >
                                  <StatusChip tone="brand" className="mt-0.5 flex-shrink-0 font-mono">
                                    {s.code}
                                  </StatusChip>
                                  <p className="text-sm text-gray-700 dark:text-gray-300 flex-1">{s.title}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
                          Select Edit records to update this principle's statuses, evidence, and explanations.
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
  );
}
