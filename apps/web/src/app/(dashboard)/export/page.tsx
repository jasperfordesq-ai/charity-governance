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
import { ExportNavigationConfirmModal } from './export-navigation-confirm-modal';
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
    acknowledgeSignoffReview,
    approvalReadiness,
    approvalPresentation,
    approvalSaveBlocked,
    approvalUnavailable,
    conditionalReviewItems,
    discardSignoffChanges,
    displayedSignoffSaveState,
    exportingApproved,
    exportingCurrent,
    fetchSummary,
    handleExportApproved,
    handleExportCurrent,
    handleSaveSignoff,
    latestApproval,
    loading,
    loadError,
    navigationConfirmOpen,
    discardSignoffAndContinueNavigation,
    readinessBlockerCodes,
    readinessBlockerCount,
    requestYearChange,
    retrySignoffConflictRefresh,
    savingSignoff,
    setSignoffForm,
    signoff,
    signoffConflictRefreshFailed,
    signoffDirty,
    signoffError,
    signoffForm,
    signoffReviewRequired,
    stayOnExportPage,
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
    <>
      <AppPage
        eyebrow={`Reporting year ${year}`}
        title="Export Compliance Report"
        description="Generate a review-ready, evidence-led report for trustee review and filing records. CharityPilot supports workflow preparation; it is not legal advice."
      >
        <ExportControlsPanel
          approvalCurrent={approvalPresentation.approvalCurrent}
          approvalUnavailable={approvalUnavailable}
          exportingApproved={exportingApproved}
          exportingCurrent={exportingCurrent}
          latestApproval={latestApproval}
          onExportApproved={handleExportApproved}
          onExportCurrent={handleExportCurrent}
          onYearChange={requestYearChange}
          readinessBlockerCodes={readinessBlockerCodes}
          readinessBlockerCount={readinessBlockerCount}
          signoffDirty={signoffDirty}
          year={year}
          yearOptions={yearOptions}
        />

        <ApprovalReadinessIssues readiness={approvalReadiness} />

        <ConditionalReviewPrompts items={conditionalReviewItems} />

        <MatrixSourceSummary readiness={approvalReadiness} />

        <ExportBoardApprovalPanel
          approvalCurrent={approvalPresentation.approvalCurrent}
          approvalLabel={approvalPresentation.label}
          approvalSaveBlocked={approvalSaveBlocked}
          approvalTone={approvalPresentation.tone}
          approvalUnavailable={approvalUnavailable}
          onAcknowledgeReview={acknowledgeSignoffReview}
          onDiscardSignoff={discardSignoffChanges}
          onRetryConflictRefresh={retrySignoffConflictRefresh}
          onSaveSignoff={handleSaveSignoff}
          refreshingConflict={loading}
          savingSignoff={savingSignoff}
          setSignoffForm={setSignoffForm}
          signoff={signoff}
          signoffConflictRefreshFailed={signoffConflictRefreshFailed}
          signoffDirty={signoffDirty}
          signoffError={signoffError}
          signoffForm={signoffForm}
          signoffReviewRequired={signoffReviewRequired}
          signoffSaveStatus={displayedSignoffSaveState}
          signoffStatusLabels={signoffStatusLabels}
        />

        <ExportReportPreview
          loading={loading}
          summary={summary}
          signoffLabel={approvalPresentation.label}
          signoffChipColor={approvalPresentation.tone}
        />

        <ReviewWarningState
          title="Before exporting"
          description="Make sure all compliance records are up to date, the organisation profile is complete, and trustees have reviewed the annual position. Internal notes are excluded from the exported report. Use your browser's Print to PDF option to save a copy."
        />
      </AppPage>
      <ExportNavigationConfirmModal
        isOpen={navigationConfirmOpen}
        onKeepEditing={stayOnExportPage}
        onDiscardAndLeave={discardSignoffAndContinueNavigation}
      />
    </>
  );
}
