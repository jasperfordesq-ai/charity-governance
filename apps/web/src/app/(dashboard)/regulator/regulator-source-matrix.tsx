'use client';

import { AppSection } from '@/components/ui/app-page';
import { DataListItems } from '@/components/ui/data-list';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import {
  IRISH_COMPLIANCE_MATRIX,
  type CommencementStatus,
  type ProfessionalReviewFlag,
} from '@charitypilot/shared';

const statusMeta: Record<CommencementStatus, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  in_force: { label: 'Current guidance', tone: 'success' },
  guidance: { label: 'Current guidance', tone: 'info' },
  conditional: { label: 'Conditional', tone: 'warning' },
  not_commenced: { label: 'Not-yet-commenced', tone: 'neutral' },
};

const regulatorMatrixEntries = IRISH_COMPLIANCE_MATRIX.filter((item) =>
  ['regulator', 'registers', 'deadlines', 'documents', 'compliance'].includes(item.featureArea)
);

export function RegulatorSourceMatrix({
  reviewFlagLabels,
}: {
  reviewFlagLabels: Record<ProfessionalReviewFlag, string>;
}) {
  return (
    <AppSection
      title="Source-cited readiness matrix"
      description="Current guidance is shown separately from conditional or professional-review areas. Applicability still depends on the charity profile and trustee judgement."
    >
      <DataListItems divided={false}>
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
          {regulatorMatrixEntries.map((item) => {
            const meta = statusMeta[item.commencementStatus];
            return (
              <article key={item.id} className={statusPanelClassName(meta.tone, 'p-4')}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={meta.tone}>{meta.label}</StatusChip>
                      <StatusChip tone="neutral">Standards {item.standardCodes.join(', ')}</StatusChip>
                      <StatusChip tone="brand">{item.featureArea}</StatusChip>
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.userTask}</h3>
                    <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.applicabilityNote}</p>
                    <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.copyTone}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {item.professionalReview.length ? (
                    item.professionalReview.map((flag) => (
                      <ReviewFlag key={flag} tone="needs-review">
                        {reviewFlagLabels[flag]}
                      </ReviewFlag>
                    ))
                  ) : (
                    <ReviewFlag tone="approved">No specialist flag</ReviewFlag>
                  )}
                </div>
                <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Official source</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.sourceRefs.map((source) => (
                      <a
                        key={`${item.id}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-teal-dark transition-colors hover:border-teal-primary hover:bg-teal-primary/10 dark:border-gray-700 dark:text-teal-bright dark:hover:border-teal-bright"
                      >
                        {source.name}
                      </a>
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </DataListItems>
    </AppSection>
  );
}
