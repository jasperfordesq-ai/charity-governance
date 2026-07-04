'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Button, Select, SelectItem, Input, Textarea, Chip } from '@heroui/react';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { FormAlert } from '@/components/ui/form-alert';
import { ReviewWarningState } from '@/components/ui/states';
import type { ComplianceApprovalReadinessResponse, ComplianceSignoffResponse, ComplianceSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';
import { ExportReportPreview } from './export-report-preview';

const signoffStatusLabels = {
  [ComplianceSignoffStatus.DRAFT]: 'Draft',
  [ComplianceSignoffStatus.BOARD_REVIEW]: 'Ready for board review',
  [ComplianceSignoffStatus.APPROVED]: 'Approved by board',
};

const toDateInput = (value: string | null | undefined) => value?.slice(0, 10) ?? '';

const approvalIncompleteMessage =
  'Resolve Compliance Record readiness blockers before board approval. Missing records, evidence fields, explanations, and organisation profile checks must be completed first.';

const apiErrorCode = (error: unknown) =>
  (error as { response?: { data?: { code?: string } } })?.response?.data?.code;

type ApprovalReadiness = ComplianceApprovalReadinessResponse;

const readable = (value: string) => value.replace(/_/g, ' ').toLowerCase();

function evidenceGapLabel(item: ApprovalReadiness['missingEvidence'][number]) {
  if (item.missingActionTaken && item.missingEvidence) return 'Missing action taken and evidence';
  if (item.missingActionTaken) return 'Missing action taken';
  return 'Missing evidence';
}

export default function ExportPage() {
  useDocumentTitle('Export Report');
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [signoff, setSignoff] = useState<ComplianceSignoffResponse | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [signoffForm, setSignoffForm] = useState({
    status: ComplianceSignoffStatus.DRAFT,
    boardMeetingDate: '',
    minuteReference: '',
    approvedByName: '',
    approvedByRole: '',
    approvalNotes: '',
  });
  const [loading, setLoading] = useState(true);
  const [savingSignoff, setSavingSignoff] = useState(false);
  const [signoffError, setSignoffError] = useState('');

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const fetchApprovalReadiness = useCallback(async (): Promise<ApprovalReadiness | null> => {
    try {
      const readinessRes = await api.get(`/compliance/approval-readiness?year=${year}`);
      setApprovalReadiness(readinessRes.data);
      return readinessRes.data;
    } catch (readinessErr) {
      logClientError('Failed to load approval readiness', readinessErr);
      setApprovalReadiness(null);
      return null;
    }
  }, [year]);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, signoffRes] = await Promise.all([
        api.get(`/compliance/summary?year=${year}`),
        api.get(`/compliance/signoff?year=${year}`),
      ]);
      await fetchApprovalReadiness();
      const nextSignoff = signoffRes.data as ComplianceSignoffResponse;
      setSummary(summaryRes.data);
      setSignoff(nextSignoff);
      setSignoffForm({
        status: nextSignoff.status,
        boardMeetingDate: toDateInput(nextSignoff.boardMeetingDate),
        minuteReference: nextSignoff.minuteReference ?? '',
        approvedByName: nextSignoff.approvedByName ?? '',
        approvedByRole: nextSignoff.approvedByRole ?? '',
        approvalNotes: nextSignoff.approvalNotes ?? '',
      });
      setSignoffError('');
    } catch (err) {
      logClientError('Failed to load compliance summary', err);
    } finally {
      setLoading(false);
    }
  }, [fetchApprovalReadiness, year]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  /* Open the API-rendered report directly so its response CSP is enforced. */
  const [exporting, setExporting] = useState(false);

  const handleSaveSignoff = async () => {
    setSignoffError('');

    if (
      signoffForm.status === ComplianceSignoffStatus.APPROVED &&
      (!signoffForm.boardMeetingDate || !signoffForm.minuteReference.trim() || !signoffForm.approvedByName.trim())
    ) {
      setSignoffError('Board meeting date, minute reference, and approver name are required before marking the record as approved.');
      return;
    }

    setSavingSignoff(true);
    try {
      if (signoffForm.status === ComplianceSignoffStatus.APPROVED) {
        const freshApprovalReadiness = await fetchApprovalReadiness();
        if (freshApprovalReadiness?.ready === false) {
          setSignoffError(approvalIncompleteMessage);
          return;
        }
      }

      const res = await api.put('/compliance/signoff', {
        reportingYear: year,
        status: signoffForm.status,
        boardMeetingDate: signoffForm.boardMeetingDate || null,
        minuteReference: signoffForm.minuteReference.trim() || null,
        approvedByName: signoffForm.approvedByName.trim() || null,
        approvedByRole: signoffForm.approvedByRole.trim() || null,
        approvalNotes: signoffForm.approvalNotes.trim() || null,
      });
      setSignoff(res.data);
      toast('Board sign-off saved');
    } catch (err) {
      logClientError('Failed to save board sign-off', err);
      if (apiErrorCode(err) === 'COMPLIANCE_APPROVAL_INCOMPLETE') {
        setSignoffError(approvalIncompleteMessage);
        await fetchApprovalReadiness();
        return;
      }
      setSignoffError('Could not save the board sign-off record. Please review the fields and try again.');
    } finally {
      setSavingSignoff(false);
    }
  };

  const handleExport = () => {
    setExporting(true);
    try {
      const reportUrl = api.getUri({ url: `/export/compliance-report?year=${year}` });
      const opened = window.open(reportUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        toast('Could not open the report tab. Please allow pop-ups for CharityPilot and try again.');
      }
    } catch (err) {
      logClientError('Export failed', err);
    } finally {
      setExporting(false);
    }
  };

  const signoffChipColor =
    signoffForm.status === ComplianceSignoffStatus.APPROVED
      ? 'success'
      : signoffForm.status === ComplianceSignoffStatus.BOARD_REVIEW
        ? 'warning'
        : 'default';
  const missingRecords = approvalReadiness?.missingRecords ?? [];
  const missingEvidence = approvalReadiness?.missingEvidence ?? [];
  const missingExplanations = approvalReadiness?.missingExplanations ?? [];
  const profileIssues = approvalReadiness?.profileIssues ?? [];
  const conditionalReviewItems = approvalReadiness?.conditionalReviewItems ?? [];
  const readinessBlockerCount =
    missingRecords.length + missingEvidence.length + missingExplanations.length + profileIssues.length;
  const readinessBlockerCodes = [
    ...missingRecords.map((item) => item.standardCode),
    ...missingEvidence.map((item) => item.standardCode),
    ...missingExplanations.map((item) => item.standardCode),
  ];

  return (
    <AppPage
      eyebrow={`Reporting year ${year}`}
      title="Export Compliance Report"
      description="Generate a review-ready, evidence-led report for trustee review and filing records. CharityPilot supports workflow preparation; it is not legal advice."
    >

      {/* Year selector and export button */}
      <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4">
          <Select
            label="Reporting Year"
            selectedKeys={new Set([String(year)])}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              if (val) setYear(Number(val));
            }}
            className="w-48"
          >
            {yearOptions.map((y) => (
              <SelectItem key={String(y)}>{String(y)}</SelectItem>
            ))}
          </Select>

          <Button
            className="bg-teal-primary text-white hover:bg-teal-dark"
            size="lg"
            onPress={handleExport}
            isLoading={exporting}
          >
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

      {readinessBlockerCount > 0 && (
        <AppSection
          title="Approval Readiness"
          description="These checks make missing annual Compliance Record evidence visible before trustees save an approved sign-off."
        >
          <div className="grid gap-3 md:grid-cols-2">
            {missingRecords.map((item) => (
              <Card key={`record-${item.standardId}`} className="border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Standard {item.standardCode}</p>
                <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">No Compliance Record status has been captured for this standard.</p>
              </Card>
            ))}
            {missingEvidence.map((item) => (
              <Card key={`evidence-${item.standardId}`} className="border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Standard {item.standardCode}</p>
                <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">
                  {evidenceGapLabel(item)} for a {readable(item.status)} record.
                </p>
              </Card>
            ))}
            {missingExplanations.map((item) => (
              <Card key={`explanation-${item.standardId}`} className="border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Standard {item.standardCode}</p>
                <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">
                  Add an explanation for the {readable(item.status)} position before board approval.
                </p>
              </Card>
            ))}
            {profileIssues.map((item) => (
              <Card key={item.code} className="border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Organisation profile</p>
                <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">{item.message}</p>
              </Card>
            ))}
          </div>
        </AppSection>
      )}

      {conditionalReviewItems.length > 0 && (
        <AppSection
          title="Conditional Review Prompts"
          description={`Profile facts trigger ${conditionalReviewItems.length} specialist review prompt${conditionalReviewItems.length === 1 ? '' : 's'}. These are source-cited workflow prompts, not legal conclusions.`}
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {conditionalReviewItems.map((item) => (
              <Card key={item.profileKey} className="border border-teal-200 dark:border-teal-500/20 bg-teal-50 dark:bg-teal-500/10 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-teal-950 dark:text-teal-100">{item.label}</h3>
                  <Chip size="sm" variant="flat" color="warning">Professional review</Chip>
                </div>
                <p className="mt-2 text-xs leading-5 text-teal-900 dark:text-teal-100/90">{item.recommendedAction}</p>
                <p className="mt-2 text-xs text-teal-800 dark:text-teal-200">
                  Standards {item.standardCodes.join(', ')} · {item.professionalReview.map(readable).join(', ') || 'trustee review'}
                </p>
              </Card>
            ))}
          </div>
        </AppSection>
      )}

      <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Board approval</h2>
              <Chip size="sm" color={signoffChipColor} variant="flat">
                {signoffStatusLabels[signoffForm.status]}
              </Chip>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-400">
              Record the board meeting where trustees approved the annual Compliance Record before reporting the position to the Charities Regulator.
            </p>
            {signoff?.updatedAt && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Last updated {new Date(signoff.updatedAt).toLocaleString('en-IE', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            )}
          </div>
          <Button
            className="bg-teal-primary text-white hover:bg-teal-dark"
            onPress={handleSaveSignoff}
            isLoading={savingSignoff}
          >
            Save sign-off
          </Button>
        </div>

        {signoffError && (
          <div className="mt-4">
            <FormAlert>
              {signoffError}
            </FormAlert>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label="Approval status"
            selectedKeys={new Set([signoffForm.status])}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0] as ComplianceSignoffStatus | undefined;
              if (value) setSignoffForm((prev) => ({ ...prev, status: value }));
            }}
          >
            {Object.entries(signoffStatusLabels).map(([value, label]) => (
              <SelectItem key={value}>{label}</SelectItem>
            ))}
          </Select>
          <Input
            label="Board meeting date"
            type="date"
            value={signoffForm.boardMeetingDate}
            onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, boardMeetingDate: value }))}
          />
          <Input
            label="Minute reference"
            placeholder="e.g. Board minutes 24 Oct 2026, item 6"
            value={signoffForm.minuteReference}
            onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, minuteReference: value }))}
          />
          <Input
            label="Approved by"
            placeholder="Chairperson or authorised trustee"
            value={signoffForm.approvedByName}
            onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvedByName: value }))}
          />
          <Input
            label="Role"
            placeholder="e.g. Chairperson"
            value={signoffForm.approvedByRole}
            onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvedByRole: value }))}
          />
          <Textarea
            label="Approval notes"
            placeholder="Actions agreed, exceptions noted, or follow-up owners."
            value={signoffForm.approvalNotes}
            onValueChange={(value) => setSignoffForm((prev) => ({ ...prev, approvalNotes: value }))}
            minRows={2}
            className="md:col-span-2"
          />
        </div>
      </Card>

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
