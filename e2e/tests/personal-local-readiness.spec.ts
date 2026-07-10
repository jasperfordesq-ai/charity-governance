import { test, expect, type Locator, type Page } from '@playwright/test';
import { PERSONAL_LOCAL_API_BASE_URL } from '../personal-local.config';

const LOCAL_ADMIN_EMAIL = process.env.CHARITYPILOT_LOCAL_ADMIN_EMAIL ?? 'admin@charitypilot.local';
const LOCAL_ADMIN_PASSWORD = process.env.CHARITYPILOT_LOCAL_ADMIN_PASSWORD ?? 'LocalAdmin123!';
const ROUTES = [
  { path: '/dashboard', heading: /Welcome back/ },
  { path: '/compliance', heading: /Compliance/ },
  { path: '/documents', heading: /Document Vault/ },
  { path: '/billing', heading: /Billing & Subscription/ },
  { path: '/export', heading: /Export/ },
] as const;

async function reliablePersonalFill(locator: Locator, value: string): Promise<void> {
  await expect(async () => {
    await locator.fill('');
    await locator.fill(value);
    await expect(locator).toHaveValue(value, { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

async function gotoPersonalRoute(
  page: Page,
  path: string,
  options: Parameters<Page['goto']>[1] = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded', ...options });
      if (response && response.status() >= 500) {
        throw new Error(`Personal local route returned HTTP ${response.status()}.`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await page.waitForTimeout(2_000);
    }
  }
  throw lastError;
}

async function loginToPersonalStack(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('cookie-consent', 'declined'));
  await gotoPersonalRoute(page, '/login');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 60_000 });
    await reliablePersonalFill(page.getByLabel('Email address'), LOCAL_ADMIN_EMAIL);
    await reliablePersonalFill(page.getByLabel('Password', { exact: true }), LOCAL_ADMIN_PASSWORD);
    const loginResponse = page
      .waitForResponse(
        (response) => /\/api\/v1\/auth\/login/.test(response.url()) && response.request().method() === 'POST',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.getByRole('button', { name: 'Sign in' }).click({ noWaitAfter: true });
    const response = await loginResponse;
    if (response?.ok()) {
      await page.waitForURL(/\/dashboard/, { timeout: 120_000 });
      return;
    }
    await gotoPersonalRoute(page, '/login');
  }

  throw new Error('Personal local login never produced a successful API response.');
}

async function applyTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    localStorage.setItem('theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  }, theme);
  await page.waitForTimeout(250);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(2);
}

async function expectRenderable(page: Page, label: string): Promise<void> {
  await expect(page.locator('body')).not.toContainText('Application error');
  await expect(page.locator('body')).not.toContainText('Unhandled Runtime Error');
  await expect(page.locator('body')).not.toContainText('Unexpected end of JSON input');
  await expectNoPageOverflow(page);
  await expect(page.locator('body')).toBeVisible({ timeout: 60_000 });
  expect(await page.locator('body').innerText(), `${label} body text`).not.toHaveLength(0);
}

test.describe('Personal local readiness', () => {
  test('seeded local owner can use core pages without payments or destructive database reset', async ({ page }) => {
    const health = await page.request.get(`${PERSONAL_LOCAL_API_BASE_URL}/api/v1/health`);
    expect(health.ok()).toBe(true);

    await loginToPersonalStack(page);

    for (const route of ROUTES) {
      await gotoPersonalRoute(page, route.path, { waitUntil: 'commit', timeout: 180_000 });
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible({ timeout: 120_000 });
      await applyTheme(page, 'light');
      await expectRenderable(page, `${route.path} light`);
      await applyTheme(page, 'dark');
      await expectRenderable(page, `${route.path} dark`);
    }

    await gotoPersonalRoute(page, '/billing', { waitUntil: 'commit', timeout: 180_000 });
    await expect(page.getByRole('heading', { name: 'Billing setup is temporarily unavailable' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Manage subscription' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Get Essentials yearly' })).toBeDisabled();

    const planActionButtons = page.locator('main article button');
    await expect(planActionButtons).toHaveCount(4);
    for (let index = 0; index < await planActionButtons.count(); index += 1) {
      await expect(planActionButtons.nth(index)).toBeDisabled();
    }
  });
});
