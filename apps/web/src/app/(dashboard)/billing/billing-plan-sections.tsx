'use client';

import { Button } from '@heroui/react';
import { Check, ChevronDown } from 'lucide-react';
import { AppSection } from '@/components/ui/app-page';
import { primaryActionButtonClassName } from '@/components/ui/action-button';
import { StatusChip, StatusTile } from '@/components/ui/status';
import type { BillingStatusResponse } from '@charitypilot/shared';
import { SubscriptionPlan } from '@charitypilot/shared';

const PLANS = [
  {
    plan: SubscriptionPlan.ESSENTIALS,
    name: 'Essentials',
    monthlyPrice: 19,
    yearlyPrice: 190,
    summary: 'Core Governance Code workflows for non-complex charities.',
    features: [
      '32 core standards for non-complex charities',
      'Compliance Record Form fields and board sign-off',
      'Evidence vault with governance document metadata',
      'Board member and trustee readiness register',
      'Annual Report deadline tracker and reminders',
      'PDF compliance report export',
      'Email support',
    ],
  },
  {
    plan: SubscriptionPlan.COMPLETE,
    name: 'Complete',
    monthlyPrice: 39,
    yearlyPrice: 390,
    summary: 'Expanded operational registers and additional standards for more complex governance work.',
    features: [
      'Everything in Essentials, plus:',
      'All 49 standards for complex charities',
      'Unlimited team members and role permissions',
      'Conflict, risk, complaints, and fundraising registers',
      'Financial controls and Annual Report readiness',
      'Evidence pack reporting for board review',
      'Priority email support',
    ],
  },
];

export function BillingPlanSections({
  billing,
  billingConfigured,
  checkoutLoading,
  isActive,
  onCheckout,
}: {
  billing: BillingStatusResponse | null;
  billingConfigured: boolean;
  checkoutLoading: string | null;
  isActive: boolean;
  onCheckout: (plan: SubscriptionPlan, interval: 'monthly' | 'yearly') => void | Promise<void>;
}) {
  return (
    <>
      <AppSection
        title="Complete-only register gates"
        description="Essentials covers the core Governance Code workflow. Complete adds dense operational registers and readiness records; it does not replace trustee judgement or professional advice."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <StatusTile title="Essentials" detail="Compliance, documents, board register, deadlines, and export workflows." tone="brand" />
          <StatusTile title="Complete" detail="Conflicts, risks, complaints, fundraising, financial controls, and Annual Report readiness." tone="success" />
          <StatusTile title="Review prompts" detail="Professional review may still be needed for accounting, legal form, staff, data, safeguarding, or fundraising context." tone="warning" />
        </div>
      </AppSection>

      <AppSection
        title={isActive ? 'Plans' : 'Choose a plan'}
        description="Prices are shown before Stripe checkout. The checkout and portal redirects are accepted only from trusted Stripe-hosted URLs."
      >
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {PLANS.map((plan) => {
            const isCurrent = billing?.plan === plan.plan && isActive;
            const yearlyKey = `${plan.plan}-yearly`;
            const monthlyKey = `${plan.plan}-monthly`;

            return (
              <article
                key={plan.plan}
                className={`relative rounded-lg border bg-white p-5 shadow-sm dark:bg-gray-900 ${
                  isCurrent
                    ? 'border-teal-primary dark:border-teal-bright'
                    : 'border-gray-200 dark:border-gray-800'
                }`}
              >
                {isCurrent ? (
                  <div className="absolute right-3 top-3">
                    <StatusChip tone="success">Current plan</StatusChip>
                  </div>
                ) : null}

                <div className="pr-24">
                  <h3 className="text-lg font-semibold text-gray-950 dark:text-gray-50">{plan.name}</h3>
                  <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{plan.summary}</p>
                </div>

                <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold text-gray-950 dark:text-gray-50">&euro;{plan.monthlyPrice}</span>
                    <span className="text-sm text-gray-600 dark:text-gray-300">/month</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    or &euro;{plan.yearlyPrice}/year, saving {Math.round((1 - plan.yearlyPrice / (plan.monthlyPrice * 12)) * 100)}%
                  </p>
                </div>

                <ul className="mt-5 space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
                      <Check className="mt-1 h-4 w-4 shrink-0 text-teal-primary dark:text-teal-bright" aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-5 flex flex-col gap-2">
                  <Button
                    className={primaryActionButtonClassName}
                    fullWidth
                    onPress={() => onCheckout(plan.plan, 'yearly')}
                    isLoading={checkoutLoading === yearlyKey}
                    isDisabled={isCurrent || !billingConfigured || Boolean(checkoutLoading)}
                  >
                    {isCurrent ? 'Current plan' : `Get ${plan.name} yearly`}
                  </Button>
                  <Button
                    variant="bordered"
                    fullWidth
                    onPress={() => onCheckout(plan.plan, 'monthly')}
                    isLoading={checkoutLoading === monthlyKey}
                    isDisabled={isCurrent || !billingConfigured || Boolean(checkoutLoading)}
                  >
                    {isCurrent ? 'Current plan' : `Monthly (\u20ac${plan.monthlyPrice}/mo)`}
                  </Button>
                </div>

                {!billingConfigured ? (
                  <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    Checkout is disabled until billing setup is available.
                  </p>
                ) : isCurrent ? (
                  <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    This is the current plan for the workspace.
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      </AppSection>

      <AppSection title="Billing notes" description="Operational details for subscription changes and Stripe-hosted account management.">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[
            {
              q: 'Can I cancel at any time?',
              a: 'Yes. Use the Stripe customer portal when billing is configured. Access remains governed by the current subscription period returned by Stripe.',
            },
            {
              q: 'What payment methods are supported?',
              a: 'Stripe handles supported cards and payment methods in its hosted checkout for this account.',
            },
            {
              q: 'Can I switch plans?',
              a: 'Plan changes are started through checkout or the customer portal, then reflected after the billing status refreshes.',
            },
            {
              q: 'Does Complete guarantee compliance?',
              a: 'No. Complete adds operational registers and review prompts, but the board remains responsible for decisions and professional advice where needed.',
            },
          ].map(({ q, a }) => (
            <details key={q} className="group rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
              <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800">
                {q}
                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="px-4 pb-4 text-sm leading-6 text-gray-600 dark:text-gray-300">{a}</p>
            </details>
          ))}
        </div>
      </AppSection>
    </>
  );
}
