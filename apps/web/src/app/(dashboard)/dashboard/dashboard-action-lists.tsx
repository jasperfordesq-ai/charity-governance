'use client';

import { Card, Chip } from '@heroui/react';
import Link from 'next/link';
import type { BoardAlert, DeadlineResponse } from '@charitypilot/shared';

function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <Card className="animate-pulse border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-5 h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mb-3 flex items-center gap-3">
          <div className="h-3 w-3/4 rounded bg-gray-200 dark:bg-gray-800" />
          <div className="h-3 w-1/4 rounded bg-gray-200 dark:bg-gray-800" />
        </div>
      ))}
    </Card>
  );
}

export function DashboardActionLists({
  loading,
  deadlines,
  boardAlerts,
  boardMemberCount,
}: {
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
          <SkeletonList rows={5} />
        ) : deadlines && deadlines.length > 0 ? (
          <Card className="divide-y divide-gray-100 border border-gray-200 bg-white shadow-sm dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
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
                      <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{d.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
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
              <Link href="/deadlines" className="text-xs font-medium text-teal-primary hover:underline dark:text-teal-bright">
                View all deadlines
              </Link>
            </div>
          </Card>
        ) : (
          <Card className="border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            No upcoming deadlines.
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-800 dark:text-gray-100">Board Alerts</h2>
        {loading ? (
          <SkeletonList rows={4} />
        ) : boardAlerts && boardAlerts.length > 0 ? (
          <Card className="divide-y divide-gray-100 border border-gray-200 bg-white shadow-sm dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
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
                    <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{alert.memberName}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{alert.message}</p>
                  </div>
                  <Chip size="sm" color={meta.color} variant="flat">
                    {meta.label}
                  </Chip>
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
          <Card className="border border-amber-200 bg-amber-50/50 p-6 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="font-medium">No charity trustees have been added yet.</p>
            <p className="mt-1 text-xs leading-5">
              Add the board register so conduct, induction, and term-limit evidence is visible before the annual review.
            </p>
            <Link href="/board" className="mt-3 inline-flex text-xs font-semibold text-teal-primary hover:underline dark:text-teal-bright">
              Add board members
            </Link>
          </Card>
        ) : (
          <Card className="border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            No board alerts. Everything looks good!
          </Card>
        )}
      </div>
    </div>
  );
}
