'use client';

import { Button, Card } from '@heroui/react';
import Link from 'next/link';
import type { ComplianceSignoffResponse, GovernanceRegistersSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';
import { LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName, type StatusTone } from '@/components/ui/status';

type DashboardSummaryCardsProps = {
  loading: boolean;
  registerSummary: GovernanceRegistersSummary | null;
  signoff: ComplianceSignoffResponse | null;
};

export function DashboardSummaryCards({ loading, registerSummary, signoff }: DashboardSummaryCardsProps) {
  if (loading) {
    return (
      <LoadingState
        title="Loading governance summaries"
        description="Preparing board sign-off and register readiness for the selected compliance year."
      />
    );
  }

  const signoffStatus = signoff?.status ?? ComplianceSignoffStatus.DRAFT;
  const approvalCurrent = Boolean(
    signoffStatus === ComplianceSignoffStatus.APPROVED && signoff?.approvalCurrent,
  );
  const reapprovalRequired = Boolean(
    !approvalCurrent && (signoffStatus === ComplianceSignoffStatus.APPROVED || signoff?.latestApproval),
  );
  let signoffMeta: { tone: StatusTone; label: string; text: string };
  if (approvalCurrent) {
    signoffMeta = {
      tone: 'success',
      label: 'Approved',
      text: signoff?.boardMeetingDate
        ? `Approved at board meeting on ${new Date(signoff.boardMeetingDate).toLocaleDateString('en-IE')}.`
        : 'The annual Compliance Record has been marked approved.',
    };
  } else if (reapprovalRequired) {
    signoffMeta = {
      tone: 'warning',
      label: 'Reapproval required',
      text: 'A prior approved snapshot is retained, but current compliance work must be reviewed and approved again.',
    };
  } else if (signoffStatus === ComplianceSignoffStatus.BOARD_REVIEW) {
    signoffMeta = {
      tone: 'warning',
      label: 'Board review',
      text: 'The Compliance Record is ready for trustee review and board minute approval.',
    };
  } else {
    signoffMeta = {
      tone: 'neutral',
      label: 'Draft',
      text: 'Record board approval before reporting the annual compliance position.',
    };
  }
  const openRegisterItems = registerSummary
    ? registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints
    : 0;
  const registerTone: StatusTone = openRegisterItems > 0 ? 'warning' : 'success';

  return (
    <>
      <Card className={statusPanelClassName('neutral', 'p-5 shadow-sm')}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Annual board sign-off</h2>
              <StatusChip tone={signoffMeta.tone}>
                {signoffMeta.label}
              </StatusChip>
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{signoffMeta.text}</p>
            {approvalCurrent && signoff?.minuteReference && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Minute reference: {signoff.minuteReference}
              </p>
            )}
            {reapprovalRequired && signoff?.latestApproval ? (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Retained approved snapshot #{signoff.latestApproval.approvalSequence}
              </p>
            ) : null}
          </div>
          <Button as={Link} href="/export" size="sm" variant="flat">
            Manage sign-off
          </Button>
        </div>
      </Card>

      {registerSummary && (
        <Card className={statusPanelClassName('neutral', 'p-5 shadow-sm')}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Governance registers</h2>
                <StatusChip tone={registerTone}>
                  {openRegisterItems} open items
                </StatusChip>
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
