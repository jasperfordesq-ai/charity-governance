'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { SourceReferenceList } from '@/components/ui/source-reference';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  getMatrixEntriesForStandard,
  type OrganisationResponse,
} from '@charitypilot/shared';

type ConditionalProfile = OrganisationResponse['conditionalObligationProfile'];

const formatReviewFlag = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

export function buildDeadlineProfilePrompts(profile: ConditionalProfile | undefined, deadlineSearchText: string) {
  if (!profile) return [];

  return CONDITIONAL_OBLIGATION_REVIEW_RULES
    .filter((rule) => profile?.[rule.profileKey])
    .map((rule) => {
      const matrixEntries = rule.standardCodes.flatMap((code) => getMatrixEntriesForStandard(code));
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
      const reviewDateAlreadyScheduled =
        deadlineSearchText.includes(rule.label.toLowerCase()) ||
        rule.standardCodes.some((code) => deadlineSearchText.includes(code.toLowerCase()));

      return {
        ...rule,
        sourceRefs,
        professionalReview,
        reviewDateAlreadyScheduled,
      };
    });
}

export type DeadlineProfilePrompt = ReturnType<typeof buildDeadlineProfilePrompts>[number];

export function DeadlineProfilePromptsPanel({
  conditionalProfile,
  prompts,
  missingCount,
  error,
  saving,
  onRetry,
  onSchedule,
}: {
  conditionalProfile: ConditionalProfile;
  prompts: DeadlineProfilePrompt[];
  missingCount: number;
  error: string;
  saving: boolean;
  onRetry: () => void;
  onSchedule: (item: DeadlineProfilePrompt) => void;
}) {
  return (
    <AppSection
      title="Profile-triggered review dates"
      description="These prompts come from the organisation setup profile and the Irish compliance matrix. Add dates for profile-triggered obligations so board and professional review work is not missed."
      actions={(
        <StatusChip tone={!conditionalProfile ? 'warning' : missingCount === 0 ? 'success' : 'warning'}>
          {!conditionalProfile
            ? 'Profile needed'
            : prompts.length === 0
              ? 'No triggers selected'
              : `${missingCount} review date${missingCount === 1 ? '' : 's'} to schedule`}
        </StatusChip>
      )}
    >
      {error ? (
        <ErrorState
          title="Profile-triggered dates could not be loaded"
          description={error}
          action={(
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        />
      ) : !conditionalProfile ? (
        <EmptyState
          title="Complete the organisation profile"
          description="Answer the conditional obligation questions in Organisation before relying on deadline prompts."
        />
      ) : prompts.length === 0 ? (
        <EmptyState
          title="No conditional triggers selected"
          description="The current organisation profile has not selected staff, volunteers, public fundraising, safeguarding, data, premises, public-sector, or processor triggers."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {prompts.map((item) => {
            const professionalReviewLabel = item.professionalReview.length
              ? item.professionalReview.map(formatReviewFlag).join(', ')
              : 'Board judgement';

            return (
              <div
                key={item.profileKey}
                className={statusPanelClassName(item.reviewDateAlreadyScheduled ? 'success' : 'warning', 'p-4')}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.label}</h3>
                    <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.recommendedAction}</p>
                  </div>
                  <StatusChip tone={item.reviewDateAlreadyScheduled ? 'success' : 'warning'}>
                    {item.reviewDateAlreadyScheduled ? 'Scheduled' : 'Needs date'}
                  </StatusChip>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusChip tone="brand">Standards {item.standardCodes.join(', ')}</StatusChip>
                  <ReviewFlag tone="needs-review">Professional review: {professionalReviewLabel}</ReviewFlag>
                </div>
                <SourceReferenceList sources={item.sourceRefs} className="mt-3" />
                {!item.reviewDateAlreadyScheduled ? (
                  <Button
                    size="sm"
                    variant="flat"
                    className="mt-4"
                    onPress={() => onSchedule(item)}
                    isDisabled={saving}
                  >
                    Schedule review
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </AppSection>
  );
}
