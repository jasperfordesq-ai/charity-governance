'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Card, Button, Chip } from '@heroui/react';
import { api } from '@/lib/api';
import type { BillingStatusResponse } from '@charitypilot/shared';
import { SubscriptionPlan, SubscriptionStatus } from '@charitypilot/shared';

/* ------------------------------------------------------------------ */
/*  Plan card data                                                    */
/* ------------------------------------------------------------------ */

const PLANS = [
  {
    plan: SubscriptionPlan.ESSENTIALS,
    name: 'Essentials',
    monthlyPrice: 9,
    yearlyPrice: 90,
    features: [
      'Full Charities Governance Code tracker',
      'Compliance status per standard',
      'Document vault (up to 50 documents)',
      'Board member register',
      'Deadline tracker',
      'Annual compliance report export',
      'Email support',
    ],
  },
  {
    plan: SubscriptionPlan.COMPLETE,
    name: 'Complete',
    monthlyPrice: 19,
    yearlyPrice: 190,
    features: [
      'Everything in Essentials, plus:',
      'Unlimited document storage',
      'Additional standards tracking (complex orgs)',
      'Multi-user access (up to 5 users)',
      'Branded compliance reports',
      'Deadline email reminders',
      'Priority email support',
      'Export to PDF and CSV',
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

  const fetchBilling = useCallback(async () => {
    try {
      const res = await api.get('/billing/status');
      setBilling(res.data);
    } catch (err) {
      console.error('Failed to load billing', err);
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
    try {
      const res = await api.post('/billing/checkout', { plan, interval });
      window.location.href = res.data.url;
    } catch (err) {
      console.error('Checkout failed', err);
    } finally {
      setCheckoutLoading(null);
    }
  };

  /* ── Open Stripe portal ── */
  const openPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.post('/billing/portal');
      window.location.href = res.data.url;
    } catch (err) {
      console.error('Portal failed', err);
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

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing & Subscription</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage your CharityPilot subscription.
        </p>
      </div>

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
                    >
                      Get {plan.name} (Yearly)
                    </Button>
                    <Button
                      variant="bordered"
                      fullWidth
                      onPress={() => startCheckout(plan.plan, 'monthly')}
                      isLoading={checkoutLoading === `${plan.plan}-monthly`}
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
