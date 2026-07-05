'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable, isSubscriptionLapseError } from '@/lib/plan-feature';
import { useCallback, useEffect, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Button, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, ReviewWarningState } from '@/components/ui/states';
import { DashboardActionLists } from './dashboard-action-lists';
import { DashboardProgressPanels } from './dashboard-progress-panels';
import { DashboardSummaryCards } from './dashboard-summary-cards';
import type {
  ComplianceSummary,
  DeadlineResponse,
  BoardAlert,
  ComplianceSignoffResponse,
  GovernanceRegistersSummary,
} from '@charitypilot/shared';

type ApprovalReadiness = {
  ready: boolean;
  missingExplanations: Array<{
    standardId: string;
    standardCode: string;
    status: 'NOT_APPLICABLE' | 'EXPLAIN';
  }>;
};

/* ------------------------------------------------------------------ */
/*  Dashboard page                                                    */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const { user } = useAuth();
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineResponse[] | null>(null);
  const [boardAlerts, setBoardAlerts] = useState<BoardAlert[] | null>(null);
  const [signoff, setSignoff] = useState<ComplianceSignoffResponse | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [registerSummary, setRegisterSummary] = useState<GovernanceRegistersSummary | null>(null);
  const [boardMemberCount, setBoardMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [subscriptionLapsed, setSubscriptionLapsed] = useState(false);

  const currentYear = new Date().getFullYear();

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(false);
    setSubscriptionLapsed(false);
    try {
      const [summaryRes, deadlinesRes, boardRes, signoffRes] = await Promise.all([
        api.get(`/compliance/summary?year=${currentYear}`),
        api.get('/deadlines'),
        api.get('/board-members'),
        api.get(`/compliance/signoff?year=${currentYear}`),
      ]);

      setCompliance(summaryRes.data);
      setDeadlines(deadlinesRes.data?.data ?? deadlinesRes.data);
      setSignoff(signoffRes.data);

      try {
        const readinessRes = await api.get(`/compliance/approval-readiness?year=${currentYear}`);
        setApprovalReadiness(readinessRes.data);
      } catch (readinessErr) {
        logClientError('Failed to load approval readiness', readinessErr);
        setApprovalReadiness(null);
      }

      // Derive board alerts from board members
      const members = boardRes.data?.data ?? boardRes.data ?? [];
      setBoardMemberCount(members.length);
      const alerts: BoardAlert[] = [];
      const now = new Date();

      for (const m of members) {
        if (!m.isActive) continue;
        if (!m.conductSigned) {
          alerts.push({
            boardMemberId: m.id,
            memberName: m.name,
            type: 'conduct_unsigned',
            message: `${m.name} has not signed the code of conduct`,
          });
        }
        if (!m.inductionCompleted) {
          alerts.push({
            boardMemberId: m.id,
            memberName: m.name,
            type: 'induction_pending',
            message: `${m.name} has not completed induction`,
          });
        }
        if (m.appointedDate) {
          const appointed = new Date(m.appointedDate);
          const yearsServed = (now.getTime() - appointed.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
          if (yearsServed >= 8) {
            alerts.push({
              boardMemberId: m.id,
              memberName: m.name,
              type: 'term_expiring',
              message: `${m.name} is approaching the 9-year term limit (${Math.floor(yearsServed)} years served)`,
            });
          }
        }
      }

      setBoardAlerts(alerts);

      try {
        const registerRes = await api.get(`/governance-registers/summary?year=${currentYear}`);
        setRegisterSummary(registerRes.data);
      } catch (registerErr) {
        if (!isPlanFeatureUnavailable(registerErr)) {
          logClientError('Failed to load governance register summary', registerErr);
        }
        setRegisterSummary(null);
      }
    } catch (err) {
      if (isSubscriptionLapseError(err)) {
        setSubscriptionLapsed(true);
      } else {
        logClientError('Failed to load dashboard data', err);
        setError(true);
      }
    } finally {
      setLoading(false);
    }
  }, [currentYear]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const missingExplanations = approvalReadiness?.missingExplanations ?? [];

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
      <section className="rounded-lg border border-teal-primary/20 dark:border-teal-light/20 bg-white dark:bg-gray-900 p-5 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <Chip size="sm" variant="flat" className="mb-3 bg-teal-primary/10 dark:bg-teal-light/10 text-teal-primary dark:text-teal-bright">
              Annual regulator cycle
            </Chip>
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
