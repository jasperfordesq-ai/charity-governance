'use client';

import { logClientError } from '@/lib/client-logger';
import { api } from '@/lib/api';
import {
  approvalReadinessBlockerCodes,
  countApprovalReadinessBlockers,
} from '@/lib/approval-readiness';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
import { openAuthenticatedReport } from '@/lib/authenticated-report-open';
import { isApiForbiddenError } from '@/lib/errors';
import { canManageGovernance } from '@/lib/governance-permissions';
import {
  complianceSignoffToDraft,
  isCurrentSignoffDraftGeneration,
  isComplianceSignoffDirty,
  persistedApprovalPresentation,
} from '@/lib/compliance-approval-ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ComplianceApprovalReadinessResponse, ComplianceSignoffResponse, ComplianceSummary } from '@charitypilot/shared';
import { ComplianceSignoffStatus } from '@charitypilot/shared';
import type { ExportSignoffForm } from './export-board-approval-panel';

const approvalIncompleteMessage =
  'Resolve Compliance Record readiness blockers before board approval. Missing records, evidence fields, explanations, and organisation profile checks must be completed first.';
const approvalUnavailableMessage =
  'Approval readiness could not be verified. Reload the latest evidence before recording board approval.';

type ReadinessState = 'loading' | 'available' | 'unavailable';
type SignoffSaveState = 'idle' | 'saving' | 'saved' | 'error';
type ExportVersion = 'current' | 'approved';

const apiErrorCode = (error: unknown) =>
  (error as { response?: { data?: { code?: string } } })?.response?.data?.code;

type ApprovalReadiness = ComplianceApprovalReadinessResponse;

export function useExportWorkflow() {
  const { toast } = useToast();
  const router = useRouter();
  const { user, refreshUser } = useAuth();
  const roleCanManageSignoff = canManageGovernance(user?.role);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [signoff, setSignoff] = useState<ComplianceSignoffResponse | null>(null);
  const [approvalReadiness, setApprovalReadiness] = useState<ApprovalReadiness | null>(null);
  const [readinessState, setReadinessState] = useState<ReadinessState>('loading');
  const initialSignoffForm = complianceSignoffToDraft(null);
  const [signoffForm, setSignoffFormState] = useState<ExportSignoffForm>(initialSignoffForm);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [savingSignoff, setSavingSignoff] = useState(false);
  const [signoffSaveState, setSignoffSaveState] = useState<SignoffSaveState>('idle');
  const [signoffError, setSignoffError] = useState('');
  const [signoffReviewRequired, setSignoffReviewRequired] = useState(false);
  const [signoffConflictRefreshFailed, setSignoffConflictRefreshFailed] = useState(false);
  const [navigationConfirmOpen, setNavigationConfirmOpen] = useState(false);
  const [pendingNavigationHref, setPendingNavigationHref] = useState('/dashboard');
  const [exportingVersion, setExportingVersion] = useState<ExportVersion | null>(null);
  const [signoffEditingRevoked, setSignoffEditingRevoked] = useState(false);
  const canManageSignoff = roleCanManageSignoff && !signoffEditingRevoked;
  const loadRequestSeq = useRef(0);
  const signoffSaveInFlight = useRef(false);
  const exportInFlight = useRef(false);
  const canManageSignoffRef = useRef(canManageSignoff);
  const signoffRef = useRef<ComplianceSignoffResponse | null>(signoff);
  const signoffFormRef = useRef<ExportSignoffForm>(initialSignoffForm);
  const signoffDraftGeneration = useRef(0);

  useLayoutEffect(() => {
    canManageSignoffRef.current = canManageSignoff;
    signoffRef.current = signoff;
  }, [canManageSignoff, signoff]);

  const replaceSignoffForm = useCallback((nextForm: ExportSignoffForm) => {
    signoffFormRef.current = nextForm;
    signoffDraftGeneration.current += 1;
    setSignoffFormState(nextForm);
  }, []);

  const setSignoffForm = useCallback<Dispatch<SetStateAction<ExportSignoffForm>>>((update) => {
    if (!canManageSignoff) return;
    const currentForm = signoffFormRef.current;
    const nextForm = typeof update === 'function'
      ? (update as (previous: ExportSignoffForm) => ExportSignoffForm)(currentForm)
      : update;
    signoffFormRef.current = nextForm;
    signoffDraftGeneration.current += 1;
    setSignoffFormState(nextForm);
  }, [canManageSignoff]);

  const clearPrivilegedSignoffState = useCallback(() => {
    replaceSignoffForm(complianceSignoffToDraft(signoffRef.current));
    setSignoffError('');
    setSignoffSaveState('idle');
    setSignoffReviewRequired(false);
    setSignoffConflictRefreshFailed(false);
    setNavigationConfirmOpen(false);
  }, [replaceSignoffForm]);

  const failClosedOnForbidden = useCallback((error: unknown): boolean => {
    if (!isApiForbiddenError(error)) return false;

    // The API is authoritative. Drop all local sign-off editing state before
    // the auth refresh resolves so a stale Admin/Owner render cannot retry.
    canManageSignoffRef.current = false;
    setSignoffEditingRevoked(true);
    clearPrivilegedSignoffState();
    void refreshUser();
    return true;
  }, [clearPrivilegedSignoffState, refreshUser]);

  useEffect(() => {
    if (canManageSignoff) return;
    clearPrivilegedSignoffState();
  }, [canManageSignoff, clearPrivilegedSignoffState]);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const loadExportState = useCallback(async (preserveForm: boolean) => {
    const requestSeq = ++loadRequestSeq.current;
    setLoading(true);
    setLoadError('');
    if (!preserveForm) setReadinessState('loading');
    try {
      const [summaryResult, signoffResult, readinessResult] = await Promise.allSettled([
        api.get(`/compliance/summary?year=${year}`),
        api.get(`/compliance/signoff?year=${year}`),
        api.get(`/compliance/approval-readiness?year=${year}`),
      ]);
      if (requestSeq !== loadRequestSeq.current) return false;
      if (summaryResult.status === 'rejected') throw summaryResult.reason;
      if (signoffResult.status === 'rejected') throw signoffResult.reason;

      const summaryRes = summaryResult.value;
      const signoffRes = signoffResult.value;
      const nextSummary = summaryRes.data as ComplianceSummary | null;
      const nextSignoff = signoffRes.data as ComplianceSignoffResponse | null;
      if (!nextSummary || !nextSignoff) {
        throw new Error('Export data response missing summary or sign-off payload');
      }

      setSummary(nextSummary);
      setSignoff(nextSignoff);
      if (readinessResult.status === 'fulfilled' && readinessResult.value.data) {
        setApprovalReadiness(readinessResult.value.data as ApprovalReadiness);
        setReadinessState('available');
      } else {
        if (readinessResult.status === 'rejected') {
          logClientError('Failed to load approval readiness', readinessResult.reason);
          failClosedOnForbidden(readinessResult.reason);
        }
        setApprovalReadiness(null);
        setReadinessState('unavailable');
      }

      if (!preserveForm) {
        replaceSignoffForm(complianceSignoffToDraft(nextSignoff));
        setSignoffError('');
        setSignoffSaveState('idle');
        setSignoffReviewRequired(false);
        setSignoffConflictRefreshFailed(false);
      }
      setLoadError('');
      return true;
    } catch (err) {
      if (requestSeq !== loadRequestSeq.current) return false;
      failClosedOnForbidden(err);
      logClientError('Failed to load compliance summary', err);
      if (!preserveForm) {
        setSummary(null);
        setSignoff(null);
        setLoadError('Could not load export data for this reporting year. Try again before generating or approving the report.');
      }
      setApprovalReadiness(null);
      setReadinessState('unavailable');
      return false;
    } finally {
      if (requestSeq === loadRequestSeq.current) setLoading(false);
    }
  }, [failClosedOnForbidden, replaceSignoffForm, year]);

  const fetchSummary = useCallback(async () => loadExportState(false), [loadExportState]);

  const fetchApprovalReadiness = useCallback(async (): Promise<ApprovalReadiness | null> => {
    try {
      const readinessRes = await api.get(`/compliance/approval-readiness?year=${year}`);
      const nextReadiness = readinessRes.data as ApprovalReadiness | null;
      if (!nextReadiness) throw new Error('Approval readiness response was empty');
      setApprovalReadiness(nextReadiness);
      setReadinessState('available');
      return nextReadiness;
    } catch (readinessErr) {
      logClientError('Failed to load approval readiness', readinessErr);
      failClosedOnForbidden(readinessErr);
      setApprovalReadiness(null);
      setReadinessState('unavailable');
      return null;
    }
  }, [failClosedOnForbidden, year]);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const handleSaveSignoff = async () => {
    if (!canManageSignoffRef.current) {
      clearPrivilegedSignoffState();
      return;
    }
    if (signoffSaveInFlight.current) return;
    setSignoffError('');

    const submittedSignoff = signoff;
    const submittedForm = signoffFormRef.current;
    const submittedGeneration = signoffDraftGeneration.current;

    if (!submittedSignoff) {
      setSignoffSaveState('error');
      setSignoffError('Reload the current sign-off before saving changes.');
      return;
    }

    if (signoffReviewRequired) {
      setSignoffSaveState('error');
      setSignoffError('Review the refreshed sign-off and evidence position before trying to save again.');
      return;
    }

    if (
      submittedForm.status === ComplianceSignoffStatus.APPROVED &&
      (!submittedForm.boardMeetingDate || !submittedForm.minuteReference.trim() || !submittedForm.approvedByName.trim())
    ) {
      setSignoffError('Board meeting date, minute reference, and approver name are required before marking the record as approved.');
      return;
    }

    signoffSaveInFlight.current = true;
    setSavingSignoff(true);
    setSignoffSaveState('saving');
    try {
      let freshApprovalReadiness: ApprovalReadiness | null = approvalReadiness;
      if (submittedForm.status === ComplianceSignoffStatus.APPROVED) {
        freshApprovalReadiness = await fetchApprovalReadiness();
        if (!freshApprovalReadiness) {
          setSignoffSaveState('error');
          setSignoffError(approvalUnavailableMessage);
          return;
        }
        if (freshApprovalReadiness?.ready === false) {
          setSignoffSaveState('error');
          setSignoffError(approvalIncompleteMessage);
          return;
        }
      }

      if (!canManageSignoffRef.current) {
        clearPrivilegedSignoffState();
        return;
      }

      const res = await api.put('/compliance/signoff', {
        reportingYear: year,
        expectedRevision: submittedSignoff.revision,
        ...(submittedForm.status === ComplianceSignoffStatus.APPROVED
          ? { expectedEvidenceHash: freshApprovalReadiness?.evidenceHash }
          : {}),
        status: submittedForm.status,
        boardMeetingDate: submittedForm.boardMeetingDate || null,
        minuteReference: submittedForm.minuteReference.trim() || null,
        approvedByName: submittedForm.approvedByName.trim() || null,
        approvedByRole: submittedForm.approvedByRole.trim() || null,
        approvalNotes: submittedForm.approvalNotes.trim() || null,
      });
      if (!canManageSignoffRef.current) {
        clearPrivilegedSignoffState();
        return;
      }
      const savedSignoff = res.data as ComplianceSignoffResponse;
      setSignoff(savedSignoff);
      setSignoffReviewRequired(false);
      setSignoffConflictRefreshFailed(false);
      if (isCurrentSignoffDraftGeneration(submittedGeneration, signoffDraftGeneration.current)) {
        replaceSignoffForm(complianceSignoffToDraft(savedSignoff));
        setSignoffSaveState('saved');
        toast('Board sign-off saved');
      } else {
        setSignoffSaveState('idle');
        toast('Earlier sign-off changes saved. Newer edits remain unsaved.');
      }
    } catch (err) {
      logClientError('Failed to save board sign-off', err);
      if (failClosedOnForbidden(err)) {
        await loadExportState(false);
        return;
      }
      const code = apiErrorCode(err);
      setSignoffSaveState('error');
      if (code === 'COMPLIANCE_APPROVAL_INCOMPLETE') {
        setSignoffError(approvalIncompleteMessage);
        await fetchApprovalReadiness();
        return;
      }

      if (
        code === 'COMPLIANCE_SIGNOFF_REVISION_CONFLICT' ||
        code === 'COMPLIANCE_APPROVAL_EVIDENCE_CHANGED' ||
        code === 'COMPLIANCE_SIGNOFF_REVISION_REQUIRED' ||
        code === 'COMPLIANCE_APPROVAL_EVIDENCE_REQUIRED'
      ) {
        setSignoffReviewRequired(true);
        const refreshed = await loadExportState(true);
        setSignoffConflictRefreshFailed(!refreshed);
        const conflictSubject = code === 'COMPLIANCE_APPROVAL_EVIDENCE_CHANGED'
          ? 'Compliance evidence changed while approval was being recorded. No approval was saved.'
          : 'Another saved sign-off revision is now current.';
        setSignoffError(refreshed
          ? `${conflictSubject} The latest position is loaded and your form is preserved; review it before saving again.`
          : `${conflictSubject} The latest saved position could not be refreshed, so saving remains blocked. Your draft is still preserved; retry when the connection recovers.`);
        return;
      }
      setSignoffError('Could not save the board sign-off record. Please review the fields and try again.');
    } finally {
      signoffSaveInFlight.current = false;
      setSavingSignoff(false);
    }
  };

  const handleExport = async (version: ExportVersion, snapshotId?: string) => {
    if (exportInFlight.current) return;
    if (version === 'approved' && !snapshotId) {
      toast('No retained approved snapshot is available for this reporting year.');
      return;
    }
    exportInFlight.current = true;
    setExportingVersion(version);
    try {
      const result = await openAuthenticatedReport({
        openPopup: () => window.open('', '_blank'),
        fetchReport: async () => {
          const response = await api.get('/export/compliance-report', {
            params: {
              year,
              version,
              ...(snapshotId ? { snapshotId } : {}),
            },
            responseType: 'blob',
          });
          if (!(response.data instanceof Blob)) {
            throw new Error('Compliance report response was not a downloadable document');
          }
          return response.data;
        },
        createObjectUrl: (report) => URL.createObjectURL(report),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        scheduleRevoke: (callback, delayMs) => {
          window.setTimeout(callback, delayMs);
        },
      });

      if (result.status === 'blocked') {
        toast('Could not open the report tab. Please allow pop-ups for CharityPilot and try again.');
      } else if (result.status === 'closed') {
        toast('The report tab was closed before the authenticated report finished loading.');
      } else if (result.status === 'error') {
        logClientError('Export failed', result.error);
        failClosedOnForbidden(result.error);
        toast('The report could not be generated. Please try again.');
      }
    } catch (err) {
      logClientError('Export failed', err);
      failClosedOnForbidden(err);
      toast('The report could not be generated. Please try again.');
    } finally {
      exportInFlight.current = false;
      setExportingVersion(null);
    }
  };

  const signoffDirty = canManageSignoff && isComplianceSignoffDirty(signoff, signoffForm);
  const approvalPresentation = persistedApprovalPresentation(signoff, approvalReadiness);
  const displayedSignoffSaveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' = savingSignoff
    ? 'saving'
    : signoffSaveState === 'error'
      ? 'error'
      : signoffDirty
        ? 'dirty'
        : signoffSaveState;
  const approvalUnavailable = readinessState === 'unavailable';
  const approvalSaveBlocked =
    !canManageSignoff ||
    (signoffForm.status === ComplianceSignoffStatus.APPROVED &&
      (readinessState !== 'available' || approvalReadiness?.ready !== true));
  const conditionalReviewItems = approvalReadiness?.conditionalReviewItems ?? [];
  const readinessBlockerCount = countApprovalReadinessBlockers(approvalReadiness);
  const readinessBlockerCodes = approvalReadinessBlockerCodes(approvalReadiness);

  const requestYearChange = (nextYear: number) => {
    if (nextYear === year) return;
    if (canManageSignoff && (signoffDirty || savingSignoff || signoffReviewRequired)) {
      setSignoffError('Save or discard the unsaved sign-off changes before changing reporting year.');
      return;
    }
    loadRequestSeq.current += 1;
    setLoading(true);
    setLoadError('');
    setReadinessState('loading');
    setSummary(null);
    setSignoff(null);
    setApprovalReadiness(null);
    replaceSignoffForm(complianceSignoffToDraft(null));
    setSignoffSaveState('idle');
    setSignoffConflictRefreshFailed(false);
    setYear(nextYear);
  };

  const discardSignoffChanges = () => {
    if (!canManageSignoff) {
      clearPrivilegedSignoffState();
      return;
    }
    if (!signoff) return;
    replaceSignoffForm(complianceSignoffToDraft(signoff));
    setSignoffError('');
    setSignoffSaveState('idle');
    setSignoffReviewRequired(false);
    setSignoffConflictRefreshFailed(false);
  };

  const acknowledgeSignoffReview = () => {
    if (!canManageSignoff) return;
    if (signoffConflictRefreshFailed) {
      setSignoffError('Load the latest saved position before reviewing and retrying this sign-off.');
      return;
    }
    setSignoffReviewRequired(false);
    setSignoffError('');
    setSignoffSaveState(signoffDirty ? 'idle' : 'saved');
  };

  const retrySignoffConflictRefresh = async () => {
    if (!canManageSignoff) return;
    const refreshed = await loadExportState(true);
    setSignoffConflictRefreshFailed(!refreshed);
    setSignoffError(refreshed
      ? 'The latest saved position is loaded and your draft remains preserved. Review it before saving again.'
      : 'The latest saved position still could not be refreshed. Your draft remains preserved and saving is blocked.');
  };

  const stayOnExportPage = useCallback(() => {
    setNavigationConfirmOpen(false);
  }, []);

  const discardSignoffAndContinueNavigation = useCallback(() => {
    if (signoff) {
      replaceSignoffForm(complianceSignoffToDraft(signoff));
    }
    setSignoffReviewRequired(false);
    setSignoffConflictRefreshFailed(false);
    setSignoffError('');
    setSignoffSaveState('idle');
    setNavigationConfirmOpen(false);
    router.push(pendingNavigationHref);
  }, [pendingNavigationHref, replaceSignoffForm, router, signoff]);

  const signoffNavigationBlocked = canManageSignoff && (signoffDirty || signoffReviewRequired);

  useEffect(() => {
    const interceptSignoffNavigation = (event: MouseEvent) => {
      if (
        !signoffNavigationBlocked ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const anchor = element?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;

      const current = new URL(window.location.href);
      const sameLocation =
        destination.pathname === current.pathname &&
        destination.search === current.search &&
        destination.hash === current.hash;
      const samePageHash =
        destination.pathname === current.pathname &&
        destination.search === current.search &&
        destination.hash.length > 0;
      if (sameLocation || samePageHash) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingNavigationHref(`${destination.pathname}${destination.search}${destination.hash}`);
      setNavigationConfirmOpen(true);
    };

    document.addEventListener('click', interceptSignoffNavigation, true);
    return () => document.removeEventListener('click', interceptSignoffNavigation, true);
  }, [signoffNavigationBlocked]);

  useEffect(() => {
    const warnIfSignoffDirty = (event: BeforeUnloadEvent) => {
      if (!signoffNavigationBlocked) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnIfSignoffDirty);
    return () => window.removeEventListener('beforeunload', warnIfSignoffDirty);
  }, [signoffNavigationBlocked]);

  return {
    acknowledgeSignoffReview,
    approvalReadiness,
    approvalPresentation,
    approvalSaveBlocked,
    approvalUnavailable,
    canManageSignoff,
    conditionalReviewItems,
    discardSignoffChanges,
    displayedSignoffSaveState,
    exportingApproved: exportingVersion === 'approved',
    exportingCurrent: exportingVersion === 'current',
    fetchSummary,
    handleExportApproved: () => handleExport('approved', signoff?.latestApproval?.id),
    handleExportCurrent: () => handleExport('current'),
    handleSaveSignoff,
    latestApproval: signoff?.latestApproval ?? null,
    loading,
    loadError,
    navigationConfirmOpen,
    discardSignoffAndContinueNavigation,
    readinessState,
    readinessBlockerCodes,
    readinessBlockerCount,
    requestYearChange,
    retrySignoffConflictRefresh,
    savingSignoff,
    setSignoffForm,
    signoff,
    signoffDirty,
    signoffConflictRefreshFailed,
    signoffError,
    signoffForm,
    signoffReviewRequired,
    stayOnExportPage,
    summary,
    year,
    yearOptions,
  };
}
