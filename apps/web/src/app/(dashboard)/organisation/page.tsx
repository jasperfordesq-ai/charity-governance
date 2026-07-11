'use client';

import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { OrganisationComplexityModal } from './organisation-complexity-modal';
import { OrganisationProfileForm } from './organisation-profile-form';
import { OrganisationSetupSummary } from './organisation-setup-summary';
import { useOrganisationWorkflow } from './use-organisation-workflow';

export default function OrganisationPage() {
  useDocumentTitle('Organisation');
  const {
    canManage,
    charitablePurpose,
    completionItems,
    complexity,
    complexityModal,
    conditionalObligationProfile,
    contactEmail,
    contactPhone,
    croAnnualReturnDate,
    croAnnualReturnDateConfirmed,
    croNumber,
    dateRegistered,
    dirtyStateLabel,
    financialYearEnd,
    formValidationErrors,
    handleComplexityChange,
    handleConditionalFactChange,
    handleCroAnnualReturnDateChange,
    handleLegalFormChange,
    handlePurposeChange,
    handleSave,
    incorporationDate,
    isDirty,
    isLoading,
    lastActualAgmDate,
    lastUnanimousAnnualMemberResolutionDate,
    legalForm,
    legalFormConfirmed,
    legalFormOptions,
    name,
    memberCount,
    org,
    purposeOptions,
    profileSaveStatus,
    rcnNumber,
    readyCount,
    refreshUser,
    registeredAddress,
    saving,
    selectedPurposes,
    setContactEmail,
    setContactPhone,
    setCroAnnualReturnDateConfirmed,
    setCroNumber,
    setDateRegistered,
    setFinancialYearEnd,
    setIncorporationDate,
    setLastActualAgmDate,
    setLastUnanimousAnnualMemberResolutionDate,
    setLegalFormConfirmed,
    setMemberCount,
    setName,
    setRcnNumber,
    setRegisteredAddress,
    setWebsite,
    validationErrors,
    website,
  } = useOrganisationWorkflow();

  if (isLoading) {
    return (
      <AppPage
        eyebrow="Operational setup"
        title="Organisation Profile"
        description="Loading the organisation profile used across compliance reporting and deadline generation."
      >
        <LoadingState title="Loading organisation profile" description="Hydrating your secure session." variant="page" />
      </AppPage>
    );
  }

  if (!org) {
    return (
      <AppPage
        eyebrow="Operational setup"
        title="Organisation Profile"
        description="The organisation profile could not be hydrated from the current session."
      >
        <ErrorState
          title="Organisation profile unavailable"
          description="Please refresh the page or sign in again before editing setup details."
          action={(
            <Button size="sm" variant="flat" onPress={() => refreshUser()}>
              Refresh session
            </Button>
          )}
          variant="page"
        />
      </AppPage>
    );
  }

  return (
    <AppPage
      eyebrow="Operational setup"
      title="Organisation Profile"
      description="Start here: these details drive review-ready reports, annual deadlines, and the standards shown across CharityPilot. This is workflow support, not legal advice."
    >
      <OrganisationSetupSummary completionItems={completionItems} />

      <OrganisationProfileForm
        canManage={canManage}
        charitablePurpose={charitablePurpose}
        completionItems={completionItems}
        complexity={complexity}
        conditionalObligationProfile={conditionalObligationProfile}
        contactEmail={contactEmail}
        contactPhone={contactPhone}
        croAnnualReturnDate={croAnnualReturnDate}
        croAnnualReturnDateConfirmed={croAnnualReturnDateConfirmed}
        croNumber={croNumber}
        dateRegistered={dateRegistered}
        dirtyStateLabel={dirtyStateLabel}
        financialYearEnd={financialYearEnd}
        formValidationErrors={formValidationErrors}
        handleComplexityChange={handleComplexityChange}
        handleConditionalFactChange={handleConditionalFactChange}
        handleCroAnnualReturnDateChange={handleCroAnnualReturnDateChange}
        handleLegalFormChange={handleLegalFormChange}
        handlePurposeChange={handlePurposeChange}
        handleSave={handleSave}
        incorporationDate={incorporationDate}
        isDirty={isDirty}
        lastActualAgmDate={lastActualAgmDate}
        lastUnanimousAnnualMemberResolutionDate={lastUnanimousAnnualMemberResolutionDate}
        legalForm={legalForm}
        legalFormConfirmed={legalFormConfirmed}
        legalFormOptions={legalFormOptions}
        name={name}
        memberCount={memberCount}
        purposeOptions={purposeOptions}
        profileSaveStatus={profileSaveStatus}
        rcnNumber={rcnNumber}
        readyCount={readyCount}
        registeredAddress={registeredAddress}
        saving={saving}
        selectedPurposes={selectedPurposes}
        setContactEmail={setContactEmail}
        setContactPhone={setContactPhone}
        setCroAnnualReturnDateConfirmed={setCroAnnualReturnDateConfirmed}
        setCroNumber={setCroNumber}
        setDateRegistered={setDateRegistered}
        setFinancialYearEnd={setFinancialYearEnd}
        setIncorporationDate={setIncorporationDate}
        setLastActualAgmDate={setLastActualAgmDate}
        setLastUnanimousAnnualMemberResolutionDate={setLastUnanimousAnnualMemberResolutionDate}
        setLegalFormConfirmed={setLegalFormConfirmed}
        setMemberCount={setMemberCount}
        setName={setName}
        setRcnNumber={setRcnNumber}
        setRegisteredAddress={setRegisteredAddress}
        setWebsite={setWebsite}
        validationErrors={validationErrors}
        website={website}
      />

      <OrganisationComplexityModal
        isOpen={complexityModal.isOpen}
        onOpenChange={complexityModal.onOpenChange}
      />
    </AppPage>
  );
}
