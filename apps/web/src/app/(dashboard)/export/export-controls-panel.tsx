'use client';

import { Button, Card, Select, SelectItem } from '@heroui/react';
import { Download } from 'lucide-react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { ReviewWarningState } from '@/components/ui/states';

export function ExportControlsPanel({
  exporting,
  onExport,
  onYearChange,
  readinessBlockerCodes,
  readinessBlockerCount,
  year,
  yearOptions,
}: {
  exporting: boolean;
  onExport: () => void;
  onYearChange: (year: number) => void;
  readinessBlockerCodes: string[];
  readinessBlockerCount: number;
  year: number;
  yearOptions: number[];
}) {
  return (
    <>
      <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4">
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

          <Button className={primaryActionButtonClassName} size="lg" onPress={onExport} isLoading={exporting}>
            <Download className="w-5 h-5 mr-2" aria-hidden="true" />
            Generate Compliance Report
          </Button>
        </div>
        {readinessBlockerCount > 0 && (
          <p className="mt-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
            This export can still be opened for review, but it is not board-approval-ready until {readinessBlockerCount} readiness blocker{readinessBlockerCount === 1 ? '' : 's'} are resolved.
          </p>
        )}
      </Card>

      {readinessBlockerCount > 0 && (
        <ReviewWarningState
          title="Readiness blockers prevent board approval"
          description={`Resolve missing records, evidence fields, explanations, and profile checks before saving an approved sign-off. ${readinessBlockerCodes.length > 0 ? `Affected standards: ${readinessBlockerCodes.join(', ')}.` : 'The organisation profile needs review.'} The export remains available as a review-ready working report.`}
        />
      )}
    </>
  );
}
