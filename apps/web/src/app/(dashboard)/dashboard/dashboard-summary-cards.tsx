'use client';

import { Button, Card, Chip } from '@heroui/react';
import Link from 'next/link';
import type { ComplianceSignoffResponse, GovernanceRegistersSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';

type DashboardSummaryCardsProps = {
  loading: boolean;
  registerSummary: GovernanceRegistersSummary | null;
  signoff: ComplianceSignoffResponse | null;
};

export function DashboardSummaryCards({ loading, registerSummary, signoff }: DashboardSummaryCardsProps) {
  const signoffStatus = signoff?.status ?? ComplianceSignoffStatus.DRAFT;
  const signoffMeta = {
    [ComplianceSignoffStatus.APPROVED]: {
      color: 'success' as const,
      label: 'Approved',
      text: signoff?.boardMeetingDate
        ? `Approved at board meeting on ${new Date(signoff.boardMeetingDate).toLocaleDateString('en-IE')}.`
        : 'The annual Compliance Record has been marked approved.',
    },
    [ComplianceSignoffStatus.BOARD_REVIEW]: {
      color: 'warning' as const,
      label: 'Board review',
      text: 'The Compliance Record is ready for trustee review and board minute approval.',
    },
    [ComplianceSignoffStatus.DRAFT]: {
      color: 'default' as const,
      label: 'Draft',
      text: 'Record board approval before reporting the annual compliance position.',
    },
  }[signoffStatus];

  if (loading) return null;

  return (
    <>
      <Card className="p-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Annual board sign-off</h2>
              <Chip size="sm" color={signoffMeta.color} variant="flat">
                {signoffMeta.label}
              </Chip>
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{signoffMeta.text}</p>
            {signoff?.minuteReference && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Minute reference: {signoff.minuteReference}
              </p>
            )}
          </div>
          <Button as={Link} href="/export" size="sm" variant="flat">
            Manage sign-off
          </Button>
        </div>
      </Card>

      {registerSummary && (
        <Card className="p-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Governance registers</h2>
                <Chip
                  size="sm"
                  color={
                    registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints > 0
                      ? 'warning'
                      : 'success'
                  }
                  variant="flat"
                >
                  {registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints} open items
                </Chip>
              </div>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Annual Report readiness {registerSummary.annualReportReadinessPercent}% | Financial controls{' '}
                {registerSummary.financialControlsPercent}% | Active fundraising{' '}
                {registerSummary.activeFundraisingActivities}
              </p>
            </div>
            <Button as={Link} href="/registers" size="sm" variant="flat">
              Open registers
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
