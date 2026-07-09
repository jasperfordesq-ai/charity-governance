'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable } from '@/lib/plan-feature';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiNotFoundError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { buildRegisterPriorities, buildRegisterSearchText } from './register-priority-panel';
import { normalizeRegisterForm, type RegisterType } from './register-record-forms';
import { riskScore } from './register-record-lists';
import {
  AnnualReportFilingStatus,
  ConflictStatus,
  RegisterStatus,
  RiskCategory,
  type AnnualReportReadinessResponse,
  type ComplaintRecordResponse,
  type ConflictRecordResponse,
  type FinancialControlReviewResponse,
  type FundraisingRecordResponse,
  type GovernanceRegistersSummary,
  type OrganisationResponse,
  type RiskRecordResponse,
} from '@charitypilot/shared';

const emptyAnnual = (year: number): AnnualReportReadinessResponse => ({
  id: null,
  organisationId: '',
  reportingYear: year,
  activitiesNarrative: null,
  publicBenefitStatement: null,
  beneficiariesSummary: null,
  financialStatementsApproved: false,
  annualReportUploaded: false,
  trusteeDetailsReviewed: false,
  fundraisingReviewed: false,
  complaintsReviewed: false,
  boardApprovalDate: null,
  filingStatus: AnnualReportFilingStatus.NOT_STARTED,
  filedDate: null,
  notes: null,
  updatedAt: null,
});

const emptyFinancial = (year: number): FinancialControlReviewResponse => ({
  id: null,
  organisationId: '',
  reportingYear: year,
  bankReconciliationsReviewed: false,
  dualAuthorisation: false,
  budgetApproved: false,
  managementAccountsReviewed: false,
  reservesReviewed: false,
  restrictedFundsReviewed: false,
  assetsInsuranceReviewed: false,
  payrollControlsReviewed: false,
  fundraisingControlsReviewed: false,
  reviewedBy: null,
  reviewDate: null,
  minuteReference: null,
  actions: null,
  updatedAt: null,
});

export function useRegistersWorkflow() {
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const registersRequestSeq = useRef(0);
  const latestYearRef = useRef(currentYear);
  const [year, setYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [closingRecordId, setClosingRecordId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [planUnavailable, setPlanUnavailable] = useState(false);
  const [organisation, setOrganisation] = useState<OrganisationResponse | null>(null);
  const [organisationProfileError, setOrganisationProfileError] = useState('');
  const [summary, setSummary] = useState<GovernanceRegistersSummary | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRecordResponse[]>([]);
  const [risks, setRisks] = useState<RiskRecordResponse[]>([]);
  const [complaints, setComplaints] = useState<ComplaintRecordResponse[]>([]);
  const [fundraising, setFundraising] = useState<FundraisingRecordResponse[]>([]);
  const [annual, setAnnual] = useState<AnnualReportReadinessResponse>(emptyAnnual(currentYear));
  const [financial, setFinancial] = useState<FinancialControlReviewResponse>(emptyFinancial(currentYear));
  const [loadedRegistersYear, setLoadedRegistersYear] = useState<number | null>(null);
  const [modalType, setModalType] = useState<RegisterType | null>(null);
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});

  const isLatestRegistersRequest = useCallback((requestSeq: number) => requestSeq === registersRequestSeq.current, []);

  const fetchRegisters = useCallback(async (requestedYear = latestYearRef.current) => {
    const requestSeq = ++registersRequestSeq.current;
    setLoading(true);
    setPlanUnavailable(false);
    setLoadError('');
    setLoadedRegistersYear(null);
    try {
      const [summaryRes, conflictsRes, risksRes, complaintsRes, fundraisingRes, annualRes, financialRes] = await Promise.all([
        api.get(`/governance-registers/summary?year=${requestedYear}`),
        api.get('/governance-registers/conflicts'),
        api.get('/governance-registers/risks'),
        api.get('/governance-registers/complaints'),
        api.get('/governance-registers/fundraising'),
        api.get(`/governance-registers/annual-report?year=${requestedYear}`),
        api.get(`/governance-registers/financial-controls?year=${requestedYear}`),
      ]);
      if (!isLatestRegistersRequest(requestSeq)) return;
      setSummary(summaryRes.data);
      setConflicts(conflictsRes.data ?? []);
      setRisks(risksRes.data ?? []);
      setComplaints(complaintsRes.data ?? []);
      setFundraising(fundraisingRes.data ?? []);
      setAnnual(annualRes.data ?? emptyAnnual(requestedYear));
      setFinancial(financialRes.data ?? emptyFinancial(requestedYear));
      setLoadedRegistersYear(requestedYear);
    } catch (err) {
      if (isPlanFeatureUnavailable(err)) {
        if (!isLatestRegistersRequest(requestSeq)) return;
        setLoadedRegistersYear(null);
        setPlanUnavailable(true);
        setSummary(null);
        setConflicts([]);
        setRisks([]);
        setComplaints([]);
        setFundraising([]);
        setAnnual(emptyAnnual(requestedYear));
        setFinancial(emptyFinancial(requestedYear));
        return;
      }
      if (!isLatestRegistersRequest(requestSeq)) return;
      setLoadedRegistersYear(null);
      setSummary(null);
      setConflicts([]);
      setRisks([]);
      setComplaints([]);
      setFundraising([]);
      setAnnual(emptyAnnual(requestedYear));
      setFinancial(emptyFinancial(requestedYear));
      logClientError('Failed to load governance registers', err);
      setLoadError('Governance registers could not be loaded. Please try again.');
      toast('Failed to load governance registers', 'error');
    } finally {
      if (isLatestRegistersRequest(requestSeq)) {
        setLoading(false);
      }
    }
  }, [isLatestRegistersRequest, toast]);

  const fetchOrganisationProfile = useCallback(async () => {
    setOrganisationProfileError('');
    try {
      const res = await api.get('/organisation');
      setOrganisation(res.data?.data ?? res.data ?? null);
    } catch (err) {
      if (isApiNotFoundError(err)) {
        setOrganisation(null);
        return;
      }
      const message = apiErrorMessage(err, 'Organisation profile could not be loaded for register priorities.');
      logClientError('Failed to load organisation profile for register priorities', err);
      setOrganisationProfileError(message);
    }
  }, []);

  useEffect(() => {
    latestYearRef.current = year;
    fetchRegisters(year);
    fetchOrganisationProfile();
  }, [fetchOrganisationProfile, fetchRegisters, year]);

  const hasLoadedSelectedYear = loadedRegistersYear === year && !loadError;
  const canSaveAnnual = hasLoadedSelectedYear && annual.reportingYear === year;
  const canSaveFinancial = hasLoadedSelectedYear && financial.reportingYear === year;

  const openModal = (type: RegisterType) => {
    setModalType(type);
    setFormError('');
    if (type === 'conflict') {
      setForm({
        trusteeName: '',
        matter: '',
        nature: '',
        dateDeclared: new Date().toISOString().slice(0, 10),
        meetingDate: '',
        actionTaken: '',
        decision: '',
        status: ConflictStatus.DECLARED,
        minuteReference: '',
        nextReviewDate: '',
      });
    }
    if (type === 'risk') {
      setForm({
        title: '',
        category: RiskCategory.GOVERNANCE,
        description: '',
        likelihood: 3,
        impact: 3,
        mitigation: '',
        owner: '',
        reviewDate: '',
        status: RegisterStatus.OPEN,
        boardMinuteReference: '',
      });
    }
    if (type === 'complaint') {
      setForm({
        receivedDate: new Date().toISOString().slice(0, 10),
        source: '',
        summary: '',
        actionTaken: '',
        outcome: '',
        status: RegisterStatus.OPEN,
        reviewedByBoard: false,
        boardMinuteReference: '',
      });
    }
    if (type === 'fundraising') {
      setForm({
        name: '',
        activityType: '',
        startDate: '',
        endDate: '',
        publicFacing: true,
        thirdPartyFundraiser: '',
        controls: '',
        complaintsReceived: false,
        reviewOutcome: '',
        status: RegisterStatus.OPEN,
        boardMinuteReference: '',
      });
    }
  };

  const updateForm = (key: string, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const closeModal = () => {
    setModalType(null);
    setForm({});
    setFormError('');
  };

  const formDisabledReason = useMemo(() => {
    if (!modalType) return '';
    if (modalType === 'conflict') {
      if (!String(form.trusteeName ?? '').trim()) return 'Add the trustee or connected person before saving.';
      if (!String(form.matter ?? '').trim()) return 'Add the matter before saving.';
      if (!String(form.nature ?? '').trim()) return 'Add the nature of the conflict before saving.';
      if (!String(form.actionTaken ?? '').trim()) return 'Record the action taken before saving.';
    }
    if (modalType === 'risk') {
      if (!String(form.title ?? '').trim()) return 'Add a risk title before saving.';
      if (!String(form.description ?? '').trim()) return 'Add a short risk description before saving.';
      if (!String(form.mitigation ?? '').trim()) return 'Record the mitigation or controls before saving.';
    }
    if (modalType === 'complaint' && !String(form.summary ?? '').trim()) {
      return 'Add a complaint summary before saving.';
    }
    if (modalType === 'fundraising') {
      if (!String(form.name ?? '').trim()) return 'Add the fundraising activity name before saving.';
      if (!String(form.activityType ?? '').trim()) return 'Add the activity type before saving.';
    }
    return '';
  }, [form, modalType]);

  const handleCreate = async () => {
    if (!modalType) return;
    if (formDisabledReason) {
      setFormError(formDisabledReason);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      const endpoint = {
        conflict: '/governance-registers/conflicts',
        risk: '/governance-registers/risks',
        complaint: '/governance-registers/complaints',
        fundraising: '/governance-registers/fundraising',
      }[modalType];
      await api.post(endpoint, normalizeRegisterForm(form));
      closeModal();
      await fetchRegisters();
      toast('Register record added');
    } catch (err) {
      logClientError('Failed to save register record', err);
      setFormError('Register record could not be saved. Please review the fields and try again.');
      toast('Failed to save register record', 'error');
    } finally {
      setSaving(false);
    }
  };

  const closeRecord = async (type: RegisterType, id: string) => {
    const endpoint = {
      conflict: `/governance-registers/conflicts/${id}`,
      risk: `/governance-registers/risks/${id}`,
      complaint: `/governance-registers/complaints/${id}`,
      fundraising: `/governance-registers/fundraising/${id}`,
    }[type];
    const status = type === 'conflict' ? ConflictStatus.CLOSED : RegisterStatus.CLOSED;
    setClosingRecordId(id);
    try {
      await api.patch(endpoint, { status });
      await fetchRegisters();
      toast('Register record closed');
    } catch (err) {
      logClientError('Failed to close register record', err);
      toast('Failed to close record', 'error');
    } finally {
      setClosingRecordId(null);
    }
  };

  const saveAnnual = async () => {
    if (!canSaveAnnual) {
      toast('Refresh this reporting year before saving Annual Report readiness.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.put('/governance-registers/annual-report', {
        ...annual,
        reportingYear: year,
      });
      await fetchRegisters();
      toast('Annual Report readiness saved');
    } catch (err) {
      logClientError('Failed to save Annual Report readiness', err);
      toast('Failed to save Annual Report readiness', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveFinancial = async () => {
    if (!canSaveFinancial) {
      toast('Refresh this reporting year before saving financial controls.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.put('/governance-registers/financial-controls', {
        ...financial,
        reportingYear: year,
      });
      await fetchRegisters();
      toast('Financial controls review saved');
    } catch (err) {
      logClientError('Failed to save financial controls review', err);
      toast('Failed to save financial controls review', 'error');
    } finally {
      setSaving(false);
    }
  };

  const summaryForSelectedYear = hasLoadedSelectedYear ? summary : null;
  const conflictsForSelectedYear = useMemo(
    () => (hasLoadedSelectedYear ? conflicts : []),
    [conflicts, hasLoadedSelectedYear],
  );
  const risksForSelectedYear = useMemo(
    () => (hasLoadedSelectedYear ? risks : []),
    [hasLoadedSelectedYear, risks],
  );
  const complaintsForSelectedYear = useMemo(
    () => (hasLoadedSelectedYear ? complaints : []),
    [complaints, hasLoadedSelectedYear],
  );
  const fundraisingForSelectedYear = useMemo(
    () => (hasLoadedSelectedYear ? fundraising : []),
    [fundraising, hasLoadedSelectedYear],
  );
  const highRisks = risksForSelectedYear.filter((risk) => risk.status !== RegisterStatus.CLOSED && riskScore(risk) >= 12);
  const openRegisterCount =
    (summaryForSelectedYear?.openConflicts ?? 0) +
    (summaryForSelectedYear?.openRisks ?? 0) +
    (summaryForSelectedYear?.openComplaints ?? 0) +
    fundraisingForSelectedYear.filter((item) => item.status !== RegisterStatus.CLOSED).length;
  const conditionalProfile = organisation?.conditionalObligationProfile ?? null;
  const registerSearchText = useMemo(() => {
    return buildRegisterSearchText({
      conflicts: conflictsForSelectedYear,
      risks: risksForSelectedYear,
      complaints: complaintsForSelectedYear,
      fundraising: fundraisingForSelectedYear,
      annual,
      financial,
    });
  }, [
    annual,
    complaintsForSelectedYear,
    conflictsForSelectedYear,
    financial,
    fundraisingForSelectedYear,
    risksForSelectedYear,
  ]);
  const conditionalRegisterPriorities = useMemo(() => {
    return buildRegisterPriorities(organisation?.conditionalObligationProfile, registerSearchText);
  }, [organisation?.conditionalObligationProfile, registerSearchText]);
  const missingConditionalRegisterCount = conditionalRegisterPriorities.filter((item) => !item.registerEvidenceTracked).length;
  const registerSaveStatus: 'idle' | 'saving' | 'saved' | 'error' = saving || closingRecordId ? 'saving' : 'idle';

  return {
    annual,
    canSaveAnnual,
    canSaveFinancial,
    closeModal,
    closeRecord,
    closingRecordId,
    complaintsForSelectedYear,
    conditionalProfile,
    conditionalRegisterPriorities,
    conflictsForSelectedYear,
    currentYear,
    fetchOrganisationProfile,
    fetchRegisters,
    financial,
    form,
    formDisabledReason,
    formError,
    fundraisingForSelectedYear,
    handleCreate,
    hasLoadedSelectedYear,
    highRisks,
    loadError,
    loading,
    missingConditionalRegisterCount,
    modalType,
    openModal,
    openRegisterCount,
    organisationProfileError,
    planUnavailable,
    registerSaveStatus,
    risksForSelectedYear,
    saveAnnual,
    saveFinancial,
    saving,
    setAnnual,
    setFinancial,
    setYear,
    summaryForSelectedYear,
    updateForm,
    year,
  };
}
