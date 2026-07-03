'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable } from '@/lib/plan-feature';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
  Select,
  SelectItem,
  Textarea,
} from '@heroui/react';
import { api } from '@/lib/api';
import { useDocumentTitle } from '@/lib/use-title';
import { useToast } from '@/components/toast';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { DataList, DataListItems } from '@/components/ui/data-list';
import { FieldGroup, FormHint, ValidationSummary } from '@/components/ui/forms';
import { EmptyState, ErrorState, LoadingState, LockedFeatureState } from '@/components/ui/states';
import { EvidenceChip, ReviewFlag, StatusChip } from '@/components/ui/status';
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
  type RiskRecordResponse,
} from '@charitypilot/shared';

type RegisterType = 'conflict' | 'risk' | 'complaint' | 'fundraising';
type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'brand';

const registerStatusLabels = {
  [RegisterStatus.OPEN]: 'Open',
  [RegisterStatus.MONITORING]: 'Monitoring',
  [RegisterStatus.CLOSED]: 'Closed',
};

const conflictStatusLabels = {
  [ConflictStatus.DECLARED]: 'Declared',
  [ConflictStatus.MANAGED]: 'Managed',
  [ConflictStatus.CLOSED]: 'Closed',
};

const riskCategoryLabels = {
  [RiskCategory.GOVERNANCE]: 'Governance',
  [RiskCategory.FINANCIAL]: 'Financial',
  [RiskCategory.OPERATIONAL]: 'Operational',
  [RiskCategory.LEGAL]: 'Legal',
  [RiskCategory.SAFEGUARDING]: 'Safeguarding',
  [RiskCategory.REPUTATIONAL]: 'Reputational',
  [RiskCategory.FUNDRAISING]: 'Fundraising',
  [RiskCategory.DATA_PROTECTION]: 'Data protection',
  [RiskCategory.OTHER]: 'Other',
};

const filingLabels = {
  [AnnualReportFilingStatus.NOT_STARTED]: 'Not started',
  [AnnualReportFilingStatus.IN_PROGRESS]: 'In progress',
  [AnnualReportFilingStatus.BOARD_APPROVED]: 'Board approved',
  [AnnualReportFilingStatus.FILED]: 'Filed',
};

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

const dateInput = (value: string | null | undefined) => value?.slice(0, 10) ?? '';
const niceDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';

const compactValue = (value: string | null | undefined, fallback = 'Not recorded') => value?.trim() || fallback;
const riskScore = (risk: RiskRecordResponse) => risk.likelihood * risk.impact;

export default function RegistersPage() {
  useDocumentTitle('Governance Registers');
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

  useEffect(() => {
    latestYearRef.current = year;
    fetchRegisters(year);
  }, [fetchRegisters, year]);

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
      await api.post(endpoint, normalizeForm(form));
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
  const conflictsForSelectedYear = hasLoadedSelectedYear ? conflicts : [];
  const risksForSelectedYear = hasLoadedSelectedYear ? risks : [];
  const complaintsForSelectedYear = hasLoadedSelectedYear ? complaints : [];
  const fundraisingForSelectedYear = hasLoadedSelectedYear ? fundraising : [];
  const highRisks = risksForSelectedYear.filter((risk) => risk.status !== RegisterStatus.CLOSED && riskScore(risk) >= 12);
  const openRegisterCount =
    (summaryForSelectedYear?.openConflicts ?? 0) +
    (summaryForSelectedYear?.openRisks ?? 0) +
    (summaryForSelectedYear?.openComplaints ?? 0) +
    fundraisingForSelectedYear.filter((item) => item.status !== RegisterStatus.CLOSED).length;
  const registerSavingLabel = saving
    ? 'Saving register record'
    : closingRecordId
      ? 'Closing register record'
      : 'Register records ready';

  if (!loading && planUnavailable) {
    return (
      <AppPage
        eyebrow="Complete plan"
        title="Governance Registers"
        description="Structured conflicts, risks, complaints, fundraising, Annual Report readiness, and financial controls are available on Complete."
      >
        <LockedFeatureState
          variant="page"
          title="Governance registers are available on Complete"
          description="Upgrade when the charity needs dense operational registers, Annual Report readiness, and financial-control review evidence in one place."
          action={(
            <Button as={Link} href="/billing" color="primary" className="bg-teal-primary text-white">
              View billing
            </Button>
          )}
        />
      </AppPage>
    );
  }

  return (
    <AppPage
      eyebrow="Complete plan governance registers"
      title="Governance Registers"
      description="Maintain review-ready operational records for conflicts, risk, complaints, fundraising, Annual Report readiness, and financial controls."
      actions={(
        <Select
          label="Reporting year"
          className="w-44"
          selectedKeys={new Set([String(year)])}
          onSelectionChange={(keys) => {
            const value = Array.from(keys)[0];
            if (value) setYear(Number(value));
          }}
        >
          {Array.from({ length: 5 }, (_, i) => currentYear - i).map((option) => (
            <SelectItem key={String(option)}>{String(option)}</SelectItem>
          ))}
        </Select>
      )}
    >
      <div aria-live="polite" className="sr-only">
        {registerSavingLabel}
      </div>

      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">Review-ready register set</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Scan open governance work before board review.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              The register set keeps operational records separate from legal conclusions. Use source and review flags to decide what needs trustee or professional follow-up.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[34rem]">
            <SummaryTile label="Open records" value={openRegisterCount} tone={openRegisterCount > 0 ? 'warning' : 'success'} />
            <SummaryTile label="High risks" value={highRisks.length} tone={highRisks.length > 0 ? 'danger' : 'success'} />
            <SummaryTile label="Annual Report" value={`${summaryForSelectedYear?.annualReportReadinessPercent ?? 0}%`} tone={(summaryForSelectedYear?.annualReportReadinessPercent ?? 0) >= 80 ? 'success' : 'warning'} />
            <SummaryTile label="Financial controls" value={`${summaryForSelectedYear?.financialControlsPercent ?? 0}%`} tone={(summaryForSelectedYear?.financialControlsPercent ?? 0) >= 80 ? 'success' : 'warning'} />
          </div>
        </div>
      </section>

      {loading ? (
        <LoadingState title="Loading governance registers" description="Checking Complete-plan register records for this reporting year." />
      ) : loadError || !hasLoadedSelectedYear ? (
        <ErrorState
          title="Governance registers could not be loaded"
          description={loadError || 'Governance registers are not loaded for this reporting year. Refresh to try again.'}
          action={(
            <Button size="sm" variant="flat" onPress={() => fetchRegisters()}>
              Try again
            </Button>
          )}
        />
      ) : (
        <>
          <AppSection
            title="Operational registers"
            description="Use each register for one decision trail: what happened, what was done, where the board minute sits, and what needs review next."
          >
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <RegisterSection
                title="Conflicts register"
                description="Declared interests, meeting handling, decisions, and review dates."
                count={conflictsForSelectedYear.length}
                actionLabel="Add conflict"
                onAdd={() => openModal('conflict')}
                emptyTitle="No conflicts recorded"
                emptyDescription="Add declared trustee interests so decisions and minute references stay visible."
              >
                {conflictsForSelectedYear.map((item) => (
                  <RegisterRow
                    key={item.id}
                    title={item.trusteeName}
                    description={item.matter}
                    meta={`Declared ${niceDate(item.dateDeclared)} - Minute ${compactValue(item.minuteReference, 'not linked')}`}
                    chips={(
                      <>
                        <StatusChip tone={item.status === ConflictStatus.CLOSED ? 'success' : 'warning'}>
                          {conflictStatusLabels[item.status]}
                        </StatusChip>
                        <EvidenceChip status={item.minuteReference ? 'ready' : 'partial'}>
                          {item.minuteReference ? 'Minute linked' : 'Minute pending'}
                        </EvidenceChip>
                      </>
                    )}
                    action={item.status !== ConflictStatus.CLOSED ? (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => closeRecord('conflict', item.id)}
                        isLoading={closingRecordId === item.id}
                        isDisabled={Boolean(closingRecordId) || saving}
                      >
                        Close
                      </Button>
                    ) : null}
                  />
                ))}
              </RegisterSection>

              <RegisterSection
                title="Risk register"
                description="Board-level risk, score, mitigation, owner, and review evidence."
                count={risksForSelectedYear.length}
                actionLabel="Add risk"
                onAdd={() => openModal('risk')}
                emptyTitle="No risks recorded"
                emptyDescription="Add key risks so mitigation, owner, and review dates are ready for trustee oversight."
              >
                {risksForSelectedYear.map((item) => (
                  <RegisterRow
                    key={item.id}
                    title={item.title}
                    description={item.mitigation || item.description}
                    meta={`Owner ${compactValue(item.owner, 'not assigned')} - Review ${niceDate(item.reviewDate)}`}
                    chips={(
                      <>
                        <StatusChip tone={riskScore(item) >= 12 ? 'danger' : 'warning'}>Score {riskScore(item)}</StatusChip>
                        <StatusChip tone="neutral">{riskCategoryLabels[item.category]}</StatusChip>
                        <EvidenceChip status={item.boardMinuteReference ? 'ready' : 'review'}>
                          {item.boardMinuteReference ? 'Board minute' : 'Review flag'}
                        </EvidenceChip>
                      </>
                    )}
                    action={item.status !== RegisterStatus.CLOSED ? (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => closeRecord('risk', item.id)}
                        isLoading={closingRecordId === item.id}
                        isDisabled={Boolean(closingRecordId) || saving}
                      >
                        Close
                      </Button>
                    ) : null}
                  />
                ))}
              </RegisterSection>

              <RegisterSection
                title="Complaints register"
                description="Complaints, action taken, outcomes, and board review references."
                count={complaintsForSelectedYear.length}
                actionLabel="Add complaint"
                onAdd={() => openModal('complaint')}
                emptyTitle="No complaints recorded"
                emptyDescription="Record complaints and board review status so improvement actions do not disappear."
              >
                {complaintsForSelectedYear.map((item) => (
                  <RegisterRow
                    key={item.id}
                    title={item.summary}
                    description={item.outcome || item.actionTaken || 'Outcome not recorded yet.'}
                    meta={`Received ${niceDate(item.receivedDate)} - Source ${compactValue(item.source, 'not recorded')}`}
                    chips={(
                      <>
                        <StatusChip tone={item.status === RegisterStatus.CLOSED ? 'success' : 'warning'}>
                          {registerStatusLabels[item.status]}
                        </StatusChip>
                        <EvidenceChip status={item.reviewedByBoard ? 'ready' : 'review'}>
                          {item.reviewedByBoard ? 'Board reviewed' : 'Board review pending'}
                        </EvidenceChip>
                      </>
                    )}
                    action={item.status !== RegisterStatus.CLOSED ? (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => closeRecord('complaint', item.id)}
                        isLoading={closingRecordId === item.id}
                        isDisabled={Boolean(closingRecordId) || saving}
                      >
                        Close
                      </Button>
                    ) : null}
                  />
                ))}
              </RegisterSection>

              <RegisterSection
                title="Fundraising register"
                description="Public fundraising activities, controls, complaints, and review outcomes."
                count={fundraisingForSelectedYear.length}
                actionLabel="Add activity"
                onAdd={() => openModal('fundraising')}
                emptyTitle="No fundraising activities recorded"
                emptyDescription="Add public-facing campaigns, controls, and third-party fundraiser checks where relevant."
              >
                {fundraisingForSelectedYear.map((item) => (
                  <RegisterRow
                    key={item.id}
                    title={item.name}
                    description={item.controls || 'Controls not recorded yet.'}
                    meta={`Review outcome: ${compactValue(item.reviewOutcome, 'pending')}`}
                    chips={(
                      <>
                        <StatusChip tone={item.status === RegisterStatus.CLOSED ? 'success' : 'warning'}>
                          {registerStatusLabels[item.status]}
                        </StatusChip>
                        <StatusChip tone="neutral">{item.activityType}</StatusChip>
                        {item.thirdPartyFundraiser ? <ReviewFlag tone="needs-review">Third party</ReviewFlag> : null}
                        {item.complaintsReceived ? <ReviewFlag tone="needs-review">Complaint linked</ReviewFlag> : null}
                      </>
                    )}
                    action={item.status !== RegisterStatus.CLOSED ? (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => closeRecord('fundraising', item.id)}
                        isLoading={closingRecordId === item.id}
                        isDisabled={Boolean(closingRecordId) || saving}
                      >
                        Close
                      </Button>
                    ) : null}
                  />
                ))}
              </RegisterSection>
            </div>
          </AppSection>

          <AppSection
            title="Annual readiness and controls"
            description="Use these source/review flags as prompts for the board pack. They do not replace trustee judgement or professional review where needed."
          >
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <AnnualReportCard annual={annual} setAnnual={setAnnual} onSave={saveAnnual} saving={saving} saveDisabled={!canSaveAnnual} />
              <FinancialControlsCard financial={financial} setFinancial={setFinancial} onSave={saveFinancial} saving={saving} saveDisabled={!canSaveFinancial} />
            </div>
          </AppSection>
        </>
      )}

      <Modal isOpen={Boolean(modalType)} onOpenChange={(open) => !open && closeModal()} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{modalType ? modalTitle(modalType) : 'Add register record'}</ModalHeader>
          <ModalBody className="gap-5">
            <ValidationSummary errors={formError ? [formError] : []} />
            {modalType === 'conflict' && <ConflictForm form={form} updateForm={updateForm} />}
            {modalType === 'risk' && <RiskForm form={form} updateForm={updateForm} />}
            {modalType === 'complaint' && <ComplaintForm form={form} updateForm={updateForm} />}
            {modalType === 'fundraising' && <FundraisingForm form={form} updateForm={updateForm} />}
            <FormHint id="register-disabled-hint" tone={formDisabledReason ? 'warning' : 'neutral'}>
              {formDisabledReason || 'Saving updates the register after the API confirms the record.'}
            </FormHint>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeModal} isDisabled={saving}>
              Cancel
            </Button>
            <Button
              className="bg-teal-primary text-white hover:bg-teal-dark"
              onPress={handleCreate}
              isLoading={saving}
              isDisabled={Boolean(formDisabledReason) || saving}
              aria-describedby="register-disabled-hint"
            >
              Save record
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AppPage>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  const colour =
    tone === 'success'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'danger'
        ? 'text-rose-700 dark:text-rose-300'
        : tone === 'warning'
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-gray-950 dark:text-gray-50';
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}

function RegisterSection({
  title,
  description,
  actionLabel,
  onAdd,
  count,
  emptyTitle,
  emptyDescription,
  children,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAdd: () => void;
  count: number;
  emptyTitle: string;
  emptyDescription: string;
  children: ReactNode;
}) {
  return (
    <DataList
      title={(
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <StatusChip tone="neutral">{count}</StatusChip>
        </span>
      )}
      description={description}
      actions={(
        <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onAdd}>
          {actionLabel}
        </Button>
      )}
    >
      {count === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <DataListItems divided={false}>
          <div className="space-y-3 p-3">{children}</div>
        </DataListItems>
      )}
    </DataList>
  );
}

function RegisterRow({
  title,
  description,
  meta,
  chips,
  action,
}: {
  title: ReactNode;
  description: ReactNode;
  meta: ReactNode;
  chips: ReactNode;
  action: ReactNode;
}) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold text-gray-950 dark:text-gray-50">{title}</h3>
            {chips}
          </div>
          <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{description}</p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{meta}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </article>
  );
}

function AnnualReportCard({
  annual,
  setAnnual,
  onSave,
  saving,
  saveDisabled,
}: {
  annual: AnnualReportReadinessResponse;
  setAnnual: (value: AnnualReportReadinessResponse) => void;
  onSave: () => void;
  saving: boolean;
  saveDisabled: boolean;
}) {
  const checks = [
    ['financialStatementsApproved', 'Financial statements/accounts approved'],
    ['annualReportUploaded', 'Annual Report copy uploaded'],
    ['trusteeDetailsReviewed', 'Trustee/public register details reviewed'],
    ['fundraisingReviewed', 'Fundraising activity reviewed'],
    ['complaintsReviewed', 'Complaints reviewed by board'],
  ] as const;
  const completed = [
    Boolean(annual.activitiesNarrative),
    Boolean(annual.publicBenefitStatement),
    Boolean(annual.beneficiariesSummary),
    ...checks.map(([key]) => annual[key]),
    Boolean(annual.boardApprovalDate),
    annual.filingStatus === AnnualReportFilingStatus.FILED,
  ].filter(Boolean).length;
  const percent = Math.round((completed / 10) * 100);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <ReviewFlag tone="draft">Annual Report source check</ReviewFlag>
            <EvidenceChip status={percent >= 80 ? 'ready' : 'review'}>{percent >= 80 ? 'Mostly ready' : 'Needs review'}</EvidenceChip>
          </div>
          <h3 className="mt-3 text-base font-semibold text-gray-950 dark:text-gray-50">Annual Report readiness</h3>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Activities, public benefit, finance, trustee details, and filing status for the annual return.
          </p>
        </div>
        <StatusChip tone={percent >= 80 ? 'success' : 'warning'} size="md">{percent}%</StatusChip>
      </div>
      <Progress value={percent} color={percent >= 80 ? 'success' : 'warning'} className="mt-4" aria-label="Annual Report readiness" />
      <div className="mt-5 space-y-5">
        <FieldGroup title="Narrative sources" description="Short, board-readable notes are enough here; keep the source file in the evidence vault.">
          <Textarea label="Activities narrative" value={annual.activitiesNarrative ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, activitiesNarrative: value })} />
          <Textarea label="Public benefit statement" value={annual.publicBenefitStatement ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, publicBenefitStatement: value })} />
          <Textarea label="Beneficiaries / stakeholders" value={annual.beneficiariesSummary ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, beneficiariesSummary: value })} />
        </FieldGroup>
        <FieldGroup title="Board review flags">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {checks.map(([key, label]) => (
              <ToggleRow key={key} label={label} checked={annual[key]} onChange={(checked) => setAnnual({ ...annual, [key]: checked })} />
            ))}
          </div>
        </FieldGroup>
        <FieldGroup title="Filing evidence">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input type="date" label="Board approval date" value={dateInput(annual.boardApprovalDate)} onValueChange={(value) => setAnnual({ ...annual, boardApprovalDate: value || null })} />
            <Select label="Filing status" selectedKeys={new Set([annual.filingStatus])} onSelectionChange={(keys) => {
              const value = Array.from(keys)[0] as AnnualReportFilingStatus | undefined;
              if (value) setAnnual({ ...annual, filingStatus: value });
            }}>
              {Object.entries(filingLabels).map(([value, label]) => <SelectItem key={value}>{label}</SelectItem>)}
            </Select>
            <Input type="date" label="Filed date" value={dateInput(annual.filedDate)} onValueChange={(value) => setAnnual({ ...annual, filedDate: value || null })} />
            <Input label="Notes" value={annual.notes ?? ''} onValueChange={(value) => setAnnual({ ...annual, notes: value })} />
          </div>
        </FieldGroup>
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onSave} isLoading={saving} isDisabled={saving || saveDisabled}>
          Save Annual Report readiness
        </Button>
      </div>
    </div>
  );
}

function FinancialControlsCard({
  financial,
  setFinancial,
  onSave,
  saving,
  saveDisabled,
}: {
  financial: FinancialControlReviewResponse;
  setFinancial: (value: FinancialControlReviewResponse) => void;
  onSave: () => void;
  saving: boolean;
  saveDisabled: boolean;
}) {
  const checks = [
    ['bankReconciliationsReviewed', 'Bank reconciliations reviewed'],
    ['dualAuthorisation', 'Dual authorisation in place'],
    ['budgetApproved', 'Budget approved'],
    ['managementAccountsReviewed', 'Management accounts reviewed'],
    ['reservesReviewed', 'Reserves reviewed'],
    ['restrictedFundsReviewed', 'Restricted funds reviewed'],
    ['assetsInsuranceReviewed', 'Assets and insurance reviewed'],
    ['payrollControlsReviewed', 'Payroll controls reviewed'],
    ['fundraisingControlsReviewed', 'Fundraising controls reviewed'],
  ] as const;
  const percent = Math.round((checks.map(([key]) => financial[key]).filter(Boolean).length / checks.length) * 100);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <ReviewFlag tone="draft">Financial controls source check</ReviewFlag>
            <EvidenceChip status={financial.minuteReference ? 'ready' : 'review'}>
              {financial.minuteReference ? 'Minute linked' : 'Minute pending'}
            </EvidenceChip>
          </div>
          <h3 className="mt-3 text-base font-semibold text-gray-950 dark:text-gray-50">Financial controls review</h3>
          <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Annual board evidence for banking, approvals, budgets, reserves, assets, payroll, and fundraising controls.
          </p>
        </div>
        <StatusChip tone={percent >= 80 ? 'success' : 'warning'} size="md">{percent}%</StatusChip>
      </div>
      <Progress value={percent} color={percent >= 80 ? 'success' : 'warning'} className="mt-4" aria-label="Financial controls readiness" />
      <div className="mt-5 space-y-5">
        <FieldGroup title="Control checks" description="Tick only the controls the board has actually reviewed for this reporting year.">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {checks.map(([key, label]) => (
              <ToggleRow key={key} label={label} checked={financial[key]} onChange={(checked) => setFinancial({ ...financial, [key]: checked })} />
            ))}
          </div>
        </FieldGroup>
        <FieldGroup title="Review evidence">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Reviewed by" value={financial.reviewedBy ?? ''} onValueChange={(value) => setFinancial({ ...financial, reviewedBy: value })} />
            <Input type="date" label="Review date" value={dateInput(financial.reviewDate)} onValueChange={(value) => setFinancial({ ...financial, reviewDate: value || null })} />
            <Input label="Minute reference" value={financial.minuteReference ?? ''} onValueChange={(value) => setFinancial({ ...financial, minuteReference: value })} />
            <Textarea label="Actions / follow-up" value={financial.actions ?? ''} minRows={2} onValueChange={(value) => setFinancial({ ...financial, actions: value })} />
          </div>
        </FieldGroup>
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onSave} isLoading={saving} isDisabled={saving || saveDisabled}>
          Save controls review
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-12 items-start gap-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary dark:border-gray-700 dark:bg-gray-900"
      />
      <span className="leading-5">{label}</span>
    </label>
  );
}

function modalTitle(type: RegisterType) {
  return {
    conflict: 'Add conflict',
    risk: 'Add risk',
    complaint: 'Add complaint',
    fundraising: 'Add fundraising activity',
  }[type];
}

function ConflictForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Conflict record" description="Record the declared interest, handling steps, and the board evidence trail.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Trustee / connected person" value={String(form.trusteeName ?? '')} onValueChange={(value) => updateForm('trusteeName', value)} isRequired />
        <Input label="Matter" value={String(form.matter ?? '')} onValueChange={(value) => updateForm('matter', value)} isRequired />
        <Input type="date" label="Date declared" value={String(form.dateDeclared ?? '')} onValueChange={(value) => updateForm('dateDeclared', value)} />
        <Input type="date" label="Meeting date" value={String(form.meetingDate ?? '')} onValueChange={(value) => updateForm('meetingDate', value)} />
      </div>
      <Textarea label="Nature of conflict" value={String(form.nature ?? '')} onValueChange={(value) => updateForm('nature', value)} isRequired />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} isRequired />
      <Input label="Decision" value={String(form.decision ?? '')} onValueChange={(value) => updateForm('decision', value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Minute reference" value={String(form.minuteReference ?? '')} onValueChange={(value) => updateForm('minuteReference', value)} />
        <Input type="date" label="Next review date" value={String(form.nextReviewDate ?? '')} onValueChange={(value) => updateForm('nextReviewDate', value)} />
      </div>
    </FieldGroup>
  );
}

function RiskForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Risk record" description="Score likelihood and impact from 1 to 5, then record mitigation and owner.">
      <Input label="Risk title" value={String(form.title ?? '')} onValueChange={(value) => updateForm('title', value)} isRequired />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select label="Category" selectedKeys={new Set([String(form.category ?? RiskCategory.GOVERNANCE)])} onSelectionChange={(keys) => {
          const value = Array.from(keys)[0] as string | undefined;
          if (value) updateForm('category', value);
        }}>
          {Object.entries(riskCategoryLabels).map(([value, label]) => <SelectItem key={value}>{label}</SelectItem>)}
        </Select>
        <Input type="number" min={1} max={5} label="Likelihood" value={String(form.likelihood ?? 3)} onValueChange={(value) => updateForm('likelihood', Number(value || 1))} />
        <Input type="number" min={1} max={5} label="Impact" value={String(form.impact ?? 3)} onValueChange={(value) => updateForm('impact', Number(value || 1))} />
      </div>
      <Textarea label="Description" value={String(form.description ?? '')} onValueChange={(value) => updateForm('description', value)} isRequired />
      <Textarea label="Mitigation / controls" value={String(form.mitigation ?? '')} onValueChange={(value) => updateForm('mitigation', value)} isRequired />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Owner" value={String(form.owner ?? '')} onValueChange={(value) => updateForm('owner', value)} />
        <Input type="date" label="Review date" value={String(form.reviewDate ?? '')} onValueChange={(value) => updateForm('reviewDate', value)} />
        <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      </div>
    </FieldGroup>
  );
}

function ComplaintForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Complaint record" description="Keep the complaint, action, outcome, and board review evidence together.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input type="date" label="Received date" value={String(form.receivedDate ?? '')} onValueChange={(value) => updateForm('receivedDate', value)} />
        <Input label="Source" value={String(form.source ?? '')} onValueChange={(value) => updateForm('source', value)} />
      </div>
      <Textarea label="Summary" value={String(form.summary ?? '')} onValueChange={(value) => updateForm('summary', value)} isRequired />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} />
      <Textarea label="Outcome" value={String(form.outcome ?? '')} onValueChange={(value) => updateForm('outcome', value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ToggleRow label="Reviewed by board" checked={Boolean(form.reviewedByBoard)} onChange={(checked) => updateForm('reviewedByBoard', checked)} />
        <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      </div>
    </FieldGroup>
  );
}

function FundraisingForm({ form, updateForm }: FormProps) {
  return (
    <FieldGroup title="Fundraising activity" description="Record public-facing controls, third parties, complaints, and review outcomes.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Activity name" value={String(form.name ?? '')} onValueChange={(value) => updateForm('name', value)} isRequired />
        <Input label="Activity type" value={String(form.activityType ?? '')} onValueChange={(value) => updateForm('activityType', value)} isRequired />
        <Input type="date" label="Start date" value={String(form.startDate ?? '')} onValueChange={(value) => updateForm('startDate', value)} />
        <Input type="date" label="End date" value={String(form.endDate ?? '')} onValueChange={(value) => updateForm('endDate', value)} />
      </div>
      <Input label="Third-party fundraiser" value={String(form.thirdPartyFundraiser ?? '')} onValueChange={(value) => updateForm('thirdPartyFundraiser', value)} />
      <Textarea label="Controls" value={String(form.controls ?? '')} onValueChange={(value) => updateForm('controls', value)} />
      <Textarea label="Review outcome" value={String(form.reviewOutcome ?? '')} onValueChange={(value) => updateForm('reviewOutcome', value)} />
      <Input label="Board minute reference" value={String(form.boardMinuteReference ?? '')} onValueChange={(value) => updateForm('boardMinuteReference', value)} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ToggleRow label="Public-facing activity" checked={Boolean(form.publicFacing)} onChange={(checked) => updateForm('publicFacing', checked)} />
        <ToggleRow label="Complaints received" checked={Boolean(form.complaintsReceived)} onChange={(checked) => updateForm('complaintsReceived', checked)} />
      </div>
    </FieldGroup>
  );
}

type FormProps = {
  form: Record<string, string | number | boolean>;
  updateForm: (key: string, value: string | number | boolean) => void;
};

function normalizeForm(form: Record<string, string | number | boolean>) {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, typeof value === 'string' && value.trim() === '' ? null : value]),
  );
}
