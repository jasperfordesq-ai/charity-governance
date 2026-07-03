'use client';

import { Card, Chip } from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { GOVERNANCE_PRINCIPLES, type ComplianceSummary } from '@charitypilot/shared';

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
  return 'text-red-600 dark:text-red-400';
};

const scoreLabel = (pct: number) => {
  if (pct >= 80) return 'Mostly recorded';
  if (pct >= 50) return 'Partly recorded';
  if (pct > 0) return 'Started';
  return 'Not started';
};

function PreviewIcon({ path }: { path: string }) {
  return (
    <svg className="h-5 w-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function PreviewCard({ iconPath, title, description }: { iconPath: string; title: string; description: string }) {
  return (
    <Card className="border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-2 flex items-center gap-2">
        <PreviewIcon path={iconPath} />
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
      description="The exported report will include the following sections:"
    >
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
              <div className="mb-3 h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" />
              <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-800" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <PreviewCard
            iconPath="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z"
            title="Organisation Details"
            description="Name, RCN, legal form, complexity, charitable purpose, contact details."
          />

          {summary ? (
            <Card className="border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="mb-2 flex items-center gap-2">
                <PreviewIcon path="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {summary.compliant} recorded compliant / {summary.totalApplicable} applicable standards
                  </span>
                </div>
              </div>
            </Card>
          ) : null}

          <Card className="border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-3 flex items-center gap-2">
              <PreviewIcon path="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
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
            iconPath="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            title="Detailed Standard Responses"
            description="Each standard with its compliance status, action taken, and evidence. Internal notes are excluded from the export."
          />

          <PreviewCard
            iconPath="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
            title="Board Members Register"
            description="Active board members with roles, appointment dates, conduct signed status, and induction status."
          />

          <Card className="border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <PreviewIcon path="M9 12.75l2.25 2.25L15 9.75M12 3.75l7.5 3v5.25c0 4.2-2.987 8.137-7.5 9.375-4.513-1.238-7.5-5.175-7.5-9.375V6.75l7.5-3z" />
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Board Approval Record</h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Approval status, board meeting date, minute reference, approver, and any sign-off notes.
                </p>
              </div>
              <Chip size="sm" color={signoffChipColor} variant="flat">
                {signoffLabel}
              </Chip>
            </div>
          </Card>

          <PreviewCard
            iconPath="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            title="Supporting Documents"
            description="List of uploaded documents with their categories and linked standards."
          />
        </div>
      )}
    </AppSection>
  );
}
