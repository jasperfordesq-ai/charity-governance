'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { logClientError } from '@/lib/client-logger';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { DataListItems } from '@/components/ui/data-list';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import {
  evidencePackItems,
  officialGuidanceLinks,
  productAuditMap,
  regulatorOperatingModel,
} from '@/lib/regulator-guidance';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  IRISH_COMPLIANCE_MATRIX,
  IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
  type CommencementStatus,
  type OrganisationResponse,
  type ProfessionalReviewFlag,
} from '@charitypilot/shared';

const statusMeta: Record<CommencementStatus, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  in_force: { label: 'Current guidance', tone: 'success' },
  guidance: { label: 'Current guidance', tone: 'info' },
  conditional: { label: 'Conditional', tone: 'warning' },
  not_commenced: { label: 'Not-yet-commenced', tone: 'neutral' },
};

const reviewFlagLabels: Record<ProfessionalReviewFlag, string> = {
  solicitor: 'Solicitor',
  accountant: 'Accountant',
  data_protection: 'Data protection',
  employment: 'Employment',
  equality: 'Equality',
  health_and_safety: 'Health and safety',
  safeguarding: 'Safeguarding',
  protected_disclosures: 'Protected disclosures',
  governance_expert: 'Governance review',
};

export default function RegulatorGuidePage() {
  useDocumentTitle('Regulator Guide');
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [organisationProfileError, setOrganisationProfileError] = useState('');

  const fetchOrganisationProfile = useCallback(async () => {
    setOrganisationProfileError('');
    try {
      const res = await api.get('/organisations');
      setOrganisation(res.data?.data ?? res.data ?? null);
    } catch (err) {
      if (isApiNotFoundError(err)) {
        setOrganisation(null);
        return;
      }
      const message = apiErrorMessage(err, 'Organisation profile could not be loaded for regulator priorities.');
      logClientError('Failed to load organisation profile for regulator priorities', err);
      setOrganisationProfileError(message);
    }
  }, []);

  useEffect(() => {
    fetchOrganisationProfile();
  }, [fetchOrganisationProfile]);

  const currentGuidanceCount = IRISH_COMPLIANCE_MATRIX.filter((item) =>
    item.commencementStatus === 'guidance' || item.commencementStatus === 'in_force'
  ).length;
  const conditionalCount = IRISH_COMPLIANCE_MATRIX.filter((item) => item.commencementStatus === 'conditional').length;
  const notCommencedCount = IRISH_COMPLIANCE_MATRIX.filter((item) => item.commencementStatus === 'not_commenced').length;
  const professionalReviewAreas = [...new Set(IRISH_COMPLIANCE_MATRIX.flatMap((item) => item.professionalReview))];
  const regulatorMatrixEntries = IRISH_COMPLIANCE_MATRIX.filter((item) =>
    ['regulator', 'registers', 'deadlines', 'documents', 'compliance'].includes(item.featureArea)
  );
  const conditionalProfile = organisation?.conditionalObligationProfile ?? null;
  const profileTriggeredRegulatorPriorities = useMemo(() => {
    const profile = organisation?.conditionalObligationProfile;
    if (!profile) return [];

    return CONDITIONAL_OBLIGATION_REVIEW_RULES
      .filter((rule) => profile?.[rule.profileKey])
      .map((rule) => {
        const matrixEntries = IRISH_COMPLIANCE_MATRIX.filter((entry) =>
          entry.standardCodes.some((code) => rule.standardCodes.includes(code)),
        );
        const sourceRefs = Array.from(
          new Map(
            matrixEntries
              .flatMap((entry) => entry.sourceRefs)
              .map((source) => [source.url, source]),
          ).values(),
        );
        const professionalReview = Array.from(
          new Set(matrixEntries.flatMap((entry) => entry.professionalReview)),
        );

        return {
          ...rule,
          sourceRefs,
          professionalReview,
          featureAreas: [...new Set(matrixEntries.map((entry) => entry.featureArea))],
        };
      });
  }, [organisation?.conditionalObligationProfile]);

  return (
    <AppPage
      eyebrow="Irish charities governance"
      title="Regulator Readiness"
      description="A source-cited working dashboard for trustee workflows, official guidance, conditional prompts, and professional-review areas. It is not legal advice."
      actions={(
        <>
          <Button as={Link} href="/compliance" className="bg-teal-primary text-white hover:bg-teal-dark">
            Open Compliance
          </Button>
          <Button as={Link} href="/documents" variant="flat">
            Evidence Vault
          </Button>
          <Button as={Link} href="/export" variant="flat">
            Export Pack
          </Button>
        </>
      )}
    >
      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
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
            <article key={item.title} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <StatusChip tone="brand">{item.cadence}</StatusChip>
              <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
              <p className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">{item.owner}</p>
              <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.evidence}</p>
            </article>
          ))}
        </div>
      </AppSection>

      <AppSection
        title="Profile-triggered regulator priorities"
        description="These items are prioritised from the conditional obligation profile. They are review prompts for trustees and advisers, not legal advice or a legal-compliance certificate."
        actions={(
          <StatusChip tone={!conditionalProfile ? 'warning' : profileTriggeredRegulatorPriorities.length > 0 ? 'warning' : 'success'}>
            {!conditionalProfile
              ? 'Profile needed'
              : profileTriggeredRegulatorPriorities.length > 0
                ? `${profileTriggeredRegulatorPriorities.length} triggered`
                : 'No triggers selected'}
          </StatusChip>
        )}
      >
        {organisationProfileError ? (
          <ErrorState
            title="Regulator priorities could not be loaded"
            description={organisationProfileError}
            action={(
              <Button size="sm" variant="flat" onPress={fetchOrganisationProfile}>
                Try again
              </Button>
            )}
          />
        ) : !conditionalProfile ? (
          <EmptyState
            title="Complete the conditional obligation profile"
            description="Answer the organisation profile questions before relying on profile-triggered obligations in regulator readiness work."
          />
        ) : profileTriggeredRegulatorPriorities.length === 0 ? (
          <EmptyState
            title="No profile-triggered priorities selected"
            description="The current profile has no staff, volunteer, fundraising, safeguarding, data, premises, public-sector, or processor triggers selected."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {profileTriggeredRegulatorPriorities.map((item) => (
              <article key={item.profileKey} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone="warning">Profile-triggered</StatusChip>
                  <StatusChip tone="neutral">Standards {item.standardCodes.join(', ')}</StatusChip>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-gray-950 dark:text-gray-50">{item.label}</h3>
                <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.recommendedAction}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.professionalReview.length ? (
                    item.professionalReview.map((flag) => (
                      <ReviewFlag key={flag} tone="needs-review">
                        Professional review: {reviewFlagLabels[flag]}
                      </ReviewFlag>
                    ))
                  ) : (
                    <ReviewFlag tone="draft">Professional review: Board judgement</ReviewFlag>
                  )}
                  {item.featureAreas.map((area) => (
                    <ReviewFlag key={area} tone="draft">
                      Workflow: {area}
                    </ReviewFlag>
                  ))}
                </div>
                <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Source references</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.sourceRefs.slice(0, 3).map((source) => (
                      <a
                        key={`${item.profileKey}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-teal-dark transition-colors hover:border-teal-primary hover:bg-teal-primary/10 dark:border-gray-700 dark:text-teal-bright dark:hover:border-teal-bright"
                      >
                        {source.name}
                      </a>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </AppSection>

      <AppSection
        title="Source-cited readiness matrix"
        description="Current guidance is shown separately from conditional or professional-review areas. Applicability still depends on the charity profile and trustee judgement."
      >
        <DataListItems divided={false}>
          <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
            {regulatorMatrixEntries.map((item) => {
              const meta = statusMeta[item.commencementStatus];
              return (
                <article key={item.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
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
                          className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-teal-dark transition-colors hover:border-teal-primary hover:bg-teal-primary/10 dark:border-gray-700 dark:text-teal-bright dark:hover:border-teal-bright"
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

      <AppSection
        title="Evidence pack prompts"
        description="The practical file set trustees should be able to find before signing off the annual governance position."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {evidencePackItems.map((item) => (
            <article key={item.title} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                <StatusChip tone="neutral">{item.category.replace(/_/g, ' ')}</StatusChip>
              </div>
              <p className="mt-2 text-xs font-medium text-teal-dark dark:text-teal-bright">Standards {item.standards}</p>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.why}</p>
            </article>
          ))}
        </div>
      </AppSection>

      <AppSection
        title="Product coverage watch"
        description="Where the app is already useful and where product work should remain cautious or source-led."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {productAuditMap.map((item) => (
            <article key={item.area} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.area}</h3>
                <StatusChip tone={item.status === 'Missing' || item.status === 'Thin' ? 'warning' : 'success'}>
                  {item.status}
                </StatusChip>
              </div>
              <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.now}</p>
              <p className="mt-2 text-sm leading-6 text-gray-800 dark:text-gray-200">
                <span className="font-semibold">Next:</span> {item.next}
              </p>
            </article>
          ))}
        </div>
      </AppSection>

      <AppSection
        title="Official guidance links"
        description="Primary source links should open in a new tab and be used beside board workflows, not as a substitute for professional advice."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {officialGuidanceLinks.map((item) => (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-teal-primary/50 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-teal-light/50"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.title}</h3>
                <StatusChip tone="brand">Official source</StatusChip>
              </div>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{item.note}</p>
            </a>
          ))}
        </div>
      </AppSection>
    </AppPage>
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
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}
