'use client';

import { Button, Card, Select, SelectItem } from '@heroui/react';
import { Download } from 'lucide-react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ReviewWarningState } from '@/components/ui/states';
import { statusPanelClassName } from '@/components/ui/status';
import type { ComplianceApprovalSnapshotSummary } from '@charitypilot/shared';

export function ExportControlsPanel({
  approvalCurrent,
  approvalUnavailable,
  exportingApproved,
  exportingCurrent,
  latestApproval,
  onExportApproved,
  onExportCurrent,
  onYearChange,
  readinessBlockerCodes,
  readinessBlockerCount,
  signoffDirty,
  year,
  yearOptions,
}: {
  approvalCurrent: boolean;
  approvalUnavailable: boolean;
  exportingApproved: boolean;
  exportingCurrent: boolean;
  latestApproval: ComplianceApprovalSnapshotSummary | null;
  onExportApproved: () => void;
  onExportCurrent: () => void;
  onYearChange: (year: number) => void;
  readinessBlockerCodes: string[];
  readinessBlockerCount: number;
  signoffDirty: boolean;
  year: number;
  yearOptions: number[];
}) {
  return (
    <>
      <Card className={statusPanelClassName('neutral', 'p-6 shadow-sm')}>
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Select
            label="Reporting Year"
            selectedKeys={new Set([String(year)])}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              if (val) onYearChange(Number(val));
            }}
            className="w-48"
          >
            {yearOptions.map((option) => (
              <SelectItem key={String(option)}>{String(option)}</SelectItem>
            ))}
          </Select>

          <Button className={primaryActionButtonClassName} size="lg" onPress={onExportCurrent} isLoading={exportingCurrent}>
            <Download className="w-5 h-5 mr-2" aria-hidden="true" />
            Generate Compliance Report (working copy)
          </Button>

          {latestApproval ? (
            <Button
              size="lg"
              variant="flat"
              color={approvalCurrent ? 'success' : 'warning'}
              onPress={onExportApproved}
              isLoading={exportingApproved}
            >
              <Download className="w-5 h-5 mr-2" aria-hidden="true" />
              Open latest approved snapshot
            </Button>
          ) : null}
        </div>
        <p className="mt-4 text-sm leading-6 text-gray-600 dark:text-gray-300">
          The working report reflects current records and may be unapproved. An approved snapshot is an immutable copy retained from
          the recorded board approval, even if later edits require reapproval.
        </p>
        {latestApproval ? (
          <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">
            Latest approved snapshot #{latestApproval.approvalSequence}, approved{' '}
            {new Date(latestApproval.approvedAt).toLocaleDateString('en-IE')}. Snapshot hash{' '}
            <span className="font-mono">{latestApproval.snapshotHash.slice(0, 12)}...</span>
          </p>
        ) : null}
        {signoffDirty ? (
          <p className="mt-3 text-sm font-medium leading-6 text-amber-700 dark:text-amber-300">
            Save or discard the sign-off edits before changing reporting year.
          </p>
        ) : null}
        {readinessBlockerCount > 0 && (
          <p className="mt-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
            This export can still be opened for review, but it is not board-approval-ready until {readinessBlockerCount} readiness blocker{readinessBlockerCount === 1 ? '' : 's'} are resolved.
          </p>
        )}
      </Card>

      {approvalUnavailable && (
        <ReviewWarningState
          title="Approval readiness is unavailable"
          description="The current evidence hash could not be verified. Working-report export remains available, but board approval is blocked until readiness reloads successfully."
        />
      )}

      {readinessBlockerCount > 0 && (
        <ReviewWarningState
          title="Readiness blockers prevent board approval"
          description={`Resolve missing records, evidence fields, explanations, and profile checks before saving an approved sign-off. ${readinessBlockerCodes.length > 0 ? `Affected standards: ${readinessBlockerCodes.join(', ')}.` : 'The organisation profile needs review.'} The export remains available as a review-ready working report.`}
        />
      )}
    </>
  );
}
