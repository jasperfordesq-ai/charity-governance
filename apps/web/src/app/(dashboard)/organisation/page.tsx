'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, LoadingState } from '@/components/ui/states';
import type { ConditionalObligationProfile, UpdateOrganisationRequest } from '@charitypilot/shared';
import {
  CHARITABLE_PURPOSE_LABELS,
  CharitablePurpose,
  LEGAL_FORM_LABELS,
  LegalForm,
  OrganisationComplexity,
} from '@charitypilot/shared';
import {
  EMPTY_CONDITIONAL_OBLIGATION_PROFILE,
  normaliseConditionalObligationProfile,
} from './organisation-conditional-profile';
import { OrganisationComplexityModal } from './organisation-complexity-modal';
import { OrganisationProfileForm } from './organisation-profile-form';
import { OrganisationSetupSummary } from './organisation-setup-summary';

export default function OrganisationPage() {
  useDocumentTitle('Organisation');
  const { user, isLoading, refreshUser } = useAuth();
  const org = user?.organisation;

  const { toast } = useToast();
  const complexityModal = useDisclosure();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const initialised = useRef(false);

  const [name, setName] = useState('');
  const [rcnNumber, setRcnNumber] = useState('');
  const [croNumber, setCroNumber] = useState('');
  const [legalForm, setLegalForm] = useState<LegalForm>(LegalForm.CLG);
  const [complexity, setComplexity] = useState<OrganisationComplexity>(OrganisationComplexity.SIMPLE);
  const [charitablePurpose, setCharitablePurpose] = useState<Set<string>>(new Set());
  const [financialYearEnd, setFinancialYearEnd] = useState('');
  const [registeredAddress, setRegisteredAddress] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [dateRegistered, setDateRegistered] = useState('');
  const [lastAgmDate, setLastAgmDate] = useState('');
  const [conditionalObligationProfile, setConditionalObligationProfile] = useState<ConditionalObligationProfile>(
    EMPTY_CONDITIONAL_OBLIGATION_PROFILE,
  );

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!org) return;

    initialised.current = false;
    setName(org.name ?? '');
    setRcnNumber(org.rcnNumber ?? '');
    setCroNumber(org.croNumber ?? '');
    setLegalForm(org.legalForm ?? LegalForm.CLG);
    setComplexity(org.complexity ?? OrganisationComplexity.SIMPLE);
    setCharitablePurpose(new Set(org.charitablePurpose ?? []));
    setFinancialYearEnd(org.financialYearEnd ? org.financialYearEnd.slice(0, 10) : '');
    setRegisteredAddress(org.registeredAddress ?? '');
    setContactEmail(org.contactEmail ?? '');
    setContactPhone(org.contactPhone ?? '');
    setWebsite(org.website ?? '');
    setDateRegistered(org.dateRegistered ? org.dateRegistered.slice(0, 10) : '');
    setLastAgmDate(org.lastAgmDate ? org.lastAgmDate.slice(0, 10) : '');
    setConditionalObligationProfile(normaliseConditionalObligationProfile(org.conditionalObligationProfile));
    setIsDirty(false);
    setSaveError('');
    setTimeout(() => {
      initialised.current = true;
    }, 0);
  }, [org]);

  useEffect(() => {
    if (initialised.current) {
      setIsDirty(true);
      setSaved(false);
      setSaveError('');
    }
  }, [
    charitablePurpose,
    complexity,
    contactEmail,
    contactPhone,
    conditionalObligationProfile,
    croNumber,
    dateRegistered,
    financialYearEnd,
    lastAgmDate,
    legalForm,
    name,
    rcnNumber,
    registeredAddress,
    website,
  ]);

  const legalFormOptions = Object.entries(LEGAL_FORM_LABELS);
  const purposeOptions = Object.entries(CHARITABLE_PURPOSE_LABELS);
  const selectedPurposes = Array.from(charitablePurpose);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!name.trim()) errors.push('Organisation name is required.');
    if (saveError) errors.push(saveError);
    return errors;
  }, [name, saveError]);

  const dirtyStateLabel = saving
    ? 'Saving changes'
    : saved
      ? 'Changes saved'
      : isDirty
        ? 'Unsaved changes'
        : 'Up to date';

  const completionItems = [
    { label: 'Registered Charity Number', ready: Boolean(rcnNumber.trim()) },
    { label: 'Legal form', ready: Boolean(legalForm) },
    { label: 'Charitable purpose', ready: charitablePurpose.size > 0 },
    { label: 'Financial year end', ready: Boolean(financialYearEnd) },
    { label: 'Conditional triggers', ready: Boolean(org?.conditionalObligationProfile) },
  ];
  const readyCount = completionItems.filter((item) => item.ready).length;

  const handleComplexityChange = (newComplexity: OrganisationComplexity) => {
    if (newComplexity !== complexity) {
      setComplexity(newComplexity);
      complexityModal.onOpen();
    }
  };

  const handlePurposeChange = (key: string, checked: boolean) => {
    setCharitablePurpose((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleConditionalFactChange = (key: keyof ConditionalObligationProfile, checked: boolean) => {
    setConditionalObligationProfile((current) => ({ ...current, [key]: checked }));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveError('Organisation name is required.');
      return;
    }

    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      const body: UpdateOrganisationRequest = {
        name: name.trim(),
        rcnNumber: rcnNumber.trim() || null,
        croNumber: croNumber.trim() || null,
        legalForm,
        complexity,
        charitablePurpose: selectedPurposes as CharitablePurpose[],
        financialYearEnd: financialYearEnd || null,
        registeredAddress: registeredAddress.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        website: website.trim() || null,
        dateRegistered: dateRegistered || null,
        lastAgmDate: lastAgmDate || null,
        conditionalObligationProfile,
      };

      await api.patch('/organisation', body);
      await refreshUser();
      setIsDirty(false);
      setSaved(true);
      toast('Organisation profile saved');
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      const message = apiErrorMessage(err, 'Failed to save changes');
      logClientError('Save failed', err);
      setSaveError(message);
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

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
        charitablePurpose={charitablePurpose}
        completionItems={completionItems}
        complexity={complexity}
        conditionalObligationProfile={conditionalObligationProfile}
        contactEmail={contactEmail}
        contactPhone={contactPhone}
        croNumber={croNumber}
        dateRegistered={dateRegistered}
        dirtyStateLabel={dirtyStateLabel}
        financialYearEnd={financialYearEnd}
        handleComplexityChange={handleComplexityChange}
        handleConditionalFactChange={handleConditionalFactChange}
        handlePurposeChange={handlePurposeChange}
        handleSave={handleSave}
        isDirty={isDirty}
        lastAgmDate={lastAgmDate}
        legalForm={legalForm}
        legalFormOptions={legalFormOptions}
        name={name}
        purposeOptions={purposeOptions}
        rcnNumber={rcnNumber}
        readyCount={readyCount}
        registeredAddress={registeredAddress}
        saving={saving}
        selectedPurposes={selectedPurposes}
        setContactEmail={setContactEmail}
        setContactPhone={setContactPhone}
        setCroNumber={setCroNumber}
        setDateRegistered={setDateRegistered}
        setFinancialYearEnd={setFinancialYearEnd}
        setLastAgmDate={setLastAgmDate}
        setLegalForm={setLegalForm}
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
