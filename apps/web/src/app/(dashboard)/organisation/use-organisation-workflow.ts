'use client';

import { logClientError } from '@/lib/client-logger';
import { toCivilDate } from '@/lib/civil-date';
import {
  confirmationCorrectionValue,
} from '@/lib/confirmation-correction';
import { organisationProfileBlockingErrors } from '@/lib/organisation-profile-validation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDisclosure } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage, isApiForbiddenError } from '@/lib/errors';
import { canManageGovernance } from '@/lib/governance-permissions';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
import type { ConditionalObligationProfile, UpdateOrganisationRequest } from '@charitypilot/shared';
import {
  CHARITABLE_PURPOSE_LABELS,
  CharitablePurpose,
  LEGAL_FORM_LABELS,
  LegalForm,
  OrganisationComplexity,
  updateOrganisationSchema,
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
  const [permissionRevoked, setPermissionRevoked] = useState(false);
  const initialised = useRef(false);
  const canManage = canManageGovernance(user?.role) && !permissionRevoked;

  const [name, setName] = useState('');
  const [rcnNumber, setRcnNumber] = useState('');
  const [croNumber, setCroNumber] = useState('');
  const [legalForm, setLegalForm] = useState<LegalForm | null>(null);
  const [legalFormConfirmed, setLegalFormConfirmed] = useState(false);
  const [complexity, setComplexity] = useState<OrganisationComplexity>(OrganisationComplexity.SIMPLE);
  const [charitablePurpose, setCharitablePurpose] = useState<Set<string>>(new Set());
  const [financialYearEnd, setFinancialYearEnd] = useState('');
  const [registeredAddress, setRegisteredAddress] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [dateRegistered, setDateRegistered] = useState('');
  const [incorporationDate, setIncorporationDate] = useState('');
  const [croAnnualReturnDate, setCroAnnualReturnDateState] = useState('');
  const [croAnnualReturnDateConfirmed, setCroAnnualReturnDateConfirmed] = useState(false);
  const [lastActualAgmDate, setLastActualAgmDate] = useState('');
  const [lastUnanimousAnnualMemberResolutionDate, setLastUnanimousAnnualMemberResolutionDate] = useState('');
  const [memberCount, setMemberCount] = useState('');
  const [conditionalObligationProfile, setConditionalObligationProfile] = useState<ConditionalObligationProfile>(
    EMPTY_CONDITIONAL_OBLIGATION_PROFILE,
  );

  const restorePersistedProfile = useCallback(() => {
    if (!org) return;

    initialised.current = false;
    setName(org.name ?? '');
    setRcnNumber(org.rcnNumber ?? '');
    setCroNumber(org.croNumber ?? '');
    setLegalForm(org.legalForm ?? null);
    setLegalFormConfirmed(Boolean(org.legalForm && org.legalFormConfirmedAt));
    setComplexity(org.complexity ?? OrganisationComplexity.SIMPLE);
    setCharitablePurpose(new Set(org.charitablePurpose ?? []));
    setFinancialYearEnd(toCivilDate(org.financialYearEnd) ?? '');
    setRegisteredAddress(org.registeredAddress ?? '');
    setContactEmail(org.contactEmail ?? '');
    setContactPhone(org.contactPhone ?? '');
    setWebsite(org.website ?? '');
    setDateRegistered(toCivilDate(org.dateRegistered) ?? '');
    setIncorporationDate(toCivilDate(org.incorporationDate) ?? '');
    setCroAnnualReturnDateState(toCivilDate(org.croAnnualReturnDate) ?? '');
    setCroAnnualReturnDateConfirmed(Boolean(org.croAnnualReturnDate && org.croAnnualReturnDateConfirmedAt));
    setLastActualAgmDate(toCivilDate(org.lastActualAgmDate) ?? '');
    setLastUnanimousAnnualMemberResolutionDate(
      toCivilDate(org.lastUnanimousAnnualMemberResolutionDate) ?? '',
    );
    setMemberCount(org.memberCount === null ? '' : String(org.memberCount));
    setConditionalObligationProfile(normaliseConditionalObligationProfile(org.conditionalObligationProfile));
    setIsDirty(false);
    setSaved(false);
    setSaveError('');
    setTimeout(() => {
      initialised.current = true;
    }, 0);
  }, [org]);

  useEffect(() => {
    setPermissionRevoked(false);
  }, [user?.id, user?.role]);

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
    restorePersistedProfile();
  }, [restorePersistedProfile]);

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
    croAnnualReturnDate,
    croAnnualReturnDateConfirmed,
    croNumber,
    dateRegistered,
    financialYearEnd,
    incorporationDate,
    lastActualAgmDate,
    lastUnanimousAnnualMemberResolutionDate,
    legalForm,
    legalFormConfirmed,
    memberCount,
    name,
    rcnNumber,
    registeredAddress,
    website,
  ]);

  const legalFormOptions = Object.entries(LEGAL_FORM_LABELS);
  const purposeOptions = Object.entries(CHARITABLE_PURPOSE_LABELS);
  const selectedPurposes = Array.from(charitablePurpose);

  const formValidationErrors = useMemo(() => {
    const persistedCroAnnualReturnDate = toCivilDate(org?.croAnnualReturnDate) ?? '';
    return organisationProfileBlockingErrors({
      name,
      legalForm,
      persistedLegalForm: org?.legalForm ?? null,
      legalFormConfirmed,
      croAnnualReturnDate,
      persistedCroAnnualReturnDate,
      croAnnualReturnDateConfirmed,
      memberCount,
    });
  }, [croAnnualReturnDate, croAnnualReturnDateConfirmed, legalForm, legalFormConfirmed, memberCount, name, org]);

  const validationErrors = saveError ? [...formValidationErrors, saveError] : formValidationErrors;
  const dirtyStateLabel = isDirty ? 'Unsaved changes' : 'Up to date';
  const profileSaveStatus: 'idle' | 'saving' | 'saved' | 'error' = saving
    ? 'saving'
    : saved
      ? 'saved'
      : saveError
        ? 'error'
        : 'idle';

  const completionItems = [
    { label: 'Registered Charity Number', ready: Boolean(rcnNumber.trim()) },
    { label: 'Legal form confirmed', ready: Boolean(legalForm && legalFormConfirmed) },
    { label: 'Charitable purpose', ready: charitablePurpose.size > 0 },
    { label: 'Financial year end', ready: Boolean(financialYearEnd) },
    ...(legalForm === LegalForm.CLG
      ? [
          { label: 'Incorporation date', ready: Boolean(incorporationDate) },
          { label: 'CRO ARD confirmed', ready: Boolean(croAnnualReturnDate && croAnnualReturnDateConfirmed) },
          { label: 'Member count', ready: Boolean(memberCount) },
        ]
      : []),
    { label: 'Conditional triggers', ready: Boolean(org?.conditionalObligationProfile) },
  ];
  const readyCount = completionItems.filter((item) => item.ready).length;

  const handleComplexityChange = (newComplexity: OrganisationComplexity) => {
    if (!canManage) return;
    if (newComplexity !== complexity) {
      setComplexity(newComplexity);
      complexityModal.onOpen();
    }
  };

  const handleLegalFormChange = (value: LegalForm) => {
    if (!canManage) return;
    setLegalForm(value);
    setLegalFormConfirmed(value === org?.legalForm && Boolean(org.legalFormConfirmedAt));
  };

  const handleCroAnnualReturnDateChange = (value: string) => {
    if (!canManage) return;
    setCroAnnualReturnDateState(value);
    setCroAnnualReturnDateConfirmed(
      value === (toCivilDate(org?.croAnnualReturnDate) ?? '') &&
      Boolean(org?.croAnnualReturnDateConfirmedAt),
    );
  };

  const handlePurposeChange = (key: string, checked: boolean) => {
    if (!canManage) return;
    setCharitablePurpose((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleConditionalFactChange = (key: keyof ConditionalObligationProfile, checked: boolean) => {
    if (!canManage) return;
    setConditionalObligationProfile((current) => ({ ...current, [key]: checked }));
  };

  const handleSave = async () => {
    if (!canManage) {
      setSaveError('Only organisation owners and administrators can update the profile.');
      return;
    }
    if (formValidationErrors.length > 0) {
      setSaveError(formValidationErrors[0]);
      return;
    }
    if (!org?.updatedAt) {
      setSaveError('The organisation version is unavailable. Refresh before saving changes.');
      return;
    }

    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      const body: UpdateOrganisationRequest = {
        expectedUpdatedAt: org.updatedAt,
        name: name.trim(),
        rcnNumber: rcnNumber.trim() || null,
        croNumber: croNumber.trim() || null,
        complexity,
        charitablePurpose: selectedPurposes as CharitablePurpose[],
        registeredAddress: registeredAddress.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        website: website.trim() || null,
        conditionalObligationProfile,
      };

      const originalFinancialYearEnd = toCivilDate(org?.financialYearEnd) ?? '';
      const originalDateRegistered = toCivilDate(org?.dateRegistered) ?? '';
      const originalIncorporationDate = toCivilDate(org?.incorporationDate) ?? '';
      const originalCroAnnualReturnDate = toCivilDate(org?.croAnnualReturnDate) ?? '';
      const originalLastActualAgmDate = toCivilDate(org?.lastActualAgmDate) ?? '';
      const originalLastResolutionDate = toCivilDate(org?.lastUnanimousAnnualMemberResolutionDate) ?? '';
      const originalMemberCount = org?.memberCount === null || org?.memberCount === undefined
        ? ''
        : String(org.memberCount);

      if (legalForm !== (org?.legalForm ?? null)) body.legalForm = legalForm;
      const legalFormConfirmationCorrection = confirmationCorrectionValue(
        legalForm,
        org?.legalForm ?? null,
        legalFormConfirmed,
        org?.legalFormConfirmedAt,
      );
      if (legalFormConfirmationCorrection !== undefined) {
        body.confirmLegalForm = legalFormConfirmationCorrection;
      }
      if (financialYearEnd !== originalFinancialYearEnd) body.financialYearEnd = financialYearEnd || null;
      if (dateRegistered !== originalDateRegistered) body.dateRegistered = dateRegistered || null;
      if (incorporationDate !== originalIncorporationDate) body.incorporationDate = incorporationDate || null;
      if (croAnnualReturnDate !== originalCroAnnualReturnDate) {
        body.croAnnualReturnDate = croAnnualReturnDate || null;
      }
      const croAnnualReturnDateConfirmationCorrection = confirmationCorrectionValue(
        croAnnualReturnDate || null,
        originalCroAnnualReturnDate || null,
        croAnnualReturnDateConfirmed,
        org?.croAnnualReturnDateConfirmedAt,
      );
      if (croAnnualReturnDateConfirmationCorrection !== undefined) {
        body.confirmCroAnnualReturnDate = croAnnualReturnDateConfirmationCorrection;
      }
      if (lastActualAgmDate !== originalLastActualAgmDate) {
        body.lastActualAgmDate = lastActualAgmDate || null;
      }
      if (lastUnanimousAnnualMemberResolutionDate !== originalLastResolutionDate) {
        body.lastUnanimousAnnualMemberResolutionDate = lastUnanimousAnnualMemberResolutionDate || null;
      }
      if (memberCount !== originalMemberCount) body.memberCount = memberCount ? Number(memberCount) : null;

      const parsed = updateOrganisationSchema.safeParse(body);
      if (!parsed.success) {
        setSaveError(parsed.error.issues[0]?.message ?? 'Please check the organisation profile fields.');
        return;
      }

      await api.patch('/organisation', parsed.data);
      await refreshUser();
      setIsDirty(false);
      setSaved(true);
      toast('Organisation profile saved');
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      if (isApiForbiddenError(err)) {
        // Drop the stale write surface immediately; the refreshed session is
        // allowed to update the rendered role only after the page is read-only.
        setPermissionRevoked(true);
        complexityModal.onClose();
        restorePersistedProfile();
        setSaveError('Your role changed. The organisation profile is now read-only.');
        toast('Your permissions changed. The organisation profile is now read-only.', 'error');
        void refreshUser();
        return;
      }
      const message = apiErrorMessage(err, 'Failed to save changes');
      logClientError('Save failed', err);
      setSaveError(message);
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return {
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
    memberCount,
    name,
    org,
    purposeOptions,
    profileSaveStatus,
    rcnNumber,
    readyCount,
    refreshUser,
    registeredAddress,
    saving,
    selectedPurposes,
    setContactEmail: (value: string) => { if (canManage) setContactEmail(value); },
    setContactPhone: (value: string) => { if (canManage) setContactPhone(value); },
    setCroAnnualReturnDateConfirmed: (value: boolean) => { if (canManage) setCroAnnualReturnDateConfirmed(value); },
    setCroNumber: (value: string) => { if (canManage) setCroNumber(value); },
    setDateRegistered: (value: string) => { if (canManage) setDateRegistered(value); },
    setFinancialYearEnd: (value: string) => { if (canManage) setFinancialYearEnd(value); },
    setIncorporationDate: (value: string) => { if (canManage) setIncorporationDate(value); },
    setLastActualAgmDate: (value: string) => { if (canManage) setLastActualAgmDate(value); },
    setLastUnanimousAnnualMemberResolutionDate: (value: string) => {
      if (canManage) setLastUnanimousAnnualMemberResolutionDate(value);
    },
    setLegalFormConfirmed: (value: boolean) => { if (canManage) setLegalFormConfirmed(value); },
    setMemberCount: (value: string) => { if (canManage) setMemberCount(value); },
    setName: (value: string) => { if (canManage) setName(value); },
    setRcnNumber: (value: string) => { if (canManage) setRcnNumber(value); },
    setRegisteredAddress: (value: string) => { if (canManage) setRegisteredAddress(value); },
    setWebsite: (value: string) => { if (canManage) setWebsite(value); },
    validationErrors,
    website,
  };
}
