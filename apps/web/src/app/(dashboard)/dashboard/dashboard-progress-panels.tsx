'use client';

import { Button, Card, Progress } from '@heroui/react';
import type { ComplianceSummary } from '@charitypilot/shared';
import Link from 'next/link';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusDot, statusPanelClassName } from '@/components/ui/status';

const scoreColour = (pct: number) => {
  if (pct >= 80) return 'success';
  if (pct >= 50) return 'warning';
  return 'danger';
};

export function DashboardProgressPanels({
  canManage,
  compliance,
  loading,
}: {
  canManage: boolean;
  compliance: ComplianceSummary | null;
  loading: boolean;
}) {
  return (
    <>
      {loading ? (
        <LoadingState
          title="Loading dashboard progress"
          description="Checking this year's standards, deadlines, trustees, and register signals."
        />
      ) : compliance ? (
        <Card className={statusPanelClassName('neutral', 'p-6 shadow-sm')}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex-shrink-0 text-center sm:text-left">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Overall recorded progress</p>
              <p className={`text-5xl font-extrabold ${
                compliance.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                : compliance.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400'
              }`}
              >
                {Math.round(compliance.percentComplete)}%
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {compliance.compliant} of {compliance.totalApplicable} standards recorded compliant
              </p>
            </div>
            <div className="flex-1 min-w-0">
              <Progress
                aria-label="Overall compliance"
                value={compliance.percentComplete}
                color={scoreColour(compliance.percentComplete)}
                className="w-full"
                size="lg"
              />
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <StatusDot tone="success" />
                  Recorded compliant: {compliance.compliant}
                </span>
                <span className="flex items-center gap-1">
                  <StatusDot tone="warning" />
                  Working Towards: {compliance.workingTowards}
                </span>
                <span className="flex items-center gap-1">
                  <StatusDot tone="neutral" />
                  Not Started: {compliance.notStarted}
                </span>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No compliance data available"
          description="Start by reviewing your standards for this reporting year."
          action={(
            <Button as={Link} href="/compliance" size="sm" variant="flat">
              Open compliance
            </Button>
          )}
        />
      )}

      <AppSection
        title="Progress by Principle"
        description={canManage
          ? 'Open a principle to close evidence gaps and prepare the annual Compliance Record.'
          : 'Open a principle to review recorded progress and evidence gaps in the annual Compliance Record.'}
      >
        {loading ? (
          <LoadingState
            title="Loading principle progress"
            description="Preparing the Governance Code principle cards for this reporting year."
          />
        ) : compliance?.byPrinciple?.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {compliance.byPrinciple.map((principle) => (
              <Link key={principle.principleId} href={`/compliance/${principle.principleId}`}>
                <Card
                  className={statusPanelClassName('neutral', 'p-5 shadow-sm hover:border-teal-primary/40 dark:hover:border-teal-light/40 hover:shadow-md transition-all cursor-pointer h-full')}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-8 h-8 rounded-lg bg-teal-primary/10 dark:bg-teal-light/10 text-teal-primary dark:text-teal-bright flex items-center justify-center text-sm font-bold">
                      {principle.principleNumber}
                    </div>
                    <div className="text-right">
                      <span className={`text-lg font-bold ${
                        principle.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                        : principle.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                        : 'text-gray-500 dark:text-gray-400'
                      }`}
                      >
                        {Math.round(principle.percentComplete)}%
                      </span>
                      <span className={`block text-[10px] font-medium ${
                        principle.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                        : principle.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                        : 'text-gray-500 dark:text-gray-400'
                      }`}
                      >
                        {principle.percentComplete >= 80 ? 'Mostly recorded' : principle.percentComplete >= 50 ? 'Partly recorded' : principle.percentComplete > 0 ? 'Started' : 'Not started'}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2 line-clamp-2">
                    {principle.principleTitle}
                  </p>
                  <Progress
                    aria-label={`Principle ${principle.principleNumber} progress`}
                    value={principle.percentComplete}
                    color={scoreColour(principle.percentComplete)}
                    size="sm"
                    className="w-full"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {principle.compliant} / {principle.totalApplicable} standards
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No principle data available"
            description="Review the Governance Code standards to start building the annual Compliance Record."
            action={(
              <Button as={Link} href="/compliance" size="sm" variant="flat">
                Open compliance
              </Button>
            )}
          />
        )}
      </AppSection>
    </>
  );
}
