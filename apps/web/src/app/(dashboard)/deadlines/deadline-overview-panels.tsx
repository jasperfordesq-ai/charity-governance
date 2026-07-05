'use client';

import { AppSection } from '@/components/ui/app-page';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import { IRISH_COMPLIANCE_MATRIX } from '@charitypilot/shared';

const annualReportSource = IRISH_COMPLIANCE_MATRIX
  .flatMap((entry) => entry.sourceRefs)
  .find((source) => source.name === 'Annual report - how to submit');

const annualReportSourceNote = {
  name: annualReportSource?.name ?? 'Annual report - how to submit',
  url: annualReportSource?.url ?? 'https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit',
  lastChecked: annualReportSource?.lastChecked ?? '2026-07-05',
};

const regulatoryMilestones = [
  {
    title: 'Annual Report filing',
    cadence: '10 months after financial year end',
    detail: 'Use the organisation profile year-end date so the app can generate this deadline automatically.',
    source: annualReportSourceNote,
  },
  {
    title: 'Compliance Record Form approval',
    cadence: 'Before Annual Report submission',
    detail: 'The board should approve the annual Governance Code position and keep the record as evidence.',
    source: null,
  },
  {
    title: 'Financial controls review',
    cadence: 'At least annually',
    detail: 'Review budgets, reconciliations, reserves, approval limits, restricted funds, and management accounts.',
    source: null,
  },
  {
    title: 'Risk and insurance review',
    cadence: 'At least annually',
    detail: 'Refresh the risk register and confirm insurance cover remains appropriate for activities.',
    source: null,
  },
];

export function DeadlineOverviewPanels({
  summary,
}: {
  summary: {
    open: number;
    overdue: number;
    dueSoon: number;
    system: number;
  };
}) {
  return (
    <>
      <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">Review-ready schedule</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Scan what needs trustee attention next.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Priority badges separate overdue, due-soon, upcoming, and complete work so board packs can focus on the right dates.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
            <div className={statusPanelClassName('neutral', 'p-3')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">Open</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.open}</p>
            </div>
            <div className={statusPanelClassName('danger', 'p-3')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">Overdue</p>
              <p className="text-xl font-bold text-rose-700 dark:text-rose-300">{summary.overdue}</p>
            </div>
            <div className={statusPanelClassName('warning', 'p-3')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">Due soon</p>
              <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.dueSoon}</p>
            </div>
            <div className={statusPanelClassName('info', 'p-3')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">System</p>
              <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.system}</p>
            </div>
          </div>
        </div>
      </section>

      <AppSection
        title="Regulatory cadence"
        description="Core dates to keep in view for Irish registered charities. Add custom dates for funders, CRO, audits, AGMs, and internal reviews."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {regulatoryMilestones.map((item) => (
            <div key={item.title} className={statusPanelClassName('neutral', 'p-4')}>
              <StatusChip tone="brand">{item.cadence}</StatusChip>
              <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
              <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.detail}</p>
              {item.source ? (
                <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                  Source:{' '}
                  <a
                    href={item.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-teal-primary underline-offset-4 hover:underline dark:text-teal-bright"
                  >
                    {item.source.name}
                  </a>{' '}
                  (checked {item.source.lastChecked}).
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </AppSection>
    </>
  );
}
