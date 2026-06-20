import { test, expect } from '../fixtures';

/**
 * Journey: the billing page renders the current tier, trial state and feature
 * gating in Stripe test mode. Locally STRIPE_* are placeholders, so
 * billingConfigured is false: checkout CTAs are disabled and an "unavailable"
 * notice is shown. We assert the rendered tier/gating and never trigger a live
 * checkout. The shared owner is a freshly-registered org: ESSENTIALS / TRIALING.
 */
test.describe('Billing', () => {
  test('renders the trial tier and Complete-plan feature gating (test mode)', async ({ ownerPage }) => {
    await ownerPage.goto('/billing');
    await expect(ownerPage.getByRole('heading', { name: 'Billing & Subscription' })).toBeVisible();

    // Current tier + trial state.
    await expect(ownerPage.getByText('Free Trial', { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(/You are on the/)).toBeVisible();
    await expect(ownerPage.getByText(/Your trial ends on/)).toBeVisible();

    // Plan comparison with Complete-only gated features.
    await expect(ownerPage.getByRole('heading', { name: 'Choose a Plan' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Essentials' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Complete' })).toBeVisible();
    await expect(ownerPage.getByText('All 49 standards for complex charities')).toBeVisible();

    // Stripe-unconfigured gating: warning shown and checkout disabled.
    await expect(
      ownerPage.getByRole('heading', { name: 'Billing setup is temporarily unavailable' }),
    ).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Get Complete (Yearly)' })).toBeDisabled();

    // A trialing org has no "Manage Subscription" (portal) button.
    await expect(ownerPage.getByRole('button', { name: 'Manage Subscription' })).toHaveCount(0);
  });
});
