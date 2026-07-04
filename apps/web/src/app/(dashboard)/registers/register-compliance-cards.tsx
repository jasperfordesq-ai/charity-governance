'use client';

import { Button, Checkbox, Input, Progress, Select, SelectItem, Textarea } from '@heroui/react';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { FieldGroup } from '@/components/ui/forms';
import { EvidenceChip, ReviewFlag, StatusChip } from '@/components/ui/status';
import {
  AnnualReportFilingStatus,
  type AnnualReportReadinessResponse,
  type FinancialControlReviewResponse,
} from '@charitypilot/shared';

const filingLabels = {
  [AnnualReportFilingStatus.NOT_STARTED]: 'Not started',
  [AnnualReportFilingStatus.IN_PROGRESS]: 'In progress',
  [AnnualReportFilingStatus.BOARD_APPROVED]: 'Board approved',
  [AnnualReportFilingStatus.FILED]: 'Filed',
};

const dateInput = (value: string | null | undefined) => value?.slice(0, 10) ?? '';

export function AnnualReportCard({
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
        <Button className={primaryActionButtonClassName} onPress={onSave} isLoading={saving} isDisabled={saving || saveDisabled}>
          Save Annual Report readiness
        </Button>
      </div>
    </div>
  );
}

export function FinancialControlsCard({
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
        <Button className={primaryActionButtonClassName} onPress={onSave} isLoading={saving} isDisabled={saving || saveDisabled}>
          Save controls review
        </Button>
      </div>
    </div>
  );
}

export function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Checkbox
      isSelected={checked}
      onValueChange={onChange}
      classNames={{
        base: 'm-0 flex min-h-12 max-w-none items-start gap-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2 dark:border-gray-800 dark:bg-gray-950',
        wrapper: 'mt-0.5',
        label: 'text-sm leading-5 text-gray-700 dark:text-gray-300',
      }}
    >
      <span className="leading-5">{label}</span>
    </Checkbox>
  );
}
