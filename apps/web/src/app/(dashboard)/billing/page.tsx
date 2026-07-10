'use client';

import { logClientError } from '@/lib/client-logger';
import { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '@/lib/use-title';
import { Button } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { getTrustedStripeRedirectUrl } from '@/lib/url-security';
import { AppPage } from '@/components/ui/app-page';
import { ErrorState, InlineStatus, LoadingState, ReviewWarningState } from '@/components/ui/states';
import { ReviewFlag, StatusChip, statusPanelClassName } from '@/components/ui/status';
import { BillingPlanSections } from './billing-plan-sections';
import type { BillingStatusResponse } from '@charitypilot/shared';
import { SubscriptionPlan, SubscriptionStatus } from '@charitypilot/shared';

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
    if (!billing?.canStartCheckout) {
      setBillingError('Checkout is not available for the current billing state. Manage an existing subscription in the Stripe customer portal or contact support.');
      return;
    }

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
    if (!billing?.canOpenPortal) {
      setBillingError('The Stripe customer portal is not available for the current billing state. Please contact support.');
      return;
    }

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
  const canStartCheckout = billing?.canStartCheckout === true;
  const canOpenPortal = billing?.canOpenPortal === true;
  const currentPlanName = billing?.plan === SubscriptionPlan.COMPLETE ? 'Complete' : billing?.plan === SubscriptionPlan.ESSENTIALS ? 'Essentials' : 'No active plan';
  const billingActionStatus = checkoutLoading
    ? 'Preparing secure Stripe checkout...'
    : portalLoading
      ? 'Opening secure Stripe customer portal...'
      : '';

  return (
    <AppPage
      eyebrow="Subscription"
      title="Billing & Subscription"
      description="Manage the plan that controls governance coverage, evidence storage, reminders, team access, and Complete register access."
    >
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

      {billingActionStatus ? (
        <InlineStatus tone="neutral">
          {billingActionStatus}
        </InlineStatus>
      ) : null}

      {loading ? (
        <LoadingState title="Loading billing" description="Checking subscription status and available plan actions." />
      ) : (
        <>
          <section className={statusPanelClassName('brand', 'p-5 shadow-sm')}>
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-3xl">
                <div className="flex flex-wrap gap-2">
                  {statusChip()}
                  <ReviewFlag tone={canStartCheckout || canOpenPortal ? 'draft' : 'needs-review'}>
                    {canOpenPortal
                      ? 'Stripe portal available'
                      : canStartCheckout
                        ? 'Stripe checkout available'
                        : billingConfigured
                          ? 'Billing review required'
                          : 'Provider-degraded'}
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

                {billing?.cancelAtPeriodEnd ? (
                  <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
                    Cancellation is scheduled
                    {billing.currentPeriodEnd ? <> for {formatDate(billing.currentPeriodEnd)}</> : null}.
                  </p>
                ) : null}
              </div>

              {canOpenPortal ? (
                <Button
                  variant="bordered"
                  onPress={openPortal}
                  isLoading={portalLoading}
                  isDisabled={!billingConfigured || portalLoading}
                  aria-describedby={!billingConfigured ? 'provider-degraded' : undefined}
                >
                  Manage subscription
                </Button>
              ) : null}
            </div>
          </section>

          <BillingPlanSections
            billing={billing}
            billingConfigured={billingConfigured}
            canStartCheckout={canStartCheckout}
            canOpenPortal={canOpenPortal}
            checkoutLoading={checkoutLoading}
            isActive={isActive}
            onCheckout={startCheckout}
          />
        </>
      )}
    </AppPage>
  );
}
