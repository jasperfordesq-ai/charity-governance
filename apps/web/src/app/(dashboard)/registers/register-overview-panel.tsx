'use client';

import { ReviewFlag } from '@/components/ui/status';

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'brand';

export function RegisterOverviewPanel({
  openRegisterCount,
  highRiskCount,
  annualReportReadinessPercent,
  financialControlsPercent,
}: {
  openRegisterCount: number;
  highRiskCount: number;
  annualReportReadinessPercent: number;
  financialControlsPercent: number;
}) {
  return (
    <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl">
          <ReviewFlag tone="draft">Review-ready register set</ReviewFlag>
          <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
            Scan open governance work before board review.
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            The register set keeps operational records separate from legal conclusions. Use source and review flags to decide what needs trustee or professional follow-up.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[34rem]">
          <SummaryTile label="Open records" value={openRegisterCount} tone={openRegisterCount > 0 ? 'warning' : 'success'} />
          <SummaryTile label="High risks" value={highRiskCount} tone={highRiskCount > 0 ? 'danger' : 'success'} />
          <SummaryTile label="Annual Report" value={`${annualReportReadinessPercent}%`} tone={annualReportReadinessPercent >= 80 ? 'success' : 'warning'} />
          <SummaryTile label="Financial controls" value={`${financialControlsPercent}%`} tone={financialControlsPercent >= 80 ? 'success' : 'warning'} />
        </div>
      </div>
    </section>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  const colour =
    tone === 'success'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'danger'
        ? 'text-rose-700 dark:text-rose-300'
        : tone === 'warning'
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-gray-950 dark:text-gray-50';
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}
