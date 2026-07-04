'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable, isSubscriptionLapseError } from '@/lib/plan-feature';
import { useCallback, useEffect, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Button, Card, Progress, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { EmptyState, ErrorState, LoadingState, ReviewWarningState } from '@/components/ui/states';
import { DashboardActionLists } from './dashboard-action-lists';
import type {
  ComplianceSummary,
  DeadlineResponse,
  BoardAlert,
  ComplianceSignoffResponse,
  GovernanceRegistersSummary,
} from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';

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

  const scoreColour = (pct: number) => {
    if (pct >= 80) return 'success';
    if (pct >= 50) return 'warning';
    return 'danger';
  };

  const signoffStatus = signoff?.status ?? ComplianceSignoffStatus.DRAFT;
  const missingExplanations = approvalReadiness?.missingExplanations ?? [];
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
          <Button as={Link} href="/export" size="sm" className="bg-teal-primary text-white hover:bg-teal-dark">
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
            <Button as={Link} href="/export" size="sm" className="bg-teal-primary text-white hover:bg-teal-dark">
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
      {loading ? (
        <LoadingState
          title="Loading dashboard progress"
          description="Checking this year's standards, deadlines, trustees, and register signals."
        />
      ) : compliance ? (
        <Card className="p-6 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex-shrink-0 text-center sm:text-left">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Overall recorded progress</p>
              <p className={`text-5xl font-extrabold ${
                compliance.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                : compliance.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400'
              }`}>
                {Math.round(compliance.percentComplete)}%
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {compliance.compliant} of {compliance.totalApplicable} standards recorded compliant
              </p>
            </div>
            <div className="flex-1 min-w-0">
              <Progress
                aria-label="Overall compliance"
                value={compliance.percentComplete}
                color={scoreColour(compliance.percentComplete)}
                className="w-full"
                size="lg"
              />
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" />
                  Recorded compliant: {compliance.compliant}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
                  Working Towards: {compliance.workingTowards}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-gray-400 inline-block" />
                  Not Started: {compliance.notStarted}
                </span>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No compliance data available"
          description="Start by reviewing your standards for this reporting year."
          action={(
            <Button as={Link} href="/compliance" size="sm" variant="flat">
              Open compliance
            </Button>
          )}
        />
      )}

      {/* ── Principle progress cards ── */}
      {!loading && (
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
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Minute reference: {signoff.minuteReference}</p>
              )}
            </div>
            <Button as={Link} href="/export" size="sm" variant="flat">
              Manage sign-off
            </Button>
          </div>
        </Card>
      )}

      {!loading && registerSummary && (
        <Card className="p-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Governance registers</h2>
                <Chip
                  size="sm"
                  color={registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints > 0 ? 'warning' : 'success'}
                  variant="flat"
                >
                  {registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints} open items
                </Chip>
              </div>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Annual Report readiness {registerSummary.annualReportReadinessPercent}% · Financial controls {registerSummary.financialControlsPercent}% · Active fundraising {registerSummary.activeFundraisingActivities}
              </p>
            </div>
            <Button as={Link} href="/registers" size="sm" variant="flat">
              Open registers
            </Button>
          </div>
        </Card>
      )}

      <AppSection
        title="Progress by Principle"
        description="Open a principle to close evidence gaps and prepare the annual Compliance Record."
      >
        {loading ? (
          <LoadingState
            title="Loading principle progress"
            description="Preparing the Governance Code principle cards for this reporting year."
          />
        ) : compliance?.byPrinciple?.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {compliance.byPrinciple.map((p) => (
              <Link key={p.principleId} href={`/compliance/${p.principleId}`}>
                <Card
                  className="p-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm hover:border-teal-primary/40 dark:hover:border-teal-light/40 hover:shadow-md transition-all cursor-pointer h-full"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-8 h-8 rounded-lg bg-teal-primary/10 dark:bg-teal-light/10 text-teal-primary dark:text-teal-bright flex items-center justify-center text-sm font-bold">
                      {p.principleNumber}
                    </div>
                    <div className="text-right">
                      <span className={`text-lg font-bold ${
                        p.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                        : p.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                        : 'text-gray-500 dark:text-gray-400'
                      }`}>
                        {Math.round(p.percentComplete)}%
                      </span>
                      <span className={`block text-[10px] font-medium ${
                        p.percentComplete >= 80 ? 'text-green-600 dark:text-green-400'
                        : p.percentComplete >= 50 ? 'text-amber-700 dark:text-amber-400'
                        : 'text-gray-500 dark:text-gray-400'
                      }`}>
                        {p.percentComplete >= 80 ? 'Mostly recorded' : p.percentComplete >= 50 ? 'Partly recorded' : p.percentComplete > 0 ? 'Started' : 'Not started'}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2 line-clamp-2">
                    {p.principleTitle}
                  </p>
                  <Progress
                    aria-label={`Principle ${p.principleNumber} progress`}
                    value={p.percentComplete}
                    color={scoreColour(p.percentComplete)}
                    size="sm"
                    className="w-full"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {p.compliant} / {p.totalApplicable} standards
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No principle data available"
            description="Review the Governance Code standards to start building the annual Compliance Record."
            action={(
              <Button as={Link} href="/compliance" size="sm" variant="flat">
                Open compliance
              </Button>
            )}
          />
        )}
      </AppSection>

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
