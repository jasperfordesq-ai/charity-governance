'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { logClientError } from '@/lib/client-logger';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { SourceReferenceCard } from '@/components/ui/source-reference';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import { RegulatorProfilePrioritiesSection } from './regulator-profile-priorities';
import { RegulatorReadinessOverview } from './regulator-readiness-overview';
import { RegulatorSourceMatrix } from './regulator-source-matrix';
import {
  evidencePackItems,
  officialGuidanceLinks,
  productAuditMap,
} from '@/lib/regulator-guidance';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  IRISH_COMPLIANCE_MATRIX,
  type OrganisationResponse,
  type ProfessionalReviewFlag,
} from '@charitypilot/shared';

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
      const res = await api.get('/organisation');
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
          <Button as={Link} href="/compliance" className={primaryActionButtonClassName}>
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
      <RegulatorReadinessOverview />

      <RegulatorProfilePrioritiesSection
        conditionalProfile={conditionalProfile}
        fetchOrganisationProfile={fetchOrganisationProfile}
        organisationProfileError={organisationProfileError}
        profileTriggeredRegulatorPriorities={profileTriggeredRegulatorPriorities}
        reviewFlagLabels={reviewFlagLabels}
      />

      <RegulatorSourceMatrix reviewFlagLabels={reviewFlagLabels} />

      <AppSection
        title="Evidence pack prompts"
        description="The practical file set trustees should be able to find before signing off the annual governance position."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {evidencePackItems.map((item) => (
            <article key={item.title} className={statusPanelClassName('neutral', 'p-4 shadow-sm')}>
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
            <article
              key={item.area}
              className={statusPanelClassName(item.status === 'Missing' || item.status === 'Thin' ? 'warning' : 'success', 'p-4 shadow-sm')}
            >
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
            <SourceReferenceCard
              key={item.href}
              source={{ name: item.title, url: item.href }}
              description={item.note}
              className={statusPanelClassName('neutral', 'p-4 shadow-sm')}
            />
          ))}
        </div>
      </AppSection>
    </AppPage>
  );
}
