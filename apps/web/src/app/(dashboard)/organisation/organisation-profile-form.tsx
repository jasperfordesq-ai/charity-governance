'use client';

import {
  Button,
  Checkbox,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
} from '@heroui/react';
import { AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { FieldGroup, FormHint, StickyFormActions, ValidationSummary } from '@/components/ui/forms';
import { StatusChip, statusPanelClassName } from '@/components/ui/status';
import { PermissionHint, SaveStatusIndicator } from '@/components/ui/states';
import type { ConditionalObligationProfile } from '@charitypilot/shared';
import {
  CHARITABLE_PURPOSE_LABELS,
  LegalForm,
  MAX_ORGANISATION_MEMBER_COUNT,
  OrganisationComplexity,
} from '@charitypilot/shared';
import { OrganisationConditionalProfileFields } from './organisation-conditional-profile';

type CompletionItem = {
  label: string;
  ready: boolean;
};

type OrganisationProfileFormProps = {
  canManage: boolean;
  charitablePurpose: Set<string>;
  completionItems: CompletionItem[];
  complexity: OrganisationComplexity;
  conditionalObligationProfile: ConditionalObligationProfile;
  contactEmail: string;
  contactPhone: string;
  croAnnualReturnDate: string;
  croAnnualReturnDateConfirmed: boolean;
  croNumber: string;
  dateRegistered: string;
  dirtyStateLabel: string;
  financialYearEnd: string;
  formValidationErrors: string[];
  handleComplexityChange: (value: OrganisationComplexity) => void;
  handleConditionalFactChange: (key: keyof ConditionalObligationProfile, checked: boolean) => void;
  handleCroAnnualReturnDateChange: (value: string) => void;
  handleLegalFormChange: (value: LegalForm) => void;
  handlePurposeChange: (key: string, checked: boolean) => void;
  handleSave: () => void;
  isDirty: boolean;
  incorporationDate: string;
  lastActualAgmDate: string;
  lastUnanimousAnnualMemberResolutionDate: string;
  legalForm: LegalForm | null;
  legalFormConfirmed: boolean;
  legalFormOptions: Array<[string, string]>;
  name: string;
  memberCount: string;
  purposeOptions: Array<[string, string]>;
  profileSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  rcnNumber: string;
  readyCount: number;
  registeredAddress: string;
  saving: boolean;
  selectedPurposes: string[];
  setContactEmail: (value: string) => void;
  setContactPhone: (value: string) => void;
  setCroAnnualReturnDateConfirmed: (value: boolean) => void;
  setCroNumber: (value: string) => void;
  setDateRegistered: (value: string) => void;
  setFinancialYearEnd: (value: string) => void;
  setIncorporationDate: (value: string) => void;
  setLastActualAgmDate: (value: string) => void;
  setLastUnanimousAnnualMemberResolutionDate: (value: string) => void;
  setLegalFormConfirmed: (value: boolean) => void;
  setMemberCount: (value: string) => void;
  setName: (value: string) => void;
  setRcnNumber: (value: string) => void;
  setRegisteredAddress: (value: string) => void;
  setWebsite: (value: string) => void;
  validationErrors: string[];
  website: string;
};

export function OrganisationProfileForm({
  canManage,
  charitablePurpose,
  completionItems,
  complexity,
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
  isDirty,
  incorporationDate,
  lastActualAgmDate,
  lastUnanimousAnnualMemberResolutionDate,
  legalForm,
  legalFormConfirmed,
  legalFormOptions,
  name,
  memberCount,
  purposeOptions,
  profileSaveStatus,
  rcnNumber,
  readyCount,
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
}: OrganisationProfileFormProps) {
  return (
    <AppSection
      title="Profile fields"
      description={`${readyCount} of ${completionItems.length} setup fields are ready for operational review.`}
    >
      <div className={statusPanelClassName('neutral', 'overflow-hidden')}>
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
                isReadOnly={!canManage}
              />
              <div>
                <Input
                  label="Registered Charity Number (RCN)"
                  placeholder="20012345"
                  value={rcnNumber}
                  onValueChange={setRcnNumber}
                  isReadOnly={!canManage}
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
                  isReadOnly={!canManage}
                  aria-describedby="cro-hint"
                />
                <FormHint id="cro-hint">Use this where the charity is a company limited by guarantee or otherwise has a CRO number.</FormHint>
              </div>
              <Select
                label="Legal form"
                selectedKeys={legalForm ? new Set([legalForm]) : new Set()}
                placeholder="Choose the confirmed legal form"
                isDisabled={!canManage}
                classNames={{ value: 'text-gray-700 dark:text-gray-300' }}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as LegalForm | undefined;
                  if (value) handleLegalFormChange(value);
                }}
              >
                {legalFormOptions.map(([key, label]) => (
                  <SelectItem key={key}>{label}</SelectItem>
                ))}
              </Select>
              <div className="sm:col-span-2">
                <Checkbox
                  isSelected={legalFormConfirmed}
                  onValueChange={setLegalFormConfirmed}
                  isDisabled={!canManage || !legalForm}
                  aria-describedby="legal-form-confirmation-hint"
                >
                  I have checked this legal form against the organisation&apos;s governing and registration records.
                </Checkbox>
                <FormHint id="legal-form-confirmation-hint" tone={legalFormConfirmed ? 'neutral' : 'warning'}>
                  CharityPilot does not infer legal form. Clearing this confirmation supersedes current derived company dates until the legal form is reconfirmed.
                </FormHint>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup
            title="Governance scope"
            description="Complexity controls whether the additional Governance Code standards appear in compliance workflows."
          >
            <RadioGroup
              name="organisation-complexity"
              value={complexity}
              onValueChange={(value) => handleComplexityChange(value as OrganisationComplexity)}
              classNames={{ wrapper: 'grid grid-cols-1 gap-3 sm:grid-cols-2' }}
              isDisabled={!canManage}
            >
              {[OrganisationComplexity.SIMPLE, OrganisationComplexity.COMPLEX].map((value) => (
                <Radio
                  key={value}
                  value={value}
                  description={value === OrganisationComplexity.SIMPLE
                    ? 'Core standards only. This is suitable for many smaller or straightforward charities.'
                    : 'Core plus additional standards for charities with larger, higher-risk, or more complex operations.'}
                  classNames={{
                    base: 'm-0 flex max-w-none items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300 data-[selected=true]:border-teal-primary data-[selected=true]:bg-teal-primary/10 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700 dark:data-[selected=true]:border-teal-bright dark:data-[selected=true]:bg-teal-bright/10',
                    wrapper: 'mt-0.5',
                    labelWrapper: 'min-w-0',
                    label: 'text-sm font-semibold text-gray-950 dark:text-gray-50',
                    description: 'mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300',
                  }}
                >
                  {value === OrganisationComplexity.SIMPLE ? 'Simple' : 'Complex'}
                </Radio>
              ))}
            </RadioGroup>
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Charitable purpose</p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {purposeOptions.map(([key, label]) => (
                  <Checkbox
                    key={key}
                    isSelected={charitablePurpose.has(key)}
                    onValueChange={(checked) => handlePurposeChange(key, checked)}
                    isDisabled={!canManage}
                    classNames={{
                      base: 'm-0 flex max-w-none items-start gap-3 rounded-lg border border-gray-200 p-3 transition-colors hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700',
                      wrapper: 'mt-0.5',
                      label: 'text-sm text-gray-700 dark:text-gray-300',
                    }}
                  >
                    {label}
                  </Checkbox>
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
                  isReadOnly={!canManage}
                  aria-describedby="financial-year-hint"
                />
                <FormHint id="financial-year-hint">Use the financial year end that drives Annual Report timing and board review planning.</FormHint>
              </div>
              <Input
                label="Date registered with CRA"
                type="date"
                value={dateRegistered}
                onValueChange={setDateRegistered}
                isReadOnly={!canManage}
              />
            </div>
          </FieldGroup>

          {legalForm === LegalForm.CLG ? (
            <FieldGroup
              title="Company calendar facts"
              description="Copy these facts from the company records and CRO CORE. Calculated dates are planning prompts until the authoritative portal or a professional confirms them."
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Incorporation date"
                  type="date"
                  value={incorporationDate}
                  onValueChange={setIncorporationDate}
                  isReadOnly={!canManage}
                  aria-describedby="incorporation-date-hint"
                />
                <Input
                  label="Member count"
                  type="number"
                  min={1}
                  max={MAX_ORGANISATION_MEMBER_COUNT}
                  inputMode="numeric"
                  value={memberCount}
                  onValueChange={setMemberCount}
                  isReadOnly={!canManage}
                  aria-describedby="member-count-hint"
                />
                <Input
                  label="CRO Annual Return Date (ARD)"
                  type="date"
                  value={croAnnualReturnDate}
                  onValueChange={handleCroAnnualReturnDateChange}
                  isReadOnly={!canManage}
                  aria-describedby="cro-ard-hint"
                />
                <Input
                  label="Last actual AGM date"
                  type="date"
                  value={lastActualAgmDate}
                  onValueChange={setLastActualAgmDate}
                  isReadOnly={!canManage}
                  aria-describedby="actual-agm-hint"
                />
                <Input
                  label="Last unanimous annual written-resolution date"
                  type="date"
                  value={lastUnanimousAnnualMemberResolutionDate}
                  onValueChange={setLastUnanimousAnnualMemberResolutionDate}
                  isReadOnly={!canManage}
                  aria-describedby="written-resolution-hint"
                  className="sm:col-span-2"
                />
              </div>
              <FormHint id="incorporation-date-hint">Use the company incorporation date, not the charity registration date.</FormHint>
              <FormHint id="member-count-hint">Member count affects which annual member-action routes may be available; it does not itself prove that an AGM can be dispensed with.</FormHint>
              <div>
                <Checkbox
                  isSelected={croAnnualReturnDateConfirmed}
                  onValueChange={setCroAnnualReturnDateConfirmed}
                  isDisabled={!canManage || !croAnnualReturnDate}
                  aria-describedby="cro-ard-hint"
                >
                  I copied this exact current ARD from CRO CORE.
                </Checkbox>
                <FormHint id="cro-ard-hint" tone={croAnnualReturnDateConfirmed ? 'neutral' : 'warning'}>
                  ARD can change. Clearing this confirmation supersedes current derived CRO dates until the ARD is reconfirmed from CORE. Never infer the current ARD from incorporation.
                </FormHint>
              </div>
              <FormHint id="actual-agm-hint">Record only an AGM that actually took place.</FormHint>
              <FormHint id="written-resolution-hint">Keep a unanimous written-resolution event separate; it must never overwrite the last actual AGM date.</FormHint>
            </FieldGroup>
          ) : null}

          <OrganisationConditionalProfileFields
            profile={conditionalObligationProfile}
            onChange={handleConditionalFactChange}
            isDisabled={!canManage}
          />

          <FieldGroup
            title="Contact details"
            description="These details help exported records remain understandable to trustees and administrators."
          >
            <Input
              label="Registered address"
              placeholder="Full registered address"
              value={registeredAddress}
              onValueChange={setRegisteredAddress}
              isReadOnly={!canManage}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Contact email"
                type="email"
                placeholder="info@mycharity.ie"
                value={contactEmail}
                onValueChange={setContactEmail}
                isReadOnly={!canManage}
              />
              <Input
                label="Phone"
                placeholder="+353 1 234 5678"
                value={contactPhone}
                onValueChange={setContactPhone}
                isReadOnly={!canManage}
              />
            </div>
            <Input
              label="Website"
              placeholder="https://www.mycharity.ie"
              value={website}
              onValueChange={setWebsite}
              isReadOnly={!canManage}
            />
          </FieldGroup>
        </div>

        <StickyFormActions align="between">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{dirtyStateLabel}</span>
            <SaveStatusIndicator status={profileSaveStatus} />
          </div>
          {canManage ? (
            <Button
              className={primaryActionButtonClassName}
              onPress={handleSave}
              isLoading={saving}
              isDisabled={saving || !isDirty || formValidationErrors.length > 0}
            >
              Save profile
            </Button>
          ) : (
            <PermissionHint>Organisation profile changes are available to owners and administrators.</PermissionHint>
          )}
        </StickyFormActions>
      </div>
    </AppSection>
  );
}
