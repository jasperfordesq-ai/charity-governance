'use client';

import { Card } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { LoadingState } from '@/components/ui/states';
import { StatusChip, statusPanelClassName, type StatusTone } from '@/components/ui/status';
import { GOVERNANCE_PRINCIPLES, type ComplianceSummary } from '@charitypilot/shared';
import type { ReactNode } from 'react';
import { Building2, CircleCheck, FileText, ListChecks, ShieldCheck, UsersRound } from 'lucide-react';

type SignoffChipColor = 'default' | 'success' | 'warning';

type ExportReportPreviewProps = {
  loading: boolean;
  summary: ComplianceSummary | null;
  signoffLabel: string;
  signoffChipColor: SignoffChipColor;
};

const scoreColour = (pct: number) => {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-300';
};

const scoreLabel = (pct: number) => {
  if (pct >= 80) return 'Mostly recorded';
  if (pct >= 50) return 'Partly recorded';
  if (pct > 0) return 'Started';
  return 'Not started';
};

const scoreTone = (pct: number): StatusTone => {
  if (pct >= 80) return 'success';
  if (pct >= 50) return 'warning';
  return 'danger';
};

const signoffTone = (color: SignoffChipColor): StatusTone => {
  if (color === 'success') return 'success';
  if (color === 'warning') return 'warning';
  return 'neutral';
};

const previewIconClassName = 'h-5 w-5 text-teal-primary';

function PreviewIcon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex text-teal-primary" aria-hidden="true">
      {children}
    </span>
  );
}

function PreviewCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <Card className={statusPanelClassName('neutral', 'p-5 shadow-sm')}>
      <div className="mb-2 flex items-center gap-2">
        <PreviewIcon>{icon}</PreviewIcon>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>
    </Card>
  );
}

export function ExportReportPreview({
  loading,
  summary,
  signoffLabel,
  signoffChipColor,
}: ExportReportPreviewProps) {
  return (
    <AppSection
      title="Report Preview"
      description="The current working report will include the following sections. Retained approved snapshots preserve the exact evidence captured when approval was recorded."
    >
      {loading ? (
        <LoadingState
          title="Loading report preview"
          description="Preparing the sections that will appear in the exported compliance report."
        />
      ) : (
        <div className="space-y-4">
          <PreviewCard
            icon={<Building2 className={previewIconClassName} strokeWidth={1.5} />}
            title="Organisation Details"
            description="Organisation name, registered charity number, and reporting year."
          />

          {summary ? (
            <Card className={statusPanelClassName(scoreTone(summary.percentComplete), 'p-5 shadow-sm')}>
              <div className="mb-2 flex items-center gap-2">
                <PreviewIcon>
                  <CircleCheck className={previewIconClassName} strokeWidth={1.5} />
                </PreviewIcon>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Overall recorded progress</h3>
              </div>
              <div className="flex items-center gap-4">
                <span className={`text-2xl font-bold ${scoreColour(summary.percentComplete)}`}>
                  {Math.round(summary.percentComplete)}%
                </span>
                <div>
                  <span className={`text-xs font-semibold ${scoreColour(summary.percentComplete)}`}>
                    {scoreLabel(summary.percentComplete)}
                  </span>
                  <span className="block text-xs text-gray-600 dark:text-gray-300">
                    {summary.compliant} recorded compliant / {summary.totalApplicable} applicable standards
                  </span>
                </div>
              </div>
            </Card>
          ) : null}

          <Card className={statusPanelClassName('neutral', 'p-5 shadow-sm')}>
            <div className="mb-3 flex items-center gap-2">
              <PreviewIcon>
                <ListChecks className={previewIconClassName} strokeWidth={1.5} />
              </PreviewIcon>
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Compliance by Principle</h3>
            </div>
            <div className="space-y-2">
              {GOVERNANCE_PRINCIPLES.map((p) => {
                const pSummary = summary?.byPrinciple?.find(
                  (bp) => bp.principleNumber === p.number,
                );
                const pct = pSummary?.percentComplete ?? 0;

                return (
                  <div
                    key={p.number}
                    className="flex items-center justify-between border-b border-gray-100 py-1.5 text-sm last:border-0 dark:border-gray-800"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-4 text-xs font-bold font-mono text-gray-500 dark:text-gray-400">
                        {p.number}
                      </span>
                      <span className="truncate text-gray-700 dark:text-gray-300">{p.title}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <span className={`text-xs font-medium ${scoreColour(pct)}`}>
                        {scoreLabel(pct)}
                      </span>
                      <span className={`text-sm font-semibold ${scoreColour(pct)}`}>
                        {Math.round(pct)}%
                      </span>
                      {pSummary ? (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          ({pSummary.compliant}/{pSummary.totalApplicable})
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <PreviewCard
            icon={<FileText className={previewIconClassName} strokeWidth={1.5} />}
            title="Detailed Standard Responses"
            description="Each standard with its compliance status, action taken, and evidence. Internal notes are excluded from the export."
          />

          <Card className={statusPanelClassName(signoffTone(signoffChipColor), 'p-5 shadow-sm')}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <PreviewIcon>
                    <ShieldCheck className={previewIconClassName} strokeWidth={1.5} />
                  </PreviewIcon>
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Board Approval Record</h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Approval status, board meeting date, minute reference, approver, and any sign-off notes.
                </p>
              </div>
              <StatusChip tone={signoffTone(signoffChipColor)}>
                {signoffLabel}
              </StatusChip>
            </div>
          </Card>

          <PreviewCard
            icon={<UsersRound className={previewIconClassName} strokeWidth={1.5} />}
            title="Approval Attribution"
            description="When a sign-off is recorded, the report includes the approver name and role entered for that board decision."
          />

        </div>
      )}
    </AppSection>
  );
}
