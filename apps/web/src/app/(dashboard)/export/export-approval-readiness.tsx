'use client';

import { Card } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import type { ComplianceApprovalReadinessResponse } from '@charitypilot/shared';

type ApprovalReadiness = ComplianceApprovalReadinessResponse;

const readable = (value: string) => value.replace(/_/g, ' ').toLowerCase();

function evidenceGapLabel(item: ApprovalReadiness['missingEvidence'][number]) {
  if (item.missingActionTaken && item.missingEvidence) return 'Missing action taken and evidence';
  if (item.missingActionTaken) return 'Missing action taken';
  return 'Missing evidence';
}

export function countApprovalReadinessBlockers(readiness: ApprovalReadiness | null | undefined) {
  if (!readiness) return 0;
  return (
    readiness.missingRecords.length +
    readiness.missingEvidence.length +
    readiness.missingExplanations.length +
    readiness.profileIssues.length
  );
}

export function approvalReadinessBlockerCodes(readiness: ApprovalReadiness | null | undefined) {
  if (!readiness) return [];
  return [
    ...readiness.missingRecords.map((item) => item.standardCode),
    ...readiness.missingEvidence.map((item) => item.standardCode),
    ...readiness.missingExplanations.map((item) => item.standardCode),
  ];
}

function ReadinessIssueCard({
  title,
  description,
  label = 'Approval blocker',
}: {
  title: string;
  description: string;
  label?: string;
}) {
  return (
    <Card className="border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <StatusChip tone="warning">{label}</StatusChip>
      </div>
      <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{description}</p>
    </Card>
  );
}

export function ApprovalReadinessIssues({ readiness }: { readiness: ApprovalReadiness | null }) {
  if (!readiness || countApprovalReadinessBlockers(readiness) === 0) return null;

  return (
    <AppSection
      title="Approval Readiness"
      description="These checks make missing annual Compliance Record evidence visible before trustees save an approved sign-off."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {readiness.missingRecords.map((item) => (
          <ReadinessIssueCard
            key={`record-${item.standardId}`}
            title={`Standard ${item.standardCode}`}
            description="No Compliance Record status has been captured for this standard."
          />
        ))}
        {readiness.missingEvidence.map((item) => (
          <ReadinessIssueCard
            key={`evidence-${item.standardId}`}
            title={`Standard ${item.standardCode}`}
            description={`${evidenceGapLabel(item)} for a ${readable(item.status)} record.`}
          />
        ))}
        {readiness.missingExplanations.map((item) => (
          <ReadinessIssueCard
            key={`explanation-${item.standardId}`}
            title={`Standard ${item.standardCode}`}
            description={`Add an explanation for the ${readable(item.status)} position before board approval.`}
          />
        ))}
        {readiness.profileIssues.map((item) => (
          <ReadinessIssueCard
            key={item.code}
            title="Organisation profile"
            description={item.message}
            label="Profile check"
          />
        ))}
      </div>
    </AppSection>
  );
}

export function ConditionalReviewPrompts({
  items,
}: {
  items: ApprovalReadiness['conditionalReviewItems'];
}) {
  if (items.length === 0) return null;

  return (
    <AppSection
      title="Conditional Review Prompts"
      description={`Profile facts trigger ${items.length} specialist review prompt${items.length === 1 ? '' : 's'}. These are source-cited workflow prompts, not legal conclusions.`}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((item) => {
          const professionalReviewLabel = item.professionalReview.map(readable).join(', ') || 'trustee review';
          const sourceLabel = item.sourceRefs.map((source) => source.name).join(', ') || 'current guidance';

          return (
            <Card key={item.profileKey} className="border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.label}</h3>
                <ReviewFlag tone="needs-review">Professional review</ReviewFlag>
              </div>
              <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{item.recommendedAction}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <StatusChip tone="brand">Standards {item.standardCodes.join(', ')}</StatusChip>
                <ReviewFlag tone="draft">Review: {professionalReviewLabel}</ReviewFlag>
                <ReviewFlag tone="draft">Sources: {sourceLabel}</ReviewFlag>
              </div>
            </Card>
          );
        })}
      </div>
    </AppSection>
  );
}
