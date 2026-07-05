'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, ReviewWarningState } from '@/components/ui/states';
import { ComplianceSignoffStatus } from '@charitypilot/shared';
import {
  ApprovalReadinessIssues,
  ConditionalReviewPrompts,
  MatrixSourceSummary,
} from './export-approval-readiness';
import { ExportBoardApprovalPanel } from './export-board-approval-panel';
import { ExportControlsPanel } from './export-controls-panel';
import { ExportReportPreview } from './export-report-preview';
import { useExportWorkflow } from './use-export-workflow';

const signoffStatusLabels = {
  [ComplianceSignoffStatus.DRAFT]: 'Draft',
  [ComplianceSignoffStatus.BOARD_REVIEW]: 'Ready for board review',
  [ComplianceSignoffStatus.APPROVED]: 'Approved by board',
};

export default function ExportPage() {
  useDocumentTitle('Export Report');
  const {
    approvalReadiness,
    conditionalReviewItems,
    exporting,
    fetchSummary,
    handleExport,
    handleSaveSignoff,
    loading,
    loadError,
    readinessBlockerCodes,
    readinessBlockerCount,
    savingSignoff,
    setSignoffForm,
    setYear,
    signoff,
    signoffChipColor,
    signoffError,
    signoffForm,
    summary,
    year,
    yearOptions,
  } = useExportWorkflow();

  if (loadError && !loading) {
    return (
      <AppPage
        eyebrow={`Reporting year ${year}`}
        title="Export Compliance Report"
        description="Generate a review-ready, evidence-led report for trustee review and filing records. CharityPilot supports workflow preparation; it is not legal advice."
      >
        <ErrorState
          title="Export data could not be loaded"
          description={loadError}
          action={(
            <Button size="sm" variant="flat" onPress={fetchSummary}>
              Try again
            </Button>
          )}
        />
      </AppPage>
    );
  }

  return (
    <AppPage
      eyebrow={`Reporting year ${year}`}
      title="Export Compliance Report"
      description="Generate a review-ready, evidence-led report for trustee review and filing records. CharityPilot supports workflow preparation; it is not legal advice."
    >
      <ExportControlsPanel
        exporting={exporting}
        onExport={handleExport}
        onYearChange={setYear}
        readinessBlockerCodes={readinessBlockerCodes}
        readinessBlockerCount={readinessBlockerCount}
        year={year}
        yearOptions={yearOptions}
      />

      <ApprovalReadinessIssues readiness={approvalReadiness} />

      <ConditionalReviewPrompts items={conditionalReviewItems} />

      <MatrixSourceSummary readiness={approvalReadiness} />

      <ExportBoardApprovalPanel
        onSaveSignoff={handleSaveSignoff}
        savingSignoff={savingSignoff}
        setSignoffForm={setSignoffForm}
        signoff={signoff}
        signoffChipColor={signoffChipColor}
        signoffError={signoffError}
        signoffForm={signoffForm}
        signoffStatusLabels={signoffStatusLabels}
      />

      <ExportReportPreview
        loading={loading}
        summary={summary}
        signoffLabel={signoffStatusLabels[signoffForm.status]}
        signoffChipColor={signoffChipColor}
      />

      <ReviewWarningState
        title="Before exporting"
        description="Make sure all compliance records are up to date, the organisation profile is complete, and trustees have reviewed the annual position. Internal notes are excluded from the exported report. Use your browser's Print to PDF option to save a copy."
      />
    </AppPage>
  );
}
