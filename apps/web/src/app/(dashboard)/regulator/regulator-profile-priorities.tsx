'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { SourceReferenceList } from '@/components/ui/source-reference';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import type { OrganisationResponse, ProfessionalReviewFlag } from '@charitypilot/shared';

type RegulatorProfilePriority = {
  featureAreas: string[];
  label: string;
  professionalReview: ProfessionalReviewFlag[];
  profileKey: string;
  recommendedAction: string;
  sourceRefs: Array<{
    name: string;
    url: string;
  }>;
  standardCodes: string[];
};

export function RegulatorProfilePrioritiesSection({
  conditionalProfile,
  fetchOrganisationProfile,
  organisationProfileError,
  profileTriggeredRegulatorPriorities,
  reviewFlagLabels,
}: {
  conditionalProfile: OrganisationResponse['conditionalObligationProfile'] | null;
  fetchOrganisationProfile: () => void;
  organisationProfileError: string;
  profileTriggeredRegulatorPriorities: RegulatorProfilePriority[];
  reviewFlagLabels: Record<ProfessionalReviewFlag, string>;
}) {
  return (
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
            <article key={item.profileKey} className={statusPanelClassName('warning', 'p-4 shadow-sm')}>
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
                <SourceReferenceList sources={item.sourceRefs} label="Source references" className="mt-0" />
              </div>
            </article>
          ))}
        </div>
      )}
    </AppSection>
  );
}
