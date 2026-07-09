'use client';

import { logClientError } from '@/lib/client-logger';
import { api } from '@/lib/api';
import {
  approvalReadinessBlockerCodes,
  countApprovalReadinessBlockers,
} from '@/lib/approval-readiness';
import { useToast } from '@/components/toast';
import { useCallback, useEffect, useState } from 'react';
import type { ComplianceApprovalReadinessResponse, ComplianceSignoffResponse, ComplianceSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';
import type { ExportSignoffForm } from './export-board-approval-panel';

const toDateInput = (value: string | null | undefined) => value?.slice(0, 10) ?? '';

const approvalIncompleteMessage =
  'Resolve Compliance Record readiness blockers before board approval. Missing records, evidence fields, explanations, and organisation profile checks must be completed first.';

const apiErrorCode = (error: unknown) =>
  (error as { response?: { data?: { code?: string } } })?.response?.data?.code;

type ApprovalReadiness = ComplianceApprovalReadinessResponse;

export function useExportWorkflow() {
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [signoff, setSignoff] = useState<ComplianceSignoffResponse | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [signoffForm, setSignoffForm] = useState<ExportSignoffForm>({
    status: ComplianceSignoffStatus.DRAFT,
    boardMeetingDate: '',
    minuteReference: '',
    approvedByName: '',
    approvedByRole: '',
    approvalNotes: '',
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [savingSignoff, setSavingSignoff] = useState(false);
  const [signoffError, setSignoffError] = useState('');
  const [exporting, setExporting] = useState(false);

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
    setLoadError('');
    try {
      const [summaryRes, signoffRes] = await Promise.all([
        api.get(`/compliance/summary?year=${year}`),
        api.get(`/compliance/signoff?year=${year}`),
      ]);
      const nextSummary = summaryRes.data as ComplianceSummary | null;
      const nextSignoff = signoffRes.data as ComplianceSignoffResponse | null;
      if (!nextSummary || !nextSignoff) {
        throw new Error('Export data response missing summary or sign-off payload');
      }
      await fetchApprovalReadiness();
      setSummary(nextSummary);
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
      setLoadError('');
    } catch (err) {
      logClientError('Failed to load compliance summary', err);
      setSummary(null);
      setSignoff(null);
      setApprovalReadiness(null);
      setLoadError('Could not load export data for this reporting year. Try again before generating or approving the report.');
    } finally {
      setLoading(false);
    }
  }, [fetchApprovalReadiness, year]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

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

  const signoffChipColor: 'success' | 'warning' | 'default' =
    signoffForm.status === ComplianceSignoffStatus.APPROVED
      ? 'success'
      : signoffForm.status === ComplianceSignoffStatus.BOARD_REVIEW
        ? 'warning'
        : 'default';
  const conditionalReviewItems = approvalReadiness?.conditionalReviewItems ?? [];
  const readinessBlockerCount = countApprovalReadinessBlockers(approvalReadiness);
  const readinessBlockerCodes = approvalReadinessBlockerCodes(approvalReadiness);

  return {
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
  };
}
