import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe.configure({ timeout: 180_000 });

test('mobile dashboard sidebar restores focus and removes closed links from tab order', async ({ ownerPage }) => {
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await gotoWithDevServerRetry(ownerPage, '/dashboard', { waitUntil: 'commit', timeout: 150_000 });

  const menuButton = ownerPage.getByRole('button', { name: 'Open sidebar menu' });
  await expect(menuButton).toBeVisible();

  const dashboardLink = ownerPage.locator('#dashboard-primary-navigation a[href="/dashboard"]');
  const documentsLink = ownerPage.locator('#dashboard-primary-navigation a[href="/documents"]');

  await expect(documentsLink).toHaveAttribute('tabindex', '-1');

  await menuButton.focus();
  await menuButton.click();
  await expect(ownerPage.getByRole('button', { name: 'Close sidebar menu' })).toHaveAttribute('aria-expanded', 'true');
  await expect(dashboardLink).toBeFocused();
  await expect(documentsLink).not.toHaveAttribute('tabindex', '-1');

  await ownerPage.keyboard.press('Escape');
  await expect(ownerPage.getByRole('button', { name: 'Open sidebar menu' })).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();
  await expect(documentsLink).toHaveAttribute('tabindex', '-1');
});
