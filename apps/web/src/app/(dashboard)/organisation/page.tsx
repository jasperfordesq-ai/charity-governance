'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  Card,
  Button,
  Input,
  Select,
  SelectItem,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth-context';
import type { UpdateOrganisationRequest } from '@charitypilot/shared';
import {
  LegalForm,
  OrganisationComplexity,
  CharitablePurpose,
  LEGAL_FORM_LABELS,
  CHARITABLE_PURPOSE_LABELS,
} from '@charitypilot/shared';

export default function OrganisationPage() {
  useDocumentTitle('Organisation');
  const { user, refreshUser } = useAuth();
  const org = user?.organisation;

  const { toast } = useToast();
  const complexityModal = useDisclosure();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const initialised = useRef(false);

  // Track unsaved changes — warn on navigation
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Form state
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

  // Populate form from existing data
  useEffect(() => {
    if (!org) return;
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
    // Mark initialised so subsequent changes count as dirty
    setTimeout(() => { initialised.current = true; }, 0);
  }, [org]);

  // Track dirty state on any field change after init
  useEffect(() => {
    if (initialised.current) setIsDirty(true);
  }, [name, rcnNumber, croNumber, legalForm, complexity, charitablePurpose, financialYearEnd, registeredAddress, contactEmail, contactPhone, website, dateRegistered, lastAgmDate]);

  /* ── Complexity change handler ── */
  const handleComplexityChange = (newComplexity: OrganisationComplexity) => {
    if (newComplexity !== complexity) {
      setComplexity(newComplexity);
      complexityModal.onOpen();
    }
  };

  /* ── Save ── */
  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const body: UpdateOrganisationRequest = {
        name: name.trim(),
        rcnNumber: rcnNumber.trim() || null,
        croNumber: croNumber.trim() || null,
        legalForm,
        complexity,
        charitablePurpose: Array.from(charitablePurpose) as CharitablePurpose[],
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
      console.error('Save failed', err);
      toast('Failed to save changes', 'error');
    } finally {
      setSaving(false);
    }
  };

  const legalFormOptions = Object.entries(LEGAL_FORM_LABELS);
  const purposeOptions = Object.entries(CHARITABLE_PURPOSE_LABELS);

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Organisation Profile</h1>
        <p className="text-sm text-gray-500 mt-1">
          Keep your organisation details up to date. This information is used for compliance reporting.
        </p>
      </div>

      {/* Form */}
      <Card className="border border-gray-200 shadow-sm p-6 sm:p-8">
        <div className="space-y-6">
          {/* Name & Registration */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Organisation Name"
              value={name}
              onValueChange={setName}
              isRequired
            />
            <Input
              label="Registered Charity Number (RCN)"
              placeholder="e.g. 20012345"
              value={rcnNumber}
              onValueChange={setRcnNumber}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="CRO Number (if CLG)"
              placeholder="e.g. 123456"
              value={croNumber}
              onValueChange={setCroNumber}
            />
            <Select
              label="Legal Form"
              selectedKeys={new Set([legalForm])}
              onSelectionChange={(keys) => {
                const val = Array.from(keys)[0] as LegalForm;
                if (val) setLegalForm(val);
              }}
            >
              {legalFormOptions.map(([key, label]) => (
                <SelectItem key={key}>{label}</SelectItem>
              ))}
            </Select>
          </div>

          {/* Complexity */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Organisation Complexity</label>
            <div className="flex gap-3">
              {[OrganisationComplexity.SIMPLE, OrganisationComplexity.COMPLEX].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => handleComplexityChange(c)}
                  className={`
                    flex-1 p-4 rounded-xl border-2 text-left transition-all
                    ${complexity === c
                      ? 'border-teal-primary bg-teal-primary/5'
                      : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
                >
                  <p className={`text-sm font-semibold ${complexity === c ? 'text-teal-primary' : 'text-gray-700'}`}>
                    {c === OrganisationComplexity.SIMPLE ? 'Simple' : 'Complex'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {c === OrganisationComplexity.SIMPLE
                      ? 'Core standards only (32 standards)'
                      : 'Core + additional standards (49 standards)'}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Charitable purpose (multi-select) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Charitable Purpose(s)
            </label>
            <div className="space-y-2">
              {purposeOptions.map(([key, label]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={charitablePurpose.has(key)}
                    onChange={(e) => {
                      const next = new Set(charitablePurpose);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      setCharitablePurpose(next);
                    }}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-teal-primary focus:ring-teal-primary"
                  />
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>
            {charitablePurpose.size > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Array.from(charitablePurpose).map((key) => (
                  <Chip
                    key={key}
                    size="sm"
                    variant="flat"
                    color="primary"
                    onClose={() => {
                      const next = new Set(charitablePurpose);
                      next.delete(key);
                      setCharitablePurpose(next);
                    }}
                  >
                    {CHARITABLE_PURPOSE_LABELS[key] ?? key}
                  </Chip>
                ))}
              </div>
            )}
          </div>

          {/* Financial year end */}
          <Input
            label="Financial Year End Date"
            type="date"
            value={financialYearEnd}
            onValueChange={setFinancialYearEnd}
          />

          {/* Address & contact */}
          <Input
            label="Registered Address"
            placeholder="Full address..."
            value={registeredAddress}
            onValueChange={setRegisteredAddress}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Contact Email"
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Date Registered with CRA"
              type="date"
              value={dateRegistered}
              onValueChange={setDateRegistered}
            />
            <Input
              label="Last AGM Date"
              type="date"
              value={lastAgmDate}
              onValueChange={setLastAgmDate}
            />
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              className="bg-teal-primary text-white hover:bg-teal-dark"
              onPress={handleSave}
              isLoading={saving}
              isDisabled={!name.trim()}
              size="lg"
            >
              Save Changes
            </Button>
            {saved && (
              <span className="text-sm text-green-600 font-medium">Changes saved successfully.</span>
            )}
            {isDirty && !saved && !saving && (
              <span className="text-sm text-amber-600 font-medium">Unsaved changes</span>
            )}
          </div>
        </div>
      </Card>

      {/* ── Complexity Explanation Modal ── */}
      <Modal isOpen={complexityModal.isOpen} onOpenChange={complexityModal.onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Organisation Complexity</ModalHeader>
              <ModalBody>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-1">Simple Organisations</h3>
                    <p className="text-sm text-gray-600">
                      Most charities fall into this category. Simple organisations need to comply with the
                      <strong> 32 core standards</strong> of the Charities Governance Code. This is the default for
                      charities with straightforward operations, smaller budgets, and fewer staff or volunteers.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-1">Complex Organisations</h3>
                    <p className="text-sm text-gray-600">
                      Larger charities or those with complex activities should comply with both the core standards
                      and the <strong>17 additional standards</strong> (49 total). Consider this where your
                      charity has paid staff, significant income, multiple activities, complex structures, or higher risk.
                    </p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p className="text-sm text-amber-800">
                      <strong>Note:</strong> Changing complexity will affect which standards appear in your compliance
                      tracking. Your existing records will not be deleted.
                    </p>
                  </div>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button
                  className="bg-teal-primary text-white hover:bg-teal-dark"
                  onPress={onClose}
                >
                  Got it
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
