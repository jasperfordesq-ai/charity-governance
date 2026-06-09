'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable } from '@/lib/plan-feature';
import { useEffect, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Button, Card, Progress, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import type {
  ComplianceSummary,
  DeadlineResponse,
  BoardAlert,
  ComplianceSignoffResponse,
  GovernanceRegistersSummary,
} from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';

/* ------------------------------------------------------------------ */
/*  Skeleton components                                               */
/* ------------------------------------------------------------------ */

function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <Card className={`p-6 animate-pulse ${className}`}>
      <div className="h-4 bg-gray-200 rounded w-1/3 mb-4" />
      <div className="h-8 bg-gray-200 rounded w-1/2 mb-3" />
      <div className="h-3 bg-gray-200 rounded w-full" />
    </Card>
  );
}

function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <Card className="p-6 animate-pulse">
      <div className="h-4 bg-gray-200 rounded w-1/3 mb-5" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 mb-3">
          <div className="h-3 bg-gray-200 rounded w-3/4" />
          <div className="h-3 bg-gray-200 rounded w-1/4" />
        </div>
      ))}
    </Card>
  );
}

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
  const [registerSummary, setRegisterSummary] = useState<GovernanceRegistersSummary | null>(null);
  const [boardMemberCount, setBoardMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const currentYear = new Date().getFullYear();

  useEffect(() => {
    async function fetchDashboard() {
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
        logClientError('Failed to load dashboard data', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboard();
  }, [currentYear]);

  const scoreColour = (pct: number) => {
    if (pct >= 80) return 'success';
    if (pct >= 50) return 'warning';
    return 'danger';
  };

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

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Here is your governance compliance overview for {currentYear}.
        </p>
      </div>

      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <Chip size="sm" variant="flat" className="mb-3 bg-teal-primary/10 text-teal-primary">
              Annual regulator cycle
            </Chip>
            <h2 className="text-lg font-semibold text-gray-900">
              Keep the board ready for Governance Code sign-off and Annual Report filing.
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
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

      {/* ── Error state ── */}
      {error && !loading && (
        <Card className="p-6 border border-red-200 bg-red-50/50" role="alert">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-800">Failed to load dashboard data</p>
              <p className="text-xs text-red-600">Please check your connection and try refreshing the page.</p>
            </div>
          </div>
        </Card>
      )}

      {/* ── Overall compliance score ── */}
      {loading ? (
        <SkeletonCard />
      ) : compliance ? (
        <Card className="p-6 border border-gray-200 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex-shrink-0 text-center sm:text-left">
              <p className="text-sm font-medium text-gray-500 mb-1">Overall Compliance Score</p>
              <p className={`text-5xl font-extrabold ${
                compliance.percentComplete >= 80 ? 'text-green-600'
                : compliance.percentComplete >= 50 ? 'text-amber-accent'
                : 'text-red-500'
              }`}>
                {Math.round(compliance.percentComplete)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {compliance.compliant} of {compliance.totalApplicable} standards compliant
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
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" />
                  Compliant: {compliance.compliant}
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
        <Card className="p-6 border border-gray-200 text-center text-gray-400">
          No compliance data available. Start by reviewing your standards.
        </Card>
      )}

      {/* ── Principle progress cards ── */}
      {!loading && (
        <Card className="p-5 border border-gray-200 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900">Annual board sign-off</h2>
                <Chip size="sm" color={signoffMeta.color} variant="flat">
                  {signoffMeta.label}
                </Chip>
              </div>
              <p className="mt-1 text-sm text-gray-600">{signoffMeta.text}</p>
              {signoff?.minuteReference && (
                <p className="mt-1 text-xs text-gray-400">Minute reference: {signoff.minuteReference}</p>
              )}
            </div>
            <Button as={Link} href="/export" size="sm" variant="flat">
              Manage sign-off
            </Button>
          </div>
        </Card>
      )}

      {!loading && registerSummary && (
        <Card className="p-5 border border-gray-200 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900">Governance registers</h2>
                <Chip
                  size="sm"
                  color={registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints > 0 ? 'warning' : 'success'}
                  variant="flat"
                >
                  {registerSummary.openRisks + registerSummary.openConflicts + registerSummary.openComplaints} open items
                </Chip>
              </div>
              <p className="mt-1 text-sm text-gray-600">
                Annual Report readiness {registerSummary.annualReportReadinessPercent}% · Financial controls {registerSummary.financialControlsPercent}% · Active fundraising {registerSummary.activeFundraisingActivities}
              </p>
            </div>
            <Button as={Link} href="/registers" size="sm" variant="flat">
              Open registers
            </Button>
          </div>
        </Card>
      )}

      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Progress by Principle</h2>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : compliance?.byPrinciple?.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {compliance.byPrinciple.map((p) => (
              <Link key={p.principleId} href={`/compliance/${p.principleId}`}>
                <Card
                  className="p-5 border border-gray-200 shadow-sm hover:border-teal-primary/40 hover:shadow-md transition-all cursor-pointer h-full"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-8 h-8 rounded-lg bg-teal-primary/10 text-teal-primary flex items-center justify-center text-sm font-bold">
                      {p.principleNumber}
                    </div>
                    <div className="text-right">
                      <span className={`text-lg font-bold ${
                        p.percentComplete >= 80 ? 'text-green-600'
                        : p.percentComplete >= 50 ? 'text-amber-500'
                        : 'text-gray-400'
                      }`}>
                        {Math.round(p.percentComplete)}%
                      </span>
                      <span className={`block text-[10px] font-medium ${
                        p.percentComplete >= 80 ? 'text-green-600'
                        : p.percentComplete >= 50 ? 'text-amber-500'
                        : 'text-gray-400'
                      }`}>
                        {p.percentComplete >= 80 ? 'Compliant' : p.percentComplete >= 50 ? 'Working Towards' : p.percentComplete > 0 ? 'In Progress' : 'Not Started'}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-gray-800 mb-2 line-clamp-2">
                    {p.principleTitle}
                  </p>
                  <Progress
                    aria-label={`Principle ${p.principleNumber} progress`}
                    value={p.percentComplete}
                    color={scoreColour(p.percentComplete)}
                    size="sm"
                    className="w-full"
                  />
                  <p className="text-xs text-gray-400 mt-2">
                    {p.compliant} / {p.totalApplicable} standards
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400">No principle data available yet.</p>
        )}
      </div>

      {/* ── Two-column: Deadlines + Board alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming deadlines */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Upcoming Deadlines</h2>
          {loading ? (
            <SkeletonList rows={5} />
          ) : deadlines && deadlines.length > 0 ? (
            <Card className="border border-gray-200 shadow-sm divide-y divide-gray-100">
              {deadlines
                .filter((d) => !d.isComplete)
                .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
                .slice(0, 5)
                .map((d) => {
                  const due = new Date(d.dueDate);
                  const now = new Date();
                  const daysUntil = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

                  let chipColor: 'danger' | 'warning' | 'success' = 'success';
                  if (daysUntil < 0) chipColor = 'danger';
                  else if (daysUntil <= 30) chipColor = 'warning';

                  return (
                    <div key={d.id} className="flex items-center justify-between px-5 py-3.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{d.title}</p>
                        <p className="text-xs text-gray-400">
                          {due.toLocaleDateString('en-IE', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </p>
                      </div>
                      <Chip size="sm" color={chipColor} variant="flat">
                        {daysUntil < 0
                          ? `${Math.abs(daysUntil)}d overdue`
                          : daysUntil === 0
                            ? 'Due today'
                            : `${daysUntil}d left`}
                      </Chip>
                    </div>
                  );
                })}
              <div className="px-5 py-3">
                <Link href="/deadlines" className="text-xs font-medium text-teal-primary hover:underline">
                  View all deadlines
                </Link>
              </div>
            </Card>
          ) : (
            <Card className="p-6 border border-gray-200 text-center text-sm text-gray-400">
              No upcoming deadlines.
            </Card>
          )}
        </div>

        {/* Board alerts */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Board Alerts</h2>
          {loading ? (
            <SkeletonList rows={4} />
          ) : boardAlerts && boardAlerts.length > 0 ? (
            <Card className="border border-gray-200 shadow-sm divide-y divide-gray-100">
              {boardAlerts.slice(0, 8).map((alert, idx) => {
                const chipProps = {
                  conduct_unsigned: { color: 'warning' as const, label: 'Conduct' },
                  induction_pending: { color: 'warning' as const, label: 'Induction' },
                  term_expiring: { color: 'danger' as const, label: 'Term Limit' },
                };
                const meta = chipProps[alert.type];

                return (
                  <div key={`${alert.boardMemberId}-${alert.type}-${idx}`} className="flex items-center justify-between px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{alert.memberName}</p>
                      <p className="text-xs text-gray-400">{alert.message}</p>
                    </div>
                    <Chip size="sm" color={meta.color} variant="flat">
                      {meta.label}
                    </Chip>
                  </div>
                );
              })}
              <div className="px-5 py-3">
                <Link href="/board" className="text-xs font-medium text-teal-primary hover:underline">
                  View board register
                </Link>
              </div>
            </Card>
          ) : boardMemberCount === 0 ? (
            <Card className="p-6 border border-amber-200 bg-amber-50/50 text-sm text-amber-800">
              <p className="font-medium">No charity trustees have been added yet.</p>
              <p className="mt-1 text-xs leading-5">
                Add the board register so conduct, induction, and term-limit evidence is visible before the annual review.
              </p>
              <Link href="/board" className="mt-3 inline-flex text-xs font-semibold text-teal-primary hover:underline">
                Add board members
              </Link>
            </Card>
          ) : (
            <Card className="p-6 border border-gray-200 text-center text-sm text-gray-400">
              No board alerts. Everything looks good!
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
