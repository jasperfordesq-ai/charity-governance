'use client';

import { Card } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
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
    <Card className={statusPanelClassName('warning', 'p-4 shadow-sm')}>
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
            <Card key={item.profileKey} className={statusPanelClassName('warning', 'p-4 shadow-sm')}>
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

export function MatrixSourceSummary({ readiness }: { readiness: ApprovalReadiness | null }) {
  if (!readiness || readiness.matrixReviewItems.length === 0) return null;

  const commencementStatuses = [
    ...new Set(readiness.matrixReviewItems.map((item) => item.commencementStatus)),
  ].sort();
  const professionalReview = [
    ...new Set(readiness.matrixReviewItems.flatMap((item) => item.professionalReview)),
  ].sort();
  const sourceRefs = [
    ...new Map(
      readiness.matrixReviewItems
        .flatMap((item) => item.sourceRefs)
        .map((source) => [source.url, source] as const),
    ).values(),
  ].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
  const notCommencedCount = readiness.matrixReviewItems.filter(
    (item) => item.commencementStatus === 'not_commenced',
  ).length;

  return (
    <AppSection
      title="Source And Review Matrix"
      description={`Matrix last checked ${readiness.matrixLastChecked}. This metadata supports trustee review and professional sign-off; it is not legal advice or a compliance certificate.`}
    >
      <Card className={statusPanelClassName('neutral', 'p-4 shadow-sm')}>
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Official sources</p>
            <p className="mt-1 text-2xl font-semibold text-gray-950 dark:text-gray-50">{sourceRefs.length}</p>
            <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
              Source-cited regulator, statutory, and specialist guidance references are included in the export appendix.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Professional review flags</p>
            <p className="mt-1 text-2xl font-semibold text-gray-950 dark:text-gray-50">{professionalReview.length}</p>
            <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
              Flags include solicitor, accounting, privacy, employment, safeguarding, and governance review where mapped.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Not commenced monitoring</p>
            <p className="mt-1 text-2xl font-semibold text-gray-950 dark:text-gray-50">{notCommencedCount}</p>
            <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
              Not-yet-commenced provisions remain visible for monitoring after professional review.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {commencementStatuses.map((status) => (
            <StatusChip key={status} tone={status === 'not_commenced' ? 'warning' : 'neutral'}>
              {readable(status)}
            </StatusChip>
          ))}
          {professionalReview.slice(0, 8).map((flag) => (
            <ReviewFlag key={flag} tone="draft">
              {readable(flag)}
            </ReviewFlag>
          ))}
        </div>
      </Card>
    </AppSection>
  );
}
