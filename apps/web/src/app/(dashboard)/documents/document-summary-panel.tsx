'use client';

import { StatusChip, statusPanelClassName } from '@/components/ui/status';

export function DocumentSummaryPanel({
  documentsCount,
  linkedStandardsCount,
  missingEvidenceCount,
}: {
  documentsCount: number;
  linkedStandardsCount: number;
  missingEvidenceCount: number;
}) {
  return (
    <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl">
          <StatusChip tone="brand">Evidence-led governance</StatusChip>
          <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
            Keep board evidence close to the standard it supports.
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Uploaded files are kept as private evidence until a signed download URL is requested.
            Link documents to standards with plain names, owners, review dates, and minute references.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:min-w-80">
          <div className={statusPanelClassName('neutral', 'p-3')}>
            <p className="text-xs text-gray-500 dark:text-gray-400">Documents</p>
            <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{documentsCount}</p>
          </div>
          <div className={statusPanelClassName('neutral', 'p-3')}>
            <p className="text-xs text-gray-500 dark:text-gray-400">Linked standards</p>
            <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{linkedStandardsCount}</p>
          </div>
          <div className={statusPanelClassName('neutral', 'p-3')}>
            <p className="text-xs text-gray-500 dark:text-gray-400">Evidence gaps</p>
            <p className="text-xl font-bold text-gray-950 dark:text-gray-50">{missingEvidenceCount}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
