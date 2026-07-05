'use client';

import { AppSection } from '@/components/ui/app-page';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import { regulatorOperatingModel } from '@/lib/regulator-guidance';
import {
  IRISH_COMPLIANCE_MATRIX,
  IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
} from '@charitypilot/shared';

export function RegulatorReadinessOverview() {
  const currentGuidanceCount = IRISH_COMPLIANCE_MATRIX.filter((item) =>
    item.commencementStatus === 'guidance' || item.commencementStatus === 'in_force'
  ).length;
  const conditionalCount = IRISH_COMPLIANCE_MATRIX.filter((item) => item.commencementStatus === 'conditional').length;
  const notCommencedCount = IRISH_COMPLIANCE_MATRIX.filter((item) => item.commencementStatus === 'not_commenced').length;
  const professionalReviewAreas = [...new Set(IRISH_COMPLIANCE_MATRIX.flatMap((item) => item.professionalReview))];

  return (
    <>
      <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">Review-ready guidance map</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Separate current guidance from conditional and specialist review prompts.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Matrix entries cite official source material checked on {IRISH_COMPLIANCE_MATRIX_LAST_CHECKED}. Conditional, not-yet-commenced, and professional review items are prompts for board follow-up rather than legal certainty claims.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[34rem]">
            <ReadinessTile label="Current guidance" value={currentGuidanceCount} tone="success" />
            <ReadinessTile label="Conditional prompts" value={conditionalCount} tone="warning" />
            <ReadinessTile label="Not-yet-commenced" value={notCommencedCount} tone="neutral" />
            <ReadinessTile label="Professional review" value={professionalReviewAreas.length} tone="info" />
          </div>
        </div>
      </section>

      <AppSection
        title="Readiness operating model"
        description="The operational cycle trustees should be able to evidence before annual approval and filing."
      >
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
          {regulatorOperatingModel.map((item) => (
            <article key={item.title} className={statusPanelClassName('neutral', 'p-4 shadow-sm')}>
              <StatusChip tone="brand">{item.cadence}</StatusChip>
              <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
              <p className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">{item.owner}</p>
              <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.evidence}</p>
            </article>
          ))}
        </div>
      </AppSection>
    </>
  );
}

function ReadinessTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: 'success' | 'warning' | 'neutral' | 'info';
}) {
  const colour =
    tone === 'success'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'warning'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'info'
          ? 'text-sky-700 dark:text-sky-300'
          : 'text-gray-950 dark:text-gray-50';

  return (
    <div className={statusPanelClassName(tone, 'p-3')}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}
