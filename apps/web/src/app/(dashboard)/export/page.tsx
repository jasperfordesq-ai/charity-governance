'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Button, Select, SelectItem, Input, Textarea, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ReviewWarningState } from '@/components/ui/states';
import type { ComplianceApprovalReadinessResponse, ComplianceSignoffResponse, ComplianceSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus, GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';

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
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
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
          <div role="alert" className="mt-4 rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {signoffError}
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

      {/* Preview of what will be included */}
      <AppSection
        title="Report Preview"
        description="The exported report will include the following sections:"
      >

        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5 animate-pulse bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
                <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/3 mb-3" />
                <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-2/3" />
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Organisation details section */}
            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Organisation Details</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Name, RCN, legal form, complexity, charitable purpose, contact details.
              </p>
            </Card>

            {/* Overall compliance score */}
            {summary && (
              <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-2">
                  <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
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
            )}

            {/* Per-principle breakdown */}
            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
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
                      className="flex items-center justify-between text-sm py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono font-bold text-gray-500 dark:text-gray-400 w-4">
                          {p.number}
                        </span>
                        <span className="text-gray-700 dark:text-gray-300 truncate">{p.title}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs font-medium ${scoreColour(pct)}`}>
                          {scoreLabel(pct)}
                        </span>
                        <span className={`text-sm font-semibold ${scoreColour(pct)}`}>
                          {Math.round(pct)}%
                        </span>
                        {pSummary && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            ({pSummary.compliant}/{pSummary.totalApplicable})
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Standard details */}
            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Detailed Standard Responses</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Each standard with its compliance status, action taken, and evidence. Internal notes are excluded from the export.
              </p>
            </Card>

            {/* Board register */}
            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Board Members Register</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Active board members with roles, appointment dates, conduct signed status, and induction status.
              </p>
            </Card>

            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75l2.25 2.25L15 9.75M12 3.75l7.5 3v5.25c0 4.2-2.987 8.137-7.5 9.375-4.513-1.238-7.5-5.175-7.5-9.375V6.75l7.5-3z" />
                    </svg>
                    <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Board Approval Record</h3>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Approval status, board meeting date, minute reference, approver, and any sign-off notes.
                  </p>
                </div>
                <Chip size="sm" color={signoffChipColor} variant="flat">
                  {signoffStatusLabels[signoffForm.status]}
                </Chip>
              </div>
            </Card>

            {/* Document list */}
            <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-teal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Supporting Documents</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                List of uploaded documents with their categories and linked standards.
              </p>
            </Card>
          </div>
        )}
      </AppSection>

      {/* Additional info */}
      <Card className="border border-amber-200 dark:border-amber-500/20 bg-amber-50/50 dark:bg-amber-500/10 p-5">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-500 dark:text-amber-300 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Before exporting</p>
            <p className="text-xs text-amber-700 dark:text-amber-200/90 mt-0.5">
              Make sure all your compliance records are up to date and your organisation profile is complete.
              Record board approval once the trustees have reviewed the annual position.
              Internal notes (marked as such in the editor) will not be included in the exported report.
              The report is formatted for printing -- use your browser&apos;s &quot;Print to PDF&quot; option to save a copy.
            </p>
          </div>
        </div>
      </Card>
    </AppPage>
  );
}
