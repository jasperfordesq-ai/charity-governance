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

test('desktop sidebar is navigation only and the attribution sits in the page footer', async ({ ownerPage }) => {
  // 1280x700 is an ordinary laptop window — and what a 1600x875 screen at the
  // 125% Windows scaling reports. The navigation list is taller than that, so
  // the sidebar has to scroll its own list rather than clip the tail of it.
  await ownerPage.setViewportSize({ width: 1280, height: 700 });
  await gotoWithDevServerRetry(ownerPage, '/integrations', { waitUntil: 'commit', timeout: 150_000 });

  const sidebar = ownerPage.locator('#dashboard-primary-navigation');
  const navLinks = sidebar.locator('nav a[href]');
  await expect(navLinks.first()).toBeVisible();

  // The attribution, version label and shortcuts hint used to be stacked at the
  // bottom of the sidebar. They belong to the page footer now, so the sidebar
  // holds nothing but the brand and the navigation.
  await expect(sidebar.getByTestId('sidebar-footer')).toHaveCount(0);
  await expect(sidebar.getByText('Powered by CharityPilot')).toHaveCount(0);
  await expect(sidebar.getByText('for shortcuts')).toHaveCount(0);

  const footer = ownerPage.getByTestId('dashboard-footer');
  await expect(footer).toContainText('Powered by CharityPilot');
  await expect(footer).toContainText('AGPL-3.0-or-later');
  await expect(footer.getByRole('link', { name: 'GitHub repository' })).toHaveAttribute(
    'href',
    'https://github.com/jasperfordesq-ai/charity-governance',
  );
  await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await expect(footer.getByText('for shortcuts')).toBeVisible();

  // The tail of the list has to be reachable: the navigation scrolls inside the
  // sidebar once it no longer fits, and nothing is painted over it.
  const lastLink = navLinks.last();
  await lastLink.scrollIntoViewIfNeeded();
  await expect(lastLink).toBeInViewport({ ratio: 0.99 });
  const covered = await lastLink.evaluate((link) => {
    const box = link.getBoundingClientRect();
    const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !(onTop && (onTop === link || link.contains(onTop)));
  });
  expect(covered, 'the last navigation item may not be painted over').toBe(false);
});
