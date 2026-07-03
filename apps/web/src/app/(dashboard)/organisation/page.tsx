'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { FieldGroup, FormHint, StickyFormActions, ValidationSummary } from '@/components/ui/forms';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ReviewFlag, StatusChip } from '@/components/ui/status';
import type { UpdateOrganisationRequest } from '@charitypilot/shared';
import {
  CHARITABLE_PURPOSE_LABELS,
  CharitablePurpose,
  LEGAL_FORM_LABELS,
  LegalForm,
  OrganisationComplexity,
} from '@charitypilot/shared';

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
      <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <ReviewFlag tone="draft">First setup step</ReviewFlag>
            <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">
              Make the charity profile easy to review before annual reporting.
            </h2>
            <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Clear RCN, CRO, legal form, purpose, and financial year end details help trustees understand what the system is using.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:min-w-[28rem]">
            {completionItems.map((item) => (
              <div key={item.label} className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
                <p className="text-xs text-gray-500 dark:text-gray-400">{item.label}</p>
                <StatusChip tone={item.ready ? 'success' : 'warning'}>{item.ready ? 'Set' : 'Review'}</StatusChip>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AppSection
        title="Profile fields"
        description={`${readyCount} of ${completionItems.length} setup fields are ready for operational review.`}
      >
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="space-y-7 p-4 sm:p-6">
            <ValidationSummary errors={validationErrors} />

            <FieldGroup
              title="Legal identity"
              description="Use the charity's registered name and identifiers exactly as trustees expect to see them in reports."
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Organisation name"
                  value={name}
                  onValueChange={setName}
                  isRequired
                />
                <div>
                  <Input
                    label="Registered Charity Number (RCN)"
                    placeholder="20012345"
                    value={rcnNumber}
                    onValueChange={setRcnNumber}
                    aria-describedby="rcn-hint"
                  />
                  <FormHint id="rcn-hint">Enter the Registered Charity Number used in public charity materials.</FormHint>
                </div>
                <div>
                  <Input
                    label="CRO number"
                    placeholder="123456"
                    value={croNumber}
                    onValueChange={setCroNumber}
                    aria-describedby="cro-hint"
                  />
                  <FormHint id="cro-hint">Use this where the charity is a company limited by guarantee or otherwise has a CRO number.</FormHint>
                </div>
                <Select
                  label="Legal form"
                  selectedKeys={new Set([legalForm])}
                  onSelectionChange={(keys) => {
                    const value = Array.from(keys)[0] as LegalForm | undefined;
                    if (value) setLegalForm(value);
                  }}
                >
                  {legalFormOptions.map(([key, label]) => (
                    <SelectItem key={key}>{label}</SelectItem>
                  ))}
                </Select>
              </div>
            </FieldGroup>

            <FieldGroup
              title="Governance scope"
              description="Complexity controls whether the additional Governance Code standards appear in compliance workflows."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[OrganisationComplexity.SIMPLE, OrganisationComplexity.COMPLEX].map((value) => {
                  const selected = complexity === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleComplexityChange(value)}
                      className={`rounded-lg border p-4 text-left transition-colors ${selected ? 'border-teal-primary bg-teal-primary/10 dark:border-teal-bright dark:bg-teal-bright/10' : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700'}`}
                      aria-pressed={selected}
                    >
                      <span className={`text-sm font-semibold ${selected ? 'text-teal-dark dark:text-teal-bright' : 'text-gray-950 dark:text-gray-50'}`}>
                        {value === OrganisationComplexity.SIMPLE ? 'Simple' : 'Complex'}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-gray-600 dark:text-gray-300">
                        {value === OrganisationComplexity.SIMPLE
                          ? 'Core standards only. This is suitable for many smaller or straightforward charities.'
                          : 'Core plus additional standards for charities with larger, higher-risk, or more complex operations.'}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Charitable purpose</p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {purposeOptions.map(([key, label]) => (
                    <label key={key} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm text-gray-700 dark:border-gray-800 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={charitablePurpose.has(key)}
                        onChange={(event) => handlePurposeChange(key, event.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary dark:border-gray-700 dark:bg-gray-900"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {selectedPurposes.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedPurposes.map((key) => (
                      <StatusChip key={key} tone="brand">
                        {CHARITABLE_PURPOSE_LABELS[key] ?? key}
                      </StatusChip>
                    ))}
                  </div>
                ) : (
                  <FormHint tone="warning">Choose at least one purpose so reports can describe the charity clearly.</FormHint>
                )}
              </div>
            </FieldGroup>

            <FieldGroup
              title="Reporting calendar"
              description="The financial year end is used to support annual reporting and deadline generation."
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Input
                    label="Financial year end"
                    type="date"
                    value={financialYearEnd}
                    onValueChange={setFinancialYearEnd}
                    aria-describedby="financial-year-hint"
                  />
                  <FormHint id="financial-year-hint">Use the financial year end that drives Annual Report timing and board review planning.</FormHint>
                </div>
                <Input
                  label="Date registered with CRA"
                  type="date"
                  value={dateRegistered}
                  onValueChange={setDateRegistered}
                />
                <Input
                  label="Last AGM date"
                  type="date"
                  value={lastAgmDate}
                  onValueChange={setLastAgmDate}
                />
              </div>
            </FieldGroup>

            <FieldGroup
              title="Contact details"
              description="These details help exported records remain understandable to trustees and administrators."
            >
              <Input
                label="Registered address"
                placeholder="Full registered address"
                value={registeredAddress}
                onValueChange={setRegisteredAddress}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Contact email"
                  type="email"
                  placeholder="info@mycharity.ie"
                  value={contactEmail}
                  onValueChange={setContactEmail}
                />
                <Input
                  label="Phone"
                  placeholder="+353 1 234 5678"
                  value={contactPhone}
                  onValueChange={setContactPhone}
                />
              </div>
              <Input
                label="Website"
                placeholder="https://www.mycharity.ie"
                value={website}
                onValueChange={setWebsite}
              />
            </FieldGroup>
          </div>

          <StickyFormActions align="between">
            <div aria-live="polite" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {dirtyStateLabel}
            </div>
            <Button
              className="bg-teal-primary text-white hover:bg-teal-dark"
              onPress={handleSave}
              isLoading={saving}
              isDisabled={saving || !isDirty || !name.trim()}
            >
              Save profile
            </Button>
          </StickyFormActions>
        </div>
      </AppSection>

      <Modal isOpen={complexityModal.isOpen} onOpenChange={complexityModal.onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Organisation complexity</ModalHeader>
              <ModalBody className="gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">Simple organisations</h3>
                  <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                    Simple organisations usually track the 32 core standards. This is often appropriate for smaller charities with straightforward operations.
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-50">Complex organisations</h3>
                  <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                    Complex organisations track the core standards plus the 17 additional standards. Consider this for larger, higher-risk, staffed, or multi-activity charities.
                  </p>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                  <p className="text-sm leading-6 text-amber-900 dark:text-amber-100">
                    Changing this setting affects which standards appear. Existing records are retained. Treat this as a governance setup choice, not legal advice.
                  </p>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button className="bg-teal-primary text-white hover:bg-teal-dark" onPress={onClose}>
                  Got it
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </AppPage>
  );
}
