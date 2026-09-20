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

test('desktop sidebar keeps every navigation item clear of the sidebar footer', async ({ ownerPage }) => {
  // 1280x700 is an ordinary laptop window — and what a 1600x875 screen at the
  // 125% Windows scaling reports. The navigation list plus the footer is taller
  // than that, which is the case the footer used to be painted straight over:
  // it is positioned, so it reserves no space of its own and nothing scrolls.
  await ownerPage.setViewportSize({ width: 1280, height: 700 });
  await gotoWithDevServerRetry(ownerPage, '/integrations', { waitUntil: 'commit', timeout: 150_000 });

  const sidebar = ownerPage.locator('#dashboard-primary-navigation');
  const navLinks = sidebar.locator('nav a[href]');
  await expect(navLinks.first()).toBeVisible();

  // Ask the browser what is actually painted at each on-screen navigation item:
  // a rectangle comparison would not do, because an item scrolled out of the
  // navigation's own scroll box still reports a rectangle down where the footer
  // is, it is merely clipped. Only items the reader can see are judged here.
  const coveredItems = () =>
    sidebar.evaluate((aside) => {
      const nav = aside.querySelector<HTMLElement>('nav');
      if (!nav) throw new Error('sidebar navigation not found');
      const navBox = nav.getBoundingClientRect();
      return Array.from(nav.querySelectorAll<HTMLElement>('a[href]'))
        .filter((link) => {
          const box = link.getBoundingClientRect();
          return box.top >= navBox.top - 1 && box.bottom <= navBox.bottom + 1;
        })
        .filter((link) => {
          const box = link.getBoundingClientRect();
          const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !(onTop && (onTop === link || link.contains(onTop)));
        })
        .map((link) => link.textContent?.trim() ?? '');
    });

  expect(await coveredItems(), 'no visible navigation item may be painted over').toEqual([]);

  // The tail of the list has to be reachable, not merely un-overlapped: the
  // navigation scrolls inside the sidebar once it no longer fits.
  const lastLink = navLinks.last();
  await lastLink.scrollIntoViewIfNeeded();
  await expect(lastLink).toBeInViewport({ ratio: 0.99 });
  expect(await coveredItems(), 'scrolling the navigation may not slide items under the footer').toEqual([]);

  // The footer itself stays on screen rather than being pushed off the bottom.
  await expect(sidebar.getByTestId('sidebar-footer')).toBeInViewport({ ratio: 0.99 });
});
