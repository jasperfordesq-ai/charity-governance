import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Concern: tenant isolation (UI). The only editable resource id in the app is the
 * governance principleId (global reference data shared by all orgs). Navigating to an
 * unknown/foreign id must yield a clean "not found" — never another org's content and
 * never a crash. Cross-org enforcement itself lives in the API (the API ledger); here we
 * prove the UI fails safe.
 */
test.describe('Tenant isolation (UI)', () => {
  test('an unknown principle id renders a clean not-found, never leaked content', async ({ ownerPage }) => {
    await gotoWithDevServerRetry(ownerPage, '/compliance/this-principle-id-does-not-exist');
    await expect(ownerPage.getByRole('heading', { name: 'Compliance principle could not be loaded' })).toBeVisible({
      timeout: 180_000,
    });
    await expect(ownerPage.getByText('Principle not found')).toBeVisible({ timeout: 180_000 });
    // A safe escape hatch back to the user's own compliance overview.
    await expect(ownerPage.getByRole('button', { name: /Back to Compliance/i })).toBeVisible();
    // No standards/records from any org are rendered for the bogus id.
    await expect(ownerPage.getByRole('textbox')).toHaveCount(0);
  });
});
