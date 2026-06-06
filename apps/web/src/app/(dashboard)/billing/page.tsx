'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Button, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { getTrustedStripeRedirectUrl } from '@/lib/url-security';
import type { BillingStatusResponse } from '@charitypilot/shared';
import { SubscriptionPlan, SubscriptionStatus } from '@charitypilot/shared';

/* ------------------------------------------------------------------ */
/*  Plan card data                                                    */
/* ------------------------------------------------------------------ */

const PLANS = [
  {
    plan: SubscriptionPlan.ESSENTIALS,
    name: 'Essentials',
    monthlyPrice: 19,
    yearlyPrice: 190,
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

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

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
      console.error('Failed to load billing', err);
      setBillingError('Billing status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBilling();
  }, [fetchBilling]);

  /* ── Start checkout ── */
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
      console.error('Checkout failed', err);
      setBillingError(apiErrorMessage(err, 'Checkout could not be started.'));
    } finally {
      setCheckoutLoading(null);
    }
  };

  /* ── Open Stripe portal ── */
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
      console.error('Portal failed', err);
      setBillingError(apiErrorMessage(err, 'The Stripe customer portal could not be opened.'));
    } finally {
      setPortalLoading(false);
    }
  };

  /* ── Status display helpers ── */
  const statusChip = () => {
    if (!billing?.status) return null;
    const map: Record<string, { color: 'success' | 'warning' | 'danger' | 'default'; label: string }> = {
      [SubscriptionStatus.ACTIVE]: { color: 'success', label: 'Active Subscription' },
      [SubscriptionStatus.TRIALING]: { color: 'warning', label: 'Free Trial' },
      [SubscriptionStatus.PAST_DUE]: { color: 'danger', label: 'Payment Issue' },
      [SubscriptionStatus.CANCELLED]: { color: 'default', label: 'Cancelled' },
      [SubscriptionStatus.EXPIRED]: { color: 'default', label: 'Expired' },
    };
    const meta = map[billing.status] ?? { color: 'default' as const, label: billing.status };
    return (
      <Chip color={meta.color} variant="flat" size="sm">
        {meta.label}
      </Chip>
    );
  };

  const isTrialing = billing?.status === SubscriptionStatus.TRIALING;
  const isActive = billing?.status === SubscriptionStatus.ACTIVE;
  const billingConfigured = billing?.billingConfigured ?? false;

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing & Subscription</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage the plan that controls governance coverage, evidence storage, reminders, and team access.
        </p>
      </div>

      {billingError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {billingError}
        </div>
      )}

      {!loading && !billingConfigured && (
        <Card className="border border-amber-200 bg-amber-50 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-amber-900">Stripe is not production-ready yet</h2>
          <p className="text-sm text-amber-800 mt-1">
            Checkout is disabled until the Stripe secret key, webhook secret, and all four price IDs are configured.
            This protects live customers from broken payment sessions.
          </p>
        </Card>
      )}

      {/* Current status */}
      {loading ? (
        <Card className="p-6 animate-pulse">
          <div className="h-5 bg-gray-200 rounded w-1/3 mb-3" />
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-2" />
          <div className="h-4 bg-gray-200 rounded w-1/3" />
        </Card>
      ) : (
        <Card className="border border-gray-200 shadow-sm p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-lg font-semibold text-gray-800">Current Plan</h2>
                {statusChip()}
              </div>

              {billing?.plan ? (
                <p className="text-sm text-gray-600">
                  You are on the <strong>{billing.plan === SubscriptionPlan.ESSENTIALS ? 'Essentials' : 'Complete'}</strong> plan.
                </p>
              ) : (
                <p className="text-sm text-gray-600">No active subscription.</p>
              )}

              {isTrialing && billing?.trialEndsAt && (
                <p className="text-sm text-amber-600 mt-1">
                  Your trial ends on{' '}
                  <strong>
                    {new Date(billing.trialEndsAt).toLocaleDateString('en-IE', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </strong>
                  . Upgrade now to avoid losing access.
                </p>
              )}

              {isActive && billing?.currentPeriodEnd && (
                <p className="text-sm text-gray-500 mt-1">
                  Current period ends{' '}
                  {new Date(billing.currentPeriodEnd).toLocaleDateString('en-IE', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              )}
            </div>

            {isActive && (
              <Button
                variant="bordered"
                onPress={openPortal}
                isLoading={portalLoading}
                isDisabled={!billingConfigured}
              >
                Manage Subscription
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Plan comparison cards */}
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">
          {isActive ? 'Plans' : 'Choose a Plan'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {PLANS.map((plan) => {
            const isCurrent = billing?.plan === plan.plan && isActive;

            return (
              <Card
                key={plan.plan}
                className={`
                  border-2 shadow-sm p-6 sm:p-8 relative overflow-hidden
                  ${isCurrent ? 'border-teal-primary' : 'border-gray-200'}
                `}
              >
                {isCurrent && (
                  <div className="absolute top-0 right-0 bg-teal-primary text-white text-xs font-semibold px-3 py-1 rounded-bl-lg">
                    Current
                  </div>
                )}

                <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>

                <div className="mt-3 mb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold text-gray-900">
                      &euro;{plan.monthlyPrice}
                    </span>
                    <span className="text-sm text-gray-500">/month</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    or &euro;{plan.yearlyPrice}/year (save {Math.round((1 - plan.yearlyPrice / (plan.monthlyPrice * 12)) * 100)}%)
                  </p>
                </div>

                <ul className="space-y-2 mb-6">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <svg className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <Button variant="bordered" isDisabled fullWidth>
                    Current Plan
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Button
                      className="bg-teal-primary text-white hover:bg-teal-dark"
                      fullWidth
                      onPress={() => startCheckout(plan.plan, 'yearly')}
                      isLoading={checkoutLoading === `${plan.plan}-yearly`}
                      isDisabled={!billingConfigured}
                    >
                      Get {plan.name} (Yearly)
                    </Button>
                    <Button
                      variant="bordered"
                      fullWidth
                      onPress={() => startCheckout(plan.plan, 'monthly')}
                      isLoading={checkoutLoading === `${plan.plan}-monthly`}
                      isDisabled={!billingConfigured}
                    >
                      Monthly (&euro;{plan.monthlyPrice}/mo)
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* FAQ / info */}
      <Card className="border border-gray-200 shadow-sm p-6">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Frequently Asked Questions</h3>
        <div className="space-y-1 text-sm text-gray-600">
          {[
            { q: 'Can I cancel at any time?', a: 'Yes. You can cancel your subscription at any time from the Manage Subscription page. You will retain access until the end of your current billing period.' },
            { q: 'What payment methods do you accept?', a: 'We accept all major credit and debit cards through our secure payment partner, Stripe.' },
            { q: 'Is there a free trial?', a: 'Yes! Every new account gets a 14-day free trial with full access to all features.' },
            { q: 'Can I switch plans?', a: 'Yes. You can upgrade or downgrade at any time. Changes take effect at the start of your next billing period.' },
          ].map(({ q, a }) => (
            <details key={q} className="group rounded-lg border border-gray-100 overflow-hidden">
              <summary className="flex items-center justify-between cursor-pointer px-4 py-3 font-medium text-gray-700 hover:bg-gray-50 transition-colors list-none">
                {q}
                <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </summary>
              <p className="px-4 pb-3 text-gray-600">{a}</p>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
