'use client';

import { Button } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { EvidenceChip, ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  getMatrixEntriesForStandard,
  type AnnualReportReadinessResponse,
  type ComplaintRecordResponse,
  type ConflictRecordResponse,
  type FinancialControlReviewResponse,
  type FundraisingRecordResponse,
  type OrganisationResponse,
  type RiskRecordResponse,
} from '@charitypilot/shared';

type ConditionalProfile = OrganisationResponse['conditionalObligationProfile'];

const formatReviewFlag = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

const registerPriorityEvidence: Record<
  keyof NonNullable<ConditionalProfile>,
  { label: string; keywords: string[] }
> = {
  hasPaidStaff: {
    label: 'Employment and payroll register evidence',
    keywords: ['staff', 'employee', 'employment', 'payroll', 'worker', 'protected disclosure', 'role delegation'],
  },
  hasVolunteers: {
    label: 'Volunteer role and supervision evidence',
    keywords: ['volunteer', 'role description', 'supervision', 'onboarding', 'induction'],
  },
  raisesFundsFromPublic: {
    label: 'Fundraising activity and control evidence',
    keywords: ['fundraising', 'fundraiser', 'public', 'campaign', 'third party', 'third-party'],
  },
  worksWithChildrenOrVulnerableAdults: {
    label: 'Safeguarding and incident register evidence',
    keywords: ['safeguarding', 'children', 'vulnerable', 'vetting', 'incident', 'protection'],
  },
  processesPersonalData: {
    label: 'Data protection risk and breach evidence',
    keywords: ['data protection', 'personal data', 'privacy', 'gdpr', 'breach', 'retention'],
  },
  operatesPremisesOrEvents: {
    label: 'Premises, event and safety register evidence',
    keywords: ['premises', 'event', 'safety', 'insurance', 'risk assessment', 'incident'],
  },
  isPublicSectorBody: {
    label: 'Public-sector accountability evidence',
    keywords: ['public sector', 'public-sector', 'protected disclosure', 'stakeholder', 'publication'],
  },
  usesDataProcessors: {
    label: 'Processor and supplier control evidence',
    keywords: ['processor', 'supplier', 'storage', 'access control', 'retention', 'contract'],
  },
};

export function buildRegisterSearchText({
  conflicts,
  risks,
  complaints,
  fundraising,
  annual,
  financial,
}: {
  conflicts: ConflictRecordResponse[];
  risks: RiskRecordResponse[];
  complaints: ComplaintRecordResponse[];
  fundraising: FundraisingRecordResponse[];
  annual: AnnualReportReadinessResponse;
  financial: FinancialControlReviewResponse;
}) {
  return [
    conflicts.map((item) => [
      item.trusteeName,
      item.matter,
      item.nature,
      item.actionTaken,
      item.decision,
      item.minuteReference,
    ].join(' ')),
    risks.map((item) => [
      item.title,
      item.category,
      item.description,
      item.mitigation,
      item.owner,
      item.boardMinuteReference,
    ].join(' ')),
    complaints.map((item) => [
      item.source,
      item.summary,
      item.actionTaken,
      item.outcome,
      item.boardMinuteReference,
      item.reviewedByBoard ? 'board reviewed complaint' : '',
    ].join(' ')),
    fundraising.map((item) => [
      item.name,
      item.activityType,
      item.thirdPartyFundraiser,
      item.controls,
      item.reviewOutcome,
      item.publicFacing ? 'public fundraising' : '',
      item.complaintsReceived ? 'fundraising complaint' : '',
    ].join(' ')),
    [
      annual.activitiesNarrative,
      annual.publicBenefitStatement,
      annual.beneficiariesSummary,
      annual.fundraisingReviewed ? 'fundraising reviewed' : '',
      annual.complaintsReviewed ? 'complaints reviewed' : '',
      annual.notes,
    ].join(' '),
    [
      financial.payrollControlsReviewed ? 'payroll controls reviewed' : '',
      financial.fundraisingControlsReviewed ? 'fundraising controls reviewed' : '',
      financial.assetsInsuranceReviewed ? 'insurance reviewed' : '',
      financial.actions,
      financial.reviewedBy,
      financial.minuteReference,
    ].join(' '),
  ]
    .flat()
    .join(' ')
    .toLowerCase();
}

export function buildRegisterPriorities(profile: ConditionalProfile | undefined, registerSearchText: string) {
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
      const evidence = registerPriorityEvidence[rule.profileKey];
      const registerEvidenceTracked =
        evidence.keywords.some((keyword) => registerSearchText.includes(keyword.toLowerCase())) ||
        rule.standardCodes.some((code) => registerSearchText.includes(code.toLowerCase()));

      return {
        ...rule,
        sourceRefs,
        professionalReview,
        registerEvidenceLabel: evidence.label,
        registerEvidenceTracked,
      };
    });
}

export type RegisterPriority = ReturnType<typeof buildRegisterPriorities>[number];

export function RegisterPriorityPanel({
  conditionalProfile,
  priorities,
  missingCount,
  error,
  onRetry,
}: {
  conditionalProfile: ConditionalProfile;
  priorities: RegisterPriority[];
  missingCount: number;
  error: string;
  onRetry: () => void;
}) {
  return (
    <AppSection
      title="Profile-triggered register priorities"
      description="These profile-triggered obligations come from the organisation setup profile and the Irish compliance matrix. Use them to prioritise register evidence and professional review without treating CharityPilot as legal advice."
      actions={(
        <StatusChip tone={!conditionalProfile ? 'warning' : missingCount === 0 ? 'success' : 'warning'}>
          {!conditionalProfile
            ? 'Profile needed'
            : priorities.length === 0
              ? 'No triggers selected'
              : `${missingCount} register priorit${missingCount === 1 ? 'y' : 'ies'} to evidence`}
        </StatusChip>
      )}
    >
      {error ? (
        <ErrorState
          title="Profile-triggered register priorities could not be loaded"
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
          description="Answer the conditional obligation questions in Organisation before relying on register priorities."
        />
      ) : priorities.length === 0 ? (
        <EmptyState
          title="No conditional triggers selected"
          description="The current organisation profile has not selected staff, volunteers, public fundraising, safeguarding, data, premises, public-sector, or processor triggers."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {priorities.map((item) => {
            const professionalReviewLabel = item.professionalReview.length
              ? item.professionalReview.map(formatReviewFlag).join(', ')
              : 'Board judgement';
            const sourceLabel = item.sourceRefs.length
              ? item.sourceRefs.slice(0, 2).map((source) => source.owner).join(', ')
              : 'Irish compliance matrix';

            return (
              <div
                key={item.profileKey}
                className={statusPanelClassName(item.registerEvidenceTracked ? 'success' : 'warning', 'p-4')}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">{item.label}</h3>
                    <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.recommendedAction}</p>
                  </div>
                  <EvidenceChip status={item.registerEvidenceTracked ? 'ready' : 'review'}>
                    {item.registerEvidenceTracked ? 'Register signal found' : 'Add register evidence'}
                  </EvidenceChip>
                </div>
                <p className="mt-3 text-xs font-medium text-gray-500 dark:text-gray-400">
                  Priority evidence: {item.registerEvidenceLabel}
                </p>
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
