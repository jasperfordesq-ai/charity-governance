'use client';

import { Card } from '@heroui/react';
import Link from 'next/link';
import type { BoardAlert, DeadlineResponse } from '@charitypilot/shared';
import { EmptyState, LoadingState, ReviewWarningState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName, type StatusTone } from '@/components/ui/status';
import { deadlineMeta, formatCivilDate, sortCurrentDeadlines } from '@/lib/deadline-display';

const stateActionClass = 'text-xs font-semibold text-teal-primary hover:underline dark:text-teal-bright';

export function DashboardActionLists({
  canManage,
  loading,
  deadlines,
  boardAlerts,
  boardMemberCount,
}: {
  canManage: boolean;
  loading: boolean;
  deadlines: DeadlineResponse[] | null;
  boardAlerts: BoardAlert[] | null;
  boardMemberCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">Upcoming Deadlines</h2>
        {loading ? (
          <LoadingState
            title="Loading deadlines"
            description="Checking filing dates and governance review actions."
          />
        ) : deadlines && deadlines.length > 0 ? (
          <Card className={statusPanelClassName('neutral', 'divide-y divide-gray-100 shadow-sm dark:divide-gray-800')}>
            {sortCurrentDeadlines(deadlines.filter((deadline) => !deadline.isComplete))
              .slice(0, 5)
              .map((d) => {
                const { daysUntil } = deadlineMeta(d);

                let chipTone: StatusTone = 'success';
                if (daysUntil < 0) chipTone = 'danger';
                else if (daysUntil <= 30) chipTone = 'warning';

                return (
                  <div key={d.id} className="flex items-center justify-between px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{d.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {formatCivilDate(d.dueDate)}
                      </p>
                    </div>
                    <StatusChip tone={chipTone}>
                      {daysUntil < 0
                        ? `${Math.abs(daysUntil)}d overdue`
                        : daysUntil === 0
                          ? 'Due today'
                          : `${daysUntil}d left`}
                    </StatusChip>
                  </div>
                );
              })}
            <div className="px-5 py-3">
              <Link href="/deadlines" className="text-xs font-medium text-teal-primary hover:underline dark:text-teal-bright">
                View all deadlines
              </Link>
            </div>
          </Card>
        ) : (
          <EmptyState
            title="No upcoming deadlines"
            description={canManage
              ? 'Add filing dates, trustee reviews, and annual return milestones as they become known.'
              : 'No filing dates, trustee reviews, or annual return milestones are currently available to review.'}
            action={(
              <Link href="/deadlines" className={stateActionClass}>
                Review deadlines
              </Link>
            )}
          />
        )}
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">Board Alerts</h2>
        {loading ? (
          <LoadingState
            title="Loading board alerts"
            description="Checking trustee conduct, induction, and term-limit signals."
          />
        ) : boardAlerts && boardAlerts.length > 0 ? (
          <Card className={statusPanelClassName('neutral', 'divide-y divide-gray-100 shadow-sm dark:divide-gray-800')}>
            {boardAlerts.slice(0, 8).map((alert, idx) => {
              const chipProps = {
                conduct_unsigned: { tone: 'warning' as const, label: 'Conduct' },
                induction_pending: { tone: 'warning' as const, label: 'Induction' },
                term_expiring: { tone: 'danger' as const, label: 'Term Limit' },
              };
              const meta = chipProps[alert.type];

              return (
                <div key={`${alert.boardMemberId}-${alert.type}-${idx}`} className="flex items-center justify-between px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{alert.memberName}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{alert.message}</p>
                  </div>
                  <StatusChip tone={meta.tone}>
                    {meta.label}
                  </StatusChip>
                </div>
              );
            })}
            <div className="px-5 py-3">
              <Link href="/board" className="text-xs font-medium text-teal-primary hover:underline dark:text-teal-bright">
                View board register
              </Link>
            </div>
          </Card>
        ) : boardMemberCount === 0 ? (
          <ReviewWarningState
            title="No charity trustees have been added yet"
            description={canManage
              ? 'Add the board register so conduct, induction, and term-limit evidence is visible before the annual review.'
              : 'An owner or administrator must add the board register before trustee evidence can be reviewed.'}
            action={(
              <Link href="/board" className={stateActionClass}>
                {canManage ? 'Add board members' : 'View board register'}
              </Link>
            )}
          />
        ) : (
          <EmptyState
            title="No board alerts"
            description="Conduct, induction, and term-limit checks are clear for active trustees."
            action={(
              <Link href="/board" className={stateActionClass}>
                View board register
              </Link>
            )}
          />
        )}
      </div>
    </div>
  );
}
