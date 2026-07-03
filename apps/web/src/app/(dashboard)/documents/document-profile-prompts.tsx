'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { EvidenceChip, ReviewFlag, StatusChip } from '@/components/ui/status';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  getMatrixEntriesForStandard,
  type DocumentResponse,
  type OrganisationResponse,
} from '@charitypilot/shared';

type ConditionalProfile = OrganisationResponse['conditionalObligationProfile'];

const formatReviewFlag = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

export function buildDocumentProfilePrompts(profile: ConditionalProfile | undefined, documents: DocumentResponse[]) {
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
      const linkedEvidenceCount = documents.reduce(
        (total, doc) =>
          total + (doc.standardLinks ?? []).filter((link) => rule.standardCodes.includes(link.standardCode)).length,
        0,
      );

      return {
        ...rule,
        sourceRefs,
        professionalReview,
        linkedEvidenceCount,
      };
    });
}

export type DocumentProfilePrompt = ReturnType<typeof buildDocumentProfilePrompts>[number];

export function DocumentProfilePromptsPanel({
  conditionalProfile,
  prompts,
  missingCount,
  error,
  onRetry,
}: {
  conditionalProfile: ConditionalProfile;
  prompts: DocumentProfilePrompt[];
  missingCount: number;
  error: string;
  onRetry: () => void;
}) {
  return (
    <AppSection
      title="Profile-triggered evidence prompts"
      description="These prompts come from the organisation setup profile and the Irish compliance matrix. They highlight profile-triggered obligations that may need source-backed evidence or professional review."
      actions={(
        <StatusChip tone={!conditionalProfile ? 'warning' : missingCount === 0 ? 'success' : 'warning'}>
          {!conditionalProfile
            ? 'Profile needed'
            : prompts.length === 0
              ? 'No triggers selected'
              : `${missingCount} evidence prompt${missingCount === 1 ? '' : 's'} to link`}
        </StatusChip>
      )}
    >
      {error ? (
        <ErrorState
          title="Profile-triggered prompts could not be loaded"
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
          description="Answer the conditional obligation questions in Organisation before relying on document evidence prompts."
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
            const sourceLabel = item.sourceRefs.length
              ? item.sourceRefs.slice(0, 2).map((source) => source.owner).join(', ')
              : 'Irish compliance matrix';

            return (
              <div key={item.profileKey} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.label}</h3>
                    <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.recommendedAction}</p>
                  </div>
                  <EvidenceChip status={item.linkedEvidenceCount > 0 ? 'ready' : 'review'}>
                    {item.linkedEvidenceCount > 0 ? `${item.linkedEvidenceCount} linked` : 'Link evidence'}
                  </EvidenceChip>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusChip tone="brand">Standards {item.standardCodes.join(', ')}</StatusChip>
                  <ReviewFlag tone="needs-review">Professional review: {professionalReviewLabel}</ReviewFlag>
                  <ReviewFlag tone="draft">Sources: {sourceLabel}</ReviewFlag>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppSection>
  );
}
