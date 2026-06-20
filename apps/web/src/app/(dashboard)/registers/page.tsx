'use client';

import { logClientError } from '@/lib/client-logger';
import { isPlanFeatureUnavailable } from '@/lib/plan-feature';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  Chip,
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

export default function RegistersPage() {
  useDocumentTitle('Governance Registers');
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [planUnavailable, setPlanUnavailable] = useState(false);
  const [summary, setSummary] = useState<GovernanceRegistersSummary | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRecordResponse[]>([]);
  const [risks, setRisks] = useState<RiskRecordResponse[]>([]);
  const [complaints, setComplaints] = useState<ComplaintRecordResponse[]>([]);
  const [fundraising, setFundraising] = useState<FundraisingRecordResponse[]>([]);
  const [annual, setAnnual] = useState<AnnualReportReadinessResponse>(emptyAnnual(currentYear));
  const [financial, setFinancial] = useState<FinancialControlReviewResponse>(emptyFinancial(currentYear));
  const [modalType, setModalType] = useState<RegisterType | null>(null);
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});

  const fetchRegisters = useCallback(async () => {
    setLoading(true);
    setPlanUnavailable(false);
    try {
      const [summaryRes, conflictsRes, risksRes, complaintsRes, fundraisingRes, annualRes, financialRes] = await Promise.all([
        api.get(`/governance-registers/summary?year=${year}`),
        api.get('/governance-registers/conflicts'),
        api.get('/governance-registers/risks'),
        api.get('/governance-registers/complaints'),
        api.get('/governance-registers/fundraising'),
        api.get(`/governance-registers/annual-report?year=${year}`),
        api.get(`/governance-registers/financial-controls?year=${year}`),
      ]);
      setSummary(summaryRes.data);
      setConflicts(conflictsRes.data ?? []);
      setRisks(risksRes.data ?? []);
      setComplaints(complaintsRes.data ?? []);
      setFundraising(fundraisingRes.data ?? []);
      setAnnual(annualRes.data ?? emptyAnnual(year));
      setFinancial(financialRes.data ?? emptyFinancial(year));
    } catch (err) {
      if (isPlanFeatureUnavailable(err)) {
        setPlanUnavailable(true);
        setSummary(null);
        setConflicts([]);
        setRisks([]);
        setComplaints([]);
        setFundraising([]);
        setAnnual(emptyAnnual(year));
        setFinancial(emptyFinancial(year));
        return;
      }
      logClientError('Failed to load governance registers', err);
      toast('Failed to load governance registers', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, year]);

  useEffect(() => {
    fetchRegisters();
  }, [fetchRegisters]);

  const openModal = (type: RegisterType) => {
    setModalType(type);
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
  };

  const handleCreate = async () => {
    if (!modalType) return;
    setSaving(true);
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
    try {
      await api.patch(endpoint, { status });
      await fetchRegisters();
    } catch (err) {
      logClientError('Failed to close register record', err);
      toast('Failed to close record', 'error');
    }
  };

  const saveAnnual = async () => {
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

  const riskScore = (risk: RiskRecordResponse) => risk.likelihood * risk.impact;
  const highRisks = useMemo(() => risks.filter((risk) => risk.status !== RegisterStatus.CLOSED && riskScore(risk) >= 12), [risks]);

  if (!loading && planUnavailable) {
    return (
      <div className="space-y-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Governance Registers</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
              Structured trustee, risk, finance, fundraising, complaints, and annual reporting records for board review.
            </p>
          </div>
        </div>

        <Card className="border border-teal-primary/20 dark:border-teal-light/20 bg-white dark:bg-gray-900 p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Chip size="sm" variant="flat" className="mb-3 bg-teal-primary/10 text-teal-dark border border-teal-primary/20 dark:bg-teal-light/10 dark:text-teal-light dark:border-teal-light/20">
                Complete plan
              </Chip>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Governance registers are available on Complete.</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-300">
                Upgrade to manage conflict, risk, complaints, fundraising, Annual Report readiness, and financial control registers.
              </p>
            </div>
            <Button as={Link} href="/billing" color="primary" className="bg-teal-primary text-white">
              View billing
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Governance Registers</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Structured trustee, risk, finance, fundraising, complaints, and annual reporting records for board review.
          </p>
        </div>
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
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Open conflicts" value={summary?.openConflicts ?? 0} tone={(summary?.openConflicts ?? 0) > 0 ? 'warning' : 'success'} />
        <MetricCard label="Open risks" value={summary?.openRisks ?? 0} tone={(summary?.openRisks ?? 0) > 0 ? 'warning' : 'success'} />
        <MetricCard label="High risks" value={highRisks.length} tone={highRisks.length > 0 ? 'danger' : 'success'} />
        <MetricCard label="Open complaints" value={summary?.openComplaints ?? 0} tone={(summary?.openComplaints ?? 0) > 0 ? 'warning' : 'success'} />
        <MetricCard label="Annual Report" value={`${summary?.annualReportReadinessPercent ?? 0}%`} tone={(summary?.annualReportReadinessPercent ?? 0) >= 80 ? 'success' : 'warning'} />
        <MetricCard label="Financial controls" value={`${summary?.financialControlsPercent ?? 0}%`} tone={(summary?.financialControlsPercent ?? 0) >= 80 ? 'success' : 'warning'} />
      </div>

      {loading ? (
        <Card className="border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 animate-pulse">
          <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-800" />
          <div className="mt-4 h-20 rounded bg-gray-100 dark:bg-gray-800" />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <RegisterSection
              title="Conflicts register"
              subtitle="Declared trustee interests, meeting handling, decisions, and review dates."
              buttonLabel="Add conflict"
              onAdd={() => openModal('conflict')}
              empty="No conflicts recorded."
            >
              {conflicts.map((item) => (
                <RowCard key={item.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.trusteeName}</p>
                      <Chip size="sm" variant="flat" color={item.status === ConflictStatus.CLOSED ? 'success' : 'warning'}>
                        {conflictStatusLabels[item.status]}
                      </Chip>
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{item.matter}</p>
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Declared {niceDate(item.dateDeclared)} · Minute {item.minuteReference || 'not linked'}
                    </p>
                  </div>
                  {item.status !== ConflictStatus.CLOSED && (
                    <Button size="sm" variant="flat" onPress={() => closeRecord('conflict', item.id)}>
                      Close
                    </Button>
                  )}
                </RowCard>
              ))}
            </RegisterSection>

            <RegisterSection
              title="Risk register"
              subtitle="Board-level risk, score, mitigation, owner, and review evidence."
              buttonLabel="Add risk"
              onAdd={() => openModal('risk')}
              empty="No risks recorded."
            >
              {risks.map((item) => (
                <RowCard key={item.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.title}</p>
                      <Chip size="sm" color={riskScore(item) >= 12 ? 'danger' : 'warning'} variant="flat">
                        Score {riskScore(item)}
                      </Chip>
                      <Chip size="sm" variant="flat">{riskCategoryLabels[item.category]}</Chip>
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 line-clamp-2">{item.mitigation}</p>
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Owner {item.owner || 'not assigned'} · Review {niceDate(item.reviewDate)}
                    </p>
                  </div>
                  {item.status !== RegisterStatus.CLOSED && (
                    <Button size="sm" variant="flat" onPress={() => closeRecord('risk', item.id)}>
                      Close
                    </Button>
                  )}
                </RowCard>
              ))}
            </RegisterSection>

            <RegisterSection
              title="Complaints register"
              subtitle="Complaints, action taken, outcomes, and board review references."
              buttonLabel="Add complaint"
              onAdd={() => openModal('complaint')}
              empty="No complaints recorded."
            >
              {complaints.map((item) => (
                <RowCard key={item.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.summary}</p>
                      <Chip size="sm" color={item.status === RegisterStatus.CLOSED ? 'success' : 'warning'} variant="flat">
                        {registerStatusLabels[item.status]}
                      </Chip>
                    </div>
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Received {niceDate(item.receivedDate)} · Board review {item.reviewedByBoard ? 'recorded' : 'pending'}
                    </p>
                  </div>
                  {item.status !== RegisterStatus.CLOSED && (
                    <Button size="sm" variant="flat" onPress={() => closeRecord('complaint', item.id)}>
                      Close
                    </Button>
                  )}
                </RowCard>
              ))}
            </RegisterSection>

            <RegisterSection
              title="Fundraising register"
              subtitle="Public fundraising activities, controls, complaints, and review outcomes."
              buttonLabel="Add activity"
              onAdd={() => openModal('fundraising')}
              empty="No fundraising activities recorded."
            >
              {fundraising.map((item) => (
                <RowCard key={item.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.name}</p>
                      <Chip size="sm" variant="flat">{item.activityType}</Chip>
                      {item.thirdPartyFundraiser && <Chip size="sm" color="warning" variant="flat">Third party</Chip>}
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 line-clamp-2">{item.controls || 'Controls not recorded yet.'}</p>
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Review outcome: {item.reviewOutcome || 'pending'}</p>
                  </div>
                  {item.status !== RegisterStatus.CLOSED && (
                    <Button size="sm" variant="flat" onPress={() => closeRecord('fundraising', item.id)}>
                      Close
                    </Button>
                  )}
                </RowCard>
              ))}
            </RegisterSection>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <AnnualReportCard annual={annual} setAnnual={setAnnual} onSave={saveAnnual} saving={saving} />
            <FinancialControlsCard financial={financial} setFinancial={setFinancial} onSave={saveFinancial} saving={saving} />
          </div>
        </>
      )}

      <Modal isOpen={Boolean(modalType)} onOpenChange={(open) => !open && closeModal()} size="2xl">
        <ModalContent>
          <ModalHeader>{modalType ? modalTitle(modalType) : 'Add register record'}</ModalHeader>
          <ModalBody className="space-y-4">
            {modalType === 'conflict' && <ConflictForm form={form} updateForm={updateForm} />}
            {modalType === 'risk' && <RiskForm form={form} updateForm={updateForm} />}
            {modalType === 'complaint' && <ComplaintForm form={form} updateForm={updateForm} />}
            {modalType === 'fundraising' && <FundraisingForm form={form} updateForm={updateForm} />}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeModal}>Cancel</Button>
            <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={handleCreate} isLoading={saving}>
              Save record
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string | number; tone: 'success' | 'warning' | 'danger' }) {
  const colour = tone === 'success' ? 'text-green-600 dark:text-green-400' : tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400';
  return (
    <Card className="border border-gray-200 dark:border-gray-800 dark:bg-gray-900 p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{value}</p>
    </Card>
  );
}

function RegisterSection({
  title,
  subtitle,
  buttonLabel,
  onAdd,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  buttonLabel: string;
  onAdd: () => void;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <Card className="border border-gray-200 dark:border-gray-800 dark:bg-gray-900 p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{subtitle}</p>
        </div>
        <Button size="sm" className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onAdd}>
          {buttonLabel}
        </Button>
      </div>
      <div className="mt-4 space-y-3">
        {children.length ? children : <p className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4 text-sm text-gray-400 dark:text-gray-500">{empty}</p>}
      </div>
    </Card>
  );
}

function RowCard({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">{children}</div>;
}

function AnnualReportCard({
  annual,
  setAnnual,
  onSave,
  saving,
}: {
  annual: AnnualReportReadinessResponse;
  setAnnual: (value: AnnualReportReadinessResponse) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const checks = [
    ['financialStatementsApproved', 'Financial statements/accounts approved'],
    ['annualReportUploaded', 'Annual Report copy uploaded'],
    ['trusteeDetailsReviewed', 'Trustee/public register details reviewed'],
    ['fundraisingReviewed', 'Fundraising activity reviewed'],
    ['complaintsReviewed', 'Complaints reviewed by board'],
  ] as const;
  const percent = Math.round(
    ([
      Boolean(annual.activitiesNarrative),
      Boolean(annual.publicBenefitStatement),
      Boolean(annual.beneficiariesSummary),
      ...checks.map(([key]) => annual[key]),
      Boolean(annual.boardApprovalDate),
      annual.filingStatus === AnnualReportFilingStatus.FILED,
    ].filter(Boolean).length /
      10) *
      100,
  );
  return (
    <Card className="border border-gray-200 dark:border-gray-800 dark:bg-gray-900 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Annual Report readiness</h2>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Activities, public benefit, finance, trustee details, and filing status for the annual return.</p>
        </div>
        <Chip size="sm" color={percent >= 80 ? 'success' : 'warning'} variant="flat">{percent}%</Chip>
      </div>
      <Progress value={percent} color={percent >= 80 ? 'success' : 'warning'} className="mt-4" aria-label="Annual Report readiness" />
      <div className="mt-4 space-y-3">
        <Textarea label="Activities narrative" value={annual.activitiesNarrative ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, activitiesNarrative: value })} />
        <Textarea label="Public benefit statement" value={annual.publicBenefitStatement ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, publicBenefitStatement: value })} />
        <Textarea label="Beneficiaries / stakeholders" value={annual.beneficiariesSummary ?? ''} minRows={2} onValueChange={(value) => setAnnual({ ...annual, beneficiariesSummary: value })} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {checks.map(([key, label]) => (
            <ToggleRow key={key} label={label} checked={annual[key]} onChange={(checked) => setAnnual({ ...annual, [key]: checked })} />
          ))}
        </div>
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
        <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onSave} isLoading={saving}>Save Annual Report readiness</Button>
      </div>
    </Card>
  );
}

function FinancialControlsCard({
  financial,
  setFinancial,
  onSave,
  saving,
}: {
  financial: FinancialControlReviewResponse;
  setFinancial: (value: FinancialControlReviewResponse) => void;
  onSave: () => void;
  saving: boolean;
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
    <Card className="border border-gray-200 dark:border-gray-800 dark:bg-gray-900 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Financial controls review</h2>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Annual board evidence for banking, approvals, budgets, reserves, assets, payroll, and fundraising controls.</p>
        </div>
        <Chip size="sm" color={percent >= 80 ? 'success' : 'warning'} variant="flat">{percent}%</Chip>
      </div>
      <Progress value={percent} color={percent >= 80 ? 'success' : 'warning'} className="mt-4" aria-label="Financial controls readiness" />
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {checks.map(([key, label]) => (
          <ToggleRow key={key} label={label} checked={financial[key]} onChange={(checked) => setFinancial({ ...financial, [key]: checked })} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Reviewed by" value={financial.reviewedBy ?? ''} onValueChange={(value) => setFinancial({ ...financial, reviewedBy: value })} />
        <Input type="date" label="Review date" value={dateInput(financial.reviewDate)} onValueChange={(value) => setFinancial({ ...financial, reviewDate: value || null })} />
        <Input label="Minute reference" value={financial.minuteReference ?? ''} onValueChange={(value) => setFinancial({ ...financial, minuteReference: value })} />
        <Input label="Actions / follow-up" value={financial.actions ?? ''} onValueChange={(value) => setFinancial({ ...financial, actions: value })} />
      </div>
      <Button className="mt-4 bg-teal-primary text-white hover:bg-teal-dark" onPress={onSave} isLoading={saving}>Save controls review</Button>
    </Card>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/60 px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-gray-300 dark:border-gray-700 dark:bg-gray-900 text-teal-primary focus:ring-teal-primary" />
      <span>{label}</span>
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
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Trustee / connected person" value={String(form.trusteeName ?? '')} onValueChange={(value) => updateForm('trusteeName', value)} />
        <Input label="Matter" value={String(form.matter ?? '')} onValueChange={(value) => updateForm('matter', value)} />
        <Input type="date" label="Date declared" value={String(form.dateDeclared ?? '')} onValueChange={(value) => updateForm('dateDeclared', value)} />
        <Input type="date" label="Meeting date" value={String(form.meetingDate ?? '')} onValueChange={(value) => updateForm('meetingDate', value)} />
      </div>
      <Textarea label="Nature of conflict" value={String(form.nature ?? '')} onValueChange={(value) => updateForm('nature', value)} />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} />
      <Input label="Minute reference" value={String(form.minuteReference ?? '')} onValueChange={(value) => updateForm('minuteReference', value)} />
    </>
  );
}

function RiskForm({ form, updateForm }: FormProps) {
  return (
    <>
      <Input label="Risk title" value={String(form.title ?? '')} onValueChange={(value) => updateForm('title', value)} />
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
      <Textarea label="Description" value={String(form.description ?? '')} onValueChange={(value) => updateForm('description', value)} />
      <Textarea label="Mitigation / controls" value={String(form.mitigation ?? '')} onValueChange={(value) => updateForm('mitigation', value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Owner" value={String(form.owner ?? '')} onValueChange={(value) => updateForm('owner', value)} />
        <Input type="date" label="Review date" value={String(form.reviewDate ?? '')} onValueChange={(value) => updateForm('reviewDate', value)} />
      </div>
    </>
  );
}

function ComplaintForm({ form, updateForm }: FormProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input type="date" label="Received date" value={String(form.receivedDate ?? '')} onValueChange={(value) => updateForm('receivedDate', value)} />
        <Input label="Source" value={String(form.source ?? '')} onValueChange={(value) => updateForm('source', value)} />
      </div>
      <Textarea label="Summary" value={String(form.summary ?? '')} onValueChange={(value) => updateForm('summary', value)} />
      <Textarea label="Action taken" value={String(form.actionTaken ?? '')} onValueChange={(value) => updateForm('actionTaken', value)} />
      <Textarea label="Outcome" value={String(form.outcome ?? '')} onValueChange={(value) => updateForm('outcome', value)} />
      <ToggleRow label="Reviewed by board" checked={Boolean(form.reviewedByBoard)} onChange={(checked) => updateForm('reviewedByBoard', checked)} />
    </>
  );
}

function FundraisingForm({ form, updateForm }: FormProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Activity name" value={String(form.name ?? '')} onValueChange={(value) => updateForm('name', value)} />
        <Input label="Activity type" value={String(form.activityType ?? '')} onValueChange={(value) => updateForm('activityType', value)} />
        <Input type="date" label="Start date" value={String(form.startDate ?? '')} onValueChange={(value) => updateForm('startDate', value)} />
        <Input type="date" label="End date" value={String(form.endDate ?? '')} onValueChange={(value) => updateForm('endDate', value)} />
      </div>
      <Input label="Third-party fundraiser" value={String(form.thirdPartyFundraiser ?? '')} onValueChange={(value) => updateForm('thirdPartyFundraiser', value)} />
      <Textarea label="Controls" value={String(form.controls ?? '')} onValueChange={(value) => updateForm('controls', value)} />
      <Textarea label="Review outcome" value={String(form.reviewOutcome ?? '')} onValueChange={(value) => updateForm('reviewOutcome', value)} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ToggleRow label="Public-facing activity" checked={Boolean(form.publicFacing)} onChange={(checked) => updateForm('publicFacing', checked)} />
        <ToggleRow label="Complaints received" checked={Boolean(form.complaintsReceived)} onChange={(checked) => updateForm('complaintsReceived', checked)} />
      </div>
    </>
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
