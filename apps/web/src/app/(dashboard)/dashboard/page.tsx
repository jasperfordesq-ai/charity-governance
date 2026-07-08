'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import Link from 'next/link';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, ReviewWarningState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import { DashboardActionLists } from './dashboard-action-lists';
import { DashboardProgressPanels } from './dashboard-progress-panels';
import { DashboardSummaryCards } from './dashboard-summary-cards';
import { useDashboardWorkflow } from './use-dashboard-workflow';

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const {
    boardAlerts,
    boardMemberCount,
    compliance,
    currentYear,
    deadlines,
    error,
    fetchDashboard,
    loading,
    missingExplanations,
    registerSummary,
    signoff,
    subscriptionLapsed,
    user,
  } = useDashboardWorkflow();

  return (
    <AppPage
      eyebrow={`Compliance year ${currentYear}`}
      title={<>Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</>}
      description="Trustee next actions for sign-off, evidence gaps, deadlines, registers, and annual return readiness."
      actions={(
        <>
          <Button as={Link} href="/compliance" size="sm" variant="flat">
            Compliance workspace
          </Button>
          <Button as={Link} href="/export" size="sm" className={primaryActionButtonClassName}>
            Export report
          </Button>
        </>
      )}
    >
      <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <StatusChip tone="brand" className="mb-3">
              Annual regulator cycle
            </StatusChip>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Keep the board ready for Governance Code sign-off and Annual Report filing.
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-400">
              Update the Compliance Record Form, check trustee conduct and induction,
              keep evidence linked to standards, and watch the 10-month Annual Report deadline.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button as={Link} href="/regulator" size="sm" variant="flat">
              Regulator map
            </Button>
            <Button as={Link} href="/documents" size="sm" variant="flat">
              Evidence pack
            </Button>
            <Button as={Link} href="/export" size="sm" className={primaryActionButtonClassName}>
              Export report
            </Button>
          </div>
        </div>
      </section>

      {!loading && missingExplanations.length > 0 && (
        <ReviewWarningState
          title="Annual approval is waiting on explanations"
          description={`${missingExplanations.length} standard${missingExplanations.length === 1 ? '' : 's'} marked not applicable or explain need trustee-ready explanations before the board sign-off can be approved.`}
          action={(
            <Button as={Link} href="/compliance" size="sm" variant="flat">
              Review explanations
            </Button>
          )}
        />
      )}

      {/* ── Subscription lapsed state ── */}
      {subscriptionLapsed && !loading && (
        <ReviewWarningState
          title="Your subscription or free trial has ended"
          description="Reactivate your plan to regain access to your governance data."
          action={(
            <Button as={Link} href="/billing" size="sm" variant="flat">
              Manage billing
            </Button>
          )}
        />
      )}

      {/* ── Error state ── */}
      {error && !loading && (
        <ErrorState
          title="Failed to load dashboard data"
          description="Please check your connection and try again."
          action={(
            <Button size="sm" variant="flat" onPress={() => void fetchDashboard()}>
              Try again
            </Button>
          )}
        />
      )}

      {/* ── Overall compliance score ── */}
      <DashboardProgressPanels loading={loading} compliance={compliance} />

      {/* Summary cards */}
      <DashboardSummaryCards loading={loading} registerSummary={registerSummary} signoff={signoff} />


      {/* ── Two-column: Deadlines + Board alerts ── */}
      <DashboardActionLists
        loading={loading}
        deadlines={deadlines}
        boardAlerts={boardAlerts}
        boardMemberCount={boardMemberCount}
      />
    </AppPage>
  );
}
