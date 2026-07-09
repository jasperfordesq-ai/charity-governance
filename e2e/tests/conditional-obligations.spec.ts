import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe.configure({ timeout: 240_000 });

test('organisation conditional triggers surface document evidence prompts', async ({ ownerPage }) => {
  await gotoWithDevServerRetry(ownerPage, '/organisation', { waitUntil: 'commit', timeout: 150_000 });

  await expect(ownerPage.getByRole('heading', { name: 'Organisation' })).toBeVisible({ timeout: 60_000 });
  const publicFundraising = ownerPage.getByRole('checkbox', { name: /Public fundraising/ });
  await publicFundraising.check();
  await expect(publicFundraising).toBeChecked();

  const saved = ownerPage.waitForResponse(
    (response) => /\/api\/v1\/organisation$/.test(response.url()) && response.request().method() === 'PATCH',
    { timeout: 30_000 },
  );
  await ownerPage.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(
    async () => (await saved).ok(),
    { message: 'organisation profile save should succeed', timeout: 30_000 },
  ).toBe(true);

  await gotoWithDevServerRetry(ownerPage, '/documents', { waitUntil: 'commit', timeout: 150_000 });

  await expect(ownerPage.getByRole('heading', { name: 'Document Vault' })).toBeVisible({ timeout: 60_000 });
  const evidencePrompts = ownerPage.locator('section').filter({ hasText: 'Profile-triggered evidence prompts' });
  await expect(evidencePrompts.getByRole('heading', { name: 'Public fundraising controls' })).toBeVisible();
  await expect(evidencePrompts.getByText('Link evidence')).toBeVisible();
  await expect(evidencePrompts.getByText(/Standards 4\.3, 6\.4/)).toBeVisible();
});
