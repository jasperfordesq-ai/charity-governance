'use client';

import { ReviewFlag } from '@/components/ui/status';

export type BoardSummary = {
  active: number;
  inactive: number;
  conductMissing: number;
  inductionMissing: number;
  termReview: number;
};

export function BoardSummaryPanel({ summary }: { summary: BoardSummary }) {
  return (
    <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
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
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-xs text-gray-500 dark:text-gray-400">Active</p>
            <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{summary.active}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-xs text-gray-500 dark:text-gray-400">Conduct gaps</p>
            <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.conductMissing}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-xs text-gray-500 dark:text-gray-400">Induction gaps</p>
            <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{summary.inductionMissing}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-xs text-gray-500 dark:text-gray-400">Term review</p>
            <p className="text-xl font-bold text-rose-700 dark:text-rose-300">{summary.termReview}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
