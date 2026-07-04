'use client';

import Link from 'next/link';
import {
  Button,
  Select,
  SelectItem,
} from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, LockedFeatureState } from '@/components/ui/states';
import { RegisterPriorityPanel } from './register-priority-panel';
import { AnnualReportCard, FinancialControlsCard } from './register-compliance-cards';
import { RegisterOverviewPanel } from './register-overview-panel';
import { RegisterRecordsPanel } from './register-record-lists';
import { RegisterRecordModal } from './register-record-modal';
import { useRegistersWorkflow } from './use-registers-workflow';

export default function RegistersPage() {
  useDocumentTitle('Governance Registers');
  const {
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
    registerSavingLabel,
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
  } = useRegistersWorkflow();

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

      <RegisterOverviewPanel
        openRegisterCount={openRegisterCount}
        highRiskCount={highRisks.length}
        annualReportReadinessPercent={summaryForSelectedYear?.annualReportReadinessPercent ?? 0}
        financialControlsPercent={summaryForSelectedYear?.financialControlsPercent ?? 0}
      />

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
          <RegisterPriorityPanel
            conditionalProfile={conditionalProfile}
            priorities={conditionalRegisterPriorities}
            missingCount={missingConditionalRegisterCount}
            error={organisationProfileError}
            onRetry={fetchOrganisationProfile}
          />

          <AppSection
            title="Operational registers"
            description="Use each register for one decision trail: what happened, what was done, where the board minute sits, and what needs review next."
          >
            <RegisterRecordsPanel
              conflicts={conflictsForSelectedYear}
              risks={risksForSelectedYear}
              complaints={complaintsForSelectedYear}
              fundraising={fundraisingForSelectedYear}
              onAdd={openModal}
              onClose={closeRecord}
              closingRecordId={closingRecordId}
              saving={saving}
            />
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

      <RegisterRecordModal
        modalType={modalType}
        closeModal={closeModal}
        form={form}
        updateForm={updateForm}
        formError={formError}
        formDisabledReason={formDisabledReason}
        saving={saving}
        handleCreate={handleCreate}
      />
    </AppPage>
  );
}
