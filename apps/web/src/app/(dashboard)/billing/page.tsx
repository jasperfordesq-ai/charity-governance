'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { getTrustedStripeRedirectUrl } from '@/lib/url-security';
import { AppPage, AppSection } from '@/components/ui/app-page';
import { ErrorState, LoadingState, ReviewWarningState } from '@/components/ui/states';
import { ReviewFlag, StatusChip, StatusTile } from '@/components/ui/status';
import type { BillingStatusResponse } from '@charitypilot/shared';
import { SubscriptionPlan, SubscriptionStatus } from '@charitypilot/shared';

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

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

export default function BillingPage() {
  useDocumentTitle('Billing');
  const [billing, setBilling] = useState<BillingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  const fetchBilling = useCallback(async () => {
    try {
      const res = await api.get('/billing/status');
      setBilling(res.data);
      setBillingError(null);
    } catch (err) {
      logClientError('Failed to load billing', err);
      setBillingError('Billing status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBilling();
  }, [fetchBilling]);

  const startCheckout = async (plan: SubscriptionPlan, interval: 'monthly' | 'yearly') => {
    const key = `${plan}-${interval}`;
    setCheckoutLoading(key);
    setBillingError(null);
    try {
      const res = await api.post('/billing/checkout', { plan, interval });
      const redirectUrl = getTrustedStripeRedirectUrl(res.data?.url);
      if (!redirectUrl) {
        setBillingError('Checkout returned an unexpected redirect URL.');
        return;
      }
      window.location.assign(redirectUrl);
    } catch (err: unknown) {
      logClientError('Checkout failed', err);
      setBillingError(apiErrorMessage(err, 'Checkout could not be started.'));
    } finally {
      setCheckoutLoading(null);
    }
  };

  const openPortal = async () => {
    setPortalLoading(true);
    setBillingError(null);
    try {
      const res = await api.post('/billing/portal');
      const redirectUrl = getTrustedStripeRedirectUrl(res.data?.url);
      if (!redirectUrl) {
        setBillingError('The Stripe customer portal returned an unexpected redirect URL.');
        return;
      }
      window.location.assign(redirectUrl);
    } catch (err: unknown) {
      logClientError('Portal failed', err);
      setBillingError(apiErrorMessage(err, 'The Stripe customer portal could not be opened.'));
    } finally {
      setPortalLoading(false);
    }
  };

  const statusChip = () => {
    if (!billing?.status) return <StatusChip tone="neutral">No subscription</StatusChip>;
    const map: Record<string, { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
      [SubscriptionStatus.ACTIVE]: { tone: 'success', label: 'Active subscription' },
      [SubscriptionStatus.TRIALING]: { tone: 'warning', label: 'Free trial' },
      [SubscriptionStatus.PAST_DUE]: { tone: 'danger', label: 'Payment issue' },
      [SubscriptionStatus.CANCELLED]: { tone: 'neutral', label: 'Cancelled' },
      [SubscriptionStatus.EXPIRED]: { tone: 'neutral', label: 'Expired' },
    };
    const meta = map[billing.status] ?? { tone: 'neutral' as const, label: billing.status };
    return <StatusChip tone={meta.tone}>{meta.label}</StatusChip>;
  };

  const isTrialing = billing?.status === SubscriptionStatus.TRIALING;
  const isActive = billing?.status === SubscriptionStatus.ACTIVE;
  const billingConfigured = billing?.billingConfigured ?? false;
  const currentPlanName = billing?.plan === SubscriptionPlan.COMPLETE ? 'Complete' : billing?.plan === SubscriptionPlan.ESSENTIALS ? 'Essentials' : 'No active plan';

  return (
    <AppPage
      eyebrow="Subscription"
      title="Billing & Subscription"
      description="Manage the plan that controls governance coverage, evidence storage, reminders, team access, and Complete-only register gates."
    >
      <div aria-live="polite" className="sr-only">
        {billingError ?? (checkoutLoading ? 'Preparing Stripe checkout' : portalLoading ? 'Opening Stripe portal' : 'Billing ready')}
      </div>

      {billingError ? (
        <ErrorState
          title="Billing needs attention"
          description={billingError}
          action={(
            <Button size="sm" variant="flat" onPress={fetchBilling}>
              Refresh billing
            </Button>
          )}
        />
      ) : null}

      {!loading && !billingConfigured ? (
        <div id="provider-degraded">
          <ReviewWarningState
            title="Billing setup is temporarily unavailable"
            description="Checkout and portal actions are disabled while the payment provider is not configured. Existing access is shown from the current billing status. Please contact support to change your plan."
          />
        </div>
      ) : null}

      {loading ? (
        <LoadingState title="Loading billing" description="Checking subscription status and available plan actions." />
      ) : (
        <>
          <section className="rounded-lg border border-teal-primary/20 bg-white p-5 shadow-sm dark:border-teal-light/20 dark:bg-gray-900">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-3xl">
                <div className="flex flex-wrap gap-2">
                  {statusChip()}
                  <ReviewFlag tone={billingConfigured ? 'draft' : 'needs-review'}>
                    {billingConfigured ? 'Stripe actions available' : 'Provider-degraded'}
                  </ReviewFlag>
                </div>
                <h2 className="mt-3 text-lg font-semibold text-gray-950 dark:text-gray-50">Current plan</h2>
                <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                  {billing?.plan ? (
                    <>You are on the <strong>{currentPlanName}</strong> plan.</>
                  ) : (
                    <>No active subscription is attached to this workspace.</>
                  )}
                </p>

                {isTrialing && billing?.trialEndsAt ? (
                  <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
                    Trial ends on <strong>{formatDate(billing.trialEndsAt)}</strong>.
                  </p>
                ) : null}

                {isActive && billing?.currentPeriodEnd ? (
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                    Current period ends {formatDate(billing.currentPeriodEnd)}.
                  </p>
                ) : null}
              </div>

              {isActive ? (
                <Button
                  variant="bordered"
                  onPress={openPortal}
                  isLoading={portalLoading}
                  isDisabled={!billingConfigured || portalLoading}
                >
                  Manage subscription
                </Button>
              ) : null}
            </div>
          </section>

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
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-primary dark:bg-teal-bright" aria-hidden="true" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-5 flex flex-col gap-2">
                      <Button
                        className="bg-teal-primary text-white hover:bg-teal-dark"
                        fullWidth
                        onPress={() => startCheckout(plan.plan, 'yearly')}
                        isLoading={checkoutLoading === yearlyKey}
                        isDisabled={isCurrent || !billingConfigured || Boolean(checkoutLoading)}
                      >
                        {isCurrent ? 'Current plan' : `Get ${plan.name} yearly`}
                      </Button>
                      <Button
                        variant="bordered"
                        fullWidth
                        onPress={() => startCheckout(plan.plan, 'monthly')}
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
                    <span className="text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true">v</span>
                  </summary>
                  <p className="px-4 pb-4 text-sm leading-6 text-gray-600 dark:text-gray-300">{a}</p>
                </details>
              ))}
            </div>
          </AppSection>
        </>
      )}
    </AppPage>
  );
}
