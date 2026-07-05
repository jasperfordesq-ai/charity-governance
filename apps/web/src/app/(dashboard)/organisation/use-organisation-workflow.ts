'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
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

export function useOrganisationWorkflow() {
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

  return {
    charitablePurpose,
    completionItems,
    complexity,
    complexityModal,
    conditionalObligationProfile,
    contactEmail,
    contactPhone,
    croNumber,
    dateRegistered,
    dirtyStateLabel,
    financialYearEnd,
    handleComplexityChange,
    handleConditionalFactChange,
    handlePurposeChange,
    handleSave,
    isDirty,
    isLoading,
    lastAgmDate,
    legalForm,
    legalFormOptions,
    name,
    org,
    purposeOptions,
    rcnNumber,
    readyCount,
    refreshUser,
    registeredAddress,
    saving,
    selectedPurposes,
    setContactEmail,
    setContactPhone,
    setCroNumber,
    setDateRegistered,
    setFinancialYearEnd,
    setLastAgmDate,
    setLegalForm,
    setName,
    setRcnNumber,
    setRegisteredAddress,
    setWebsite,
    validationErrors,
    website,
  };
}
