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
import { SaveStatusIndicator } from '@/components/ui/states';
import type { ConditionalObligationProfile } from '@charitypilot/shared';
import {
  CHARITABLE_PURPOSE_LABELS,
  LegalForm,
  OrganisationComplexity,
} from '@charitypilot/shared';
import { OrganisationConditionalProfileFields } from './organisation-conditional-profile';

type CompletionItem = {
  label: string;
  ready: boolean;
};

type OrganisationProfileFormProps = {
  charitablePurpose: Set<string>;
  completionItems: CompletionItem[];
  complexity: OrganisationComplexity;
  conditionalObligationProfile: ConditionalObligationProfile;
  contactEmail: string;
  contactPhone: string;
  croNumber: string;
  dateRegistered: string;
  dirtyStateLabel: string;
  financialYearEnd: string;
  handleComplexityChange: (value: OrganisationComplexity) => void;
  handleConditionalFactChange: (key: keyof ConditionalObligationProfile, checked: boolean) => void;
  handlePurposeChange: (key: string, checked: boolean) => void;
  handleSave: () => void;
  isDirty: boolean;
  lastAgmDate: string;
  legalForm: LegalForm;
  legalFormOptions: Array<[string, string]>;
  name: string;
  purposeOptions: Array<[string, string]>;
  profileSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  rcnNumber: string;
  readyCount: number;
  registeredAddress: string;
  saving: boolean;
  selectedPurposes: string[];
  setContactEmail: (value: string) => void;
  setContactPhone: (value: string) => void;
  setCroNumber: (value: string) => void;
  setDateRegistered: (value: string) => void;
  setFinancialYearEnd: (value: string) => void;
  setLastAgmDate: (value: string) => void;
  setLegalForm: (value: LegalForm) => void;
  setName: (value: string) => void;
  setRcnNumber: (value: string) => void;
  setRegisteredAddress: (value: string) => void;
  setWebsite: (value: string) => void;
  validationErrors: string[];
  website: string;
};

export function OrganisationProfileForm({
  charitablePurpose,
  completionItems,
  complexity,
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
  lastAgmDate,
  legalForm,
  legalFormOptions,
  name,
  purposeOptions,
  profileSaveStatus,
  rcnNumber,
  readyCount,
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
            <RadioGroup
              name="organisation-complexity"
              value={complexity}
              onValueChange={(value) => handleComplexityChange(value as OrganisationComplexity)}
              classNames={{ wrapper: 'grid grid-cols-1 gap-3 sm:grid-cols-2' }}
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

          <OrganisationConditionalProfileFields
            profile={conditionalObligationProfile}
            onChange={handleConditionalFactChange}
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
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{dirtyStateLabel}</span>
            <SaveStatusIndicator status={profileSaveStatus} />
          </div>
          <Button
            className={primaryActionButtonClassName}
            onPress={handleSave}
            isLoading={saving}
            isDisabled={saving || !isDirty || !name.trim()}
          >
            Save profile
          </Button>
        </StickyFormActions>
      </div>
    </AppSection>
  );
}
