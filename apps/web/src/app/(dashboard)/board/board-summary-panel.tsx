'use client';

import { ReviewFlag, type StatusTone, statusPanelClassName } from '@/components/ui/status';

export type BoardSummary = {
  active: number;
  inactive: number;
  conductMissing: number;
  inductionMissing: number;
  termReview: number;
};

function SummaryMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: StatusTone;
}) {
  const valueClassName =
    tone === 'danger'
      ? 'text-rose-700 dark:text-rose-300'
      : tone === 'warning'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-gray-950 dark:text-gray-50';

  return (
    <div className={statusPanelClassName(tone, 'p-3')}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-bold ${valueClassName}`}>{value}</p>
    </div>
  );
}

export function BoardSummaryPanel({ summary }: { summary: BoardSummary }) {
  const metrics = [
    { label: 'Active', value: summary.active, tone: 'neutral' },
    { label: 'Conduct gaps', value: summary.conductMissing, tone: 'warning' },
    { label: 'Induction gaps', value: summary.inductionMissing, tone: 'warning' },
    { label: 'Term review', value: summary.termReview, tone: 'danger' },
  ] satisfies Array<{ label: string; value: number; tone: StatusTone }>;

  return (
    <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl">
          <ReviewFlag tone="draft">Review-ready register</ReviewFlag>
          <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
            Keep trustee evidence visible before annual review.
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Track who is active, when each trustee was appointed, and whether conduct and induction evidence is ready for board review.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
          {metrics.map((metric) => (
            <SummaryMetric key={metric.label} {...metric} />
          ))}
        </div>
      </div>
    </section>
  );
}
