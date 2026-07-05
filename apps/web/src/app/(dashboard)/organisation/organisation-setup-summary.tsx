'use client';

import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';

export type OrganisationCompletionItem = {
  label: string;
  ready: boolean;
};

export function OrganisationSetupSummary({
  completionItems,
}: {
  completionItems: OrganisationCompletionItem[];
}) {
  return (
    <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl">
          <ReviewFlag tone="draft">First setup step</ReviewFlag>
          <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
            Make the charity profile easy to review before annual reporting.
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Clear RCN, CRO, legal form, purpose, and financial year end details help trustees understand what the system is using.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
          {completionItems.map((item) => (
            <div key={item.label} className={statusPanelClassName(item.ready ? 'success' : 'warning', 'p-3')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">{item.label}</p>
              <StatusChip tone={item.ready ? 'success' : 'warning'}>{item.ready ? 'Set' : 'Review'}</StatusChip>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
