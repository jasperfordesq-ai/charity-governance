import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Journey: the billing page renders the current tier, trial state and feature
 * gating in Stripe test mode. Locally STRIPE_* are placeholders, so
 * billingConfigured is false: checkout and portal controls are not rendered
 * and an "unavailable" notice is shown. We assert the rendered tier/gating and never trigger a live
 * checkout. The shared owner is a freshly-registered org: ESSENTIALS / TRIALING.
 */
test.describe('Billing', () => {
  test('renders the trial tier and Complete-plan feature gating (test mode)', async ({ ownerPage }) => {
    await gotoWithDevServerRetry(ownerPage, '/billing');
    await expect(ownerPage.getByRole('heading', { name: 'Billing & Subscription' })).toBeVisible({ timeout: 60_000 });

    // Current tier + trial state.
    await expect(ownerPage.getByText('Free trial', { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(/You are on the/)).toBeVisible();
    await expect(ownerPage.getByText(/Trial ends on/)).toBeVisible();

    // Plan comparison with Complete-only gated features.
    await expect(ownerPage.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Essentials' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible();
    await expect(ownerPage.getByText('All 49 standards for complex charities')).toBeVisible();

    // Stripe-unconfigured gating: warning shown and checkout controls omitted.
    // The server-owned capability is false, so rendering a disabled checkout
    // control would still expose an action that cannot be started.
    await expect(
      ownerPage.getByRole('heading', { name: 'Billing setup is temporarily unavailable' }),
    ).toBeVisible();
    await expect(ownerPage.getByText('Provider-degraded', { exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: /Get (?:Essentials|Complete)/ })).toHaveCount(0);
    await expect(ownerPage.getByText(/Checkout is not available for the current billing state/).first()).toBeVisible();

    // A trialing org has no "Manage Subscription" (portal) button.
    await expect(ownerPage.getByRole('button', { name: 'Manage subscription', exact: true })).toHaveCount(0);
  });
});
