'use client';

import { Checkbox } from '@heroui/react';
import { FieldGroup } from '@/components/ui/forms';
import { InlineStatus } from '@/components/ui/states';
import { ReviewFlag } from '@/components/ui/status';
import type { ConditionalObligationProfile } from '@charitypilot/shared';

export const EMPTY_CONDITIONAL_OBLIGATION_PROFILE: ConditionalObligationProfile = {
  hasPaidStaff: false,
  hasVolunteers: false,
  raisesFundsFromPublic: false,
  worksWithChildrenOrVulnerableAdults: false,
  processesPersonalData: false,
  operatesPremisesOrEvents: false,
  isPublicSectorBody: false,
  usesDataProcessors: false,
};

const CONDITIONAL_OBLIGATION_FIELDS: Array<{
  key: keyof ConditionalObligationProfile;
  label: string;
  description: string;
}> = [
  {
    key: 'hasPaidStaff',
    label: 'Paid staff or workers',
    description: 'Flags employment, payroll, HR, and protected-disclosures review prompts.',
  },
  {
    key: 'hasVolunteers',
    label: 'Volunteers',
    description: 'Flags volunteer management, induction, supervision, and record-keeping prompts.',
  },
  {
    key: 'raisesFundsFromPublic',
    label: 'Public fundraising',
    description: 'Flags fundraising controls, complaints, third-party fundraiser, and public-trust prompts.',
  },
  {
    key: 'worksWithChildrenOrVulnerableAdults',
    label: 'Children or vulnerable adults',
    description: 'Flags safeguarding and specialist professional review prompts.',
  },
  {
    key: 'processesPersonalData',
    label: 'Personal data processing',
    description: 'Flags GDPR accountability, privacy, retention, and data-rights prompts.',
  },
  {
    key: 'operatesPremisesOrEvents',
    label: 'Premises or events',
    description: 'Flags health and safety, risk assessment, insurance, and incident-record prompts.',
  },
  {
    key: 'isPublicSectorBody',
    label: 'Public-sector body',
    description: 'Flags public-sector or statutory-context review prompts where relevant.',
  },
  {
    key: 'usesDataProcessors',
    label: 'External data processors',
    description: 'Flags processor agreement, transfer, access-control, and supplier-review prompts.',
  },
];

export function normaliseConditionalObligationProfile(
  profile: ConditionalObligationProfile | null | undefined,
): ConditionalObligationProfile {
  return { ...EMPTY_CONDITIONAL_OBLIGATION_PROFILE, ...(profile ?? {}) };
}

export function OrganisationConditionalProfileFields({
  profile,
  onChange,
}: {
  profile: ConditionalObligationProfile;
  onChange: (key: keyof ConditionalObligationProfile, checked: boolean) => void;
}) {
  return (
    <FieldGroup
      title="Conditional obligation triggers"
      description="Record facts that may affect specialist governance prompts. These flags support professional review; they do not decide the legal answer for the charity."
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {CONDITIONAL_OBLIGATION_FIELDS.map((field) => {
          const hintId = `conditional-${field.key}`;
          return (
            <Checkbox
              key={field.key}
              isSelected={profile[field.key]}
              onValueChange={(checked) => onChange(field.key, checked)}
              aria-describedby={hintId}
              classNames={{
                base: 'm-0 flex min-h-24 max-w-none items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 transition-colors hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300 dark:hover:border-gray-700',
                wrapper: 'mt-1',
                label: 'min-w-0',
              }}
            >
              <span>
                <span className="block font-medium text-gray-950 dark:text-gray-50">{field.label}</span>
                <span id={hintId} className="mt-1 block text-xs leading-5 text-gray-600 dark:text-gray-400">
                  {field.description}
                </span>
              </span>
            </Checkbox>
          );
        })}
      </div>
      <InlineStatus tone="warning">
        <ReviewFlag tone="needs-review">Professional review</ReviewFlag>
        <span className="mt-2 block">
          These answers help surface conditional workflows for staff, fundraising, safeguarding, GDPR, premises, public-sector context, and processors. Solicitor, privacy, HR, safeguarding, accounting, or governance review may still be needed.
        </span>
      </InlineStatus>
    </FieldGroup>
  );
}
