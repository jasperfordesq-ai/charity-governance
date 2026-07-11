import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe.configure({ timeout: 240_000 });

test('organisation conditional triggers surface workflow prompts', async ({ ownerPage }) => {
  await gotoWithDevServerRetry(ownerPage, '/organisation', { waitUntil: 'commit', timeout: 150_000 });

  await expect(ownerPage.getByRole('heading', { name: 'Organisation' })).toBeVisible({ timeout: 60_000 });
  const publicFundraising = ownerPage.getByRole('checkbox', { name: /Public fundraising/ });
  await publicFundraising.check();
  await expect(publicFundraising).toBeChecked();

  const saved = ownerPage.waitForResponse(
    (response) => /\/api\/v1\/organisation$/.test(response.url()) && response.request().method() === 'PATCH',
    { timeout: 30_000 },
  );
  const saveProfile = ownerPage.getByRole('button', { name: 'Save profile' });
  await expect(saveProfile).toBeEnabled();
  await saveProfile.click();
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

  await gotoWithDevServerRetry(ownerPage, '/deadlines', { waitUntil: 'commit', timeout: 150_000 });
  await expect(ownerPage.getByRole('heading', { name: 'Deadlines' })).toBeVisible({ timeout: 60_000 });
  const deadlinePrompts = ownerPage.locator('section').filter({ hasText: 'Profile-triggered review dates' });
  await expect(deadlinePrompts.getByRole('heading', { name: 'Public fundraising controls' })).toBeVisible();
  await expect(deadlinePrompts.getByText('Needs date')).toBeVisible();

  await gotoWithDevServerRetry(ownerPage, '/regulator', { waitUntil: 'commit', timeout: 150_000 });
  await expect(ownerPage.getByRole('heading', { name: 'Regulator Readiness' })).toBeVisible({ timeout: 60_000 });
  const regulatorPriorities = ownerPage.locator('section').filter({ hasText: 'Profile-triggered regulator priorities' });
  await expect(regulatorPriorities.getByRole('heading', { name: 'Public fundraising controls' })).toBeVisible();
  await expect(regulatorPriorities.getByText(/1 triggered/)).toBeVisible();
});
