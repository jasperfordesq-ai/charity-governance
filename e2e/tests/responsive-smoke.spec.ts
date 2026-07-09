import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry, resolveFirstComplianceDetailPath } from '../helpers/navigation';

type Theme = 'light' | 'dark';
type RouteSpec = string | { label: string; resolve: (page: Page) => Promise<string> };

const VIEWPORT_CASES = [
  { label: 'desktop light and dark', width: 1440, height: 1000 },
  { label: 'mobile light and dark', width: 390, height: 844 },
] as const;

const THEME_CASES: readonly Theme[] = ['light', 'dark'];
const NAVIGATION_TIMEOUT_MS = 300_000;
const PUBLIC_ROUTE_TIMEOUT_MS = 420_000;
const DASHBOARD_ROUTE_TIMEOUT_MS = 420_000;
const FONT_SETTLE_TIMEOUT_MS = 5_000;

const PUBLIC_ROUTES = [
  '/',
  '/about',
  '/features',
  '/pricing',
  '/blog',
  '/blog/understanding-the-charities-governance-code',
  '/privacy',
  '/terms',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/verify-email',
] as const;

const DASHBOARD_ROUTES: readonly RouteSpec[] = [
  '/dashboard',
  '/compliance',
  {
    label: '/compliance/${principleId}',
    resolve: async (page) => resolveFirstComplianceDetailPath(page, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS }),
  },
  '/board',
  '/documents',
  '/deadlines',
  '/registers',
  '/regulator',
  '/organisation',
  '/team',
  '/billing',
  '/export',
] as const;

test.describe.configure({ retries: 1, timeout: 240_000 });

async function waitForDocumentShell(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.documentElement && document.body), null, { timeout: 120_000 });
}

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((nextTheme) => {
    localStorage.setItem('theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    window.dispatchEvent(new Event('themechange'));
  }, theme);
}

async function suppressCookieConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('cookie-consent', 'declined');
  });
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.evaluate((timeoutMs) => {
    if (!document.fonts) return undefined;
    return Promise.race([
      document.fonts.ready.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, FONT_SETTLE_TIMEOUT_MS);
}

async function assertRenderable(page: Page, route: string): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  await expect.poll(
    async () => page.locator('body').evaluate((body) => body.textContent?.trim().length ?? 0),
    { message: `${route} should render visible text`, timeout: 10_000 },
  ).toBeGreaterThan(20);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${route} should not create horizontal page overflow`).toBeLessThanOrEqual(2);
}

async function resolveRoute(route: RouteSpec, page: Page): Promise<{ label: string; path: string }> {
  if (typeof route === 'string') return { label: route, path: route };
  return { label: route.label, path: await route.resolve(page) };
}

for (const viewportCase of VIEWPORT_CASES) {
  for (const route of PUBLIC_ROUTES) {
    test(`launch-critical public/auth route ${route} renders in ${viewportCase.label}`, async ({ page }) => {
      test.setTimeout(PUBLIC_ROUTE_TIMEOUT_MS);
      await page.setViewportSize({ width: viewportCase.width, height: viewportCase.height });
      await suppressCookieConsent(page);
      await gotoWithDevServerRetry(page, route, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });

      for (const theme of THEME_CASES) {
        await waitForDocumentShell(page);
        await applyTheme(page, theme);
        await settle(page);
        await assertRenderable(page, `${route} ${theme}`);
      }
    });
  }

  for (const route of DASHBOARD_ROUTES) {
    test(`launch-critical dashboard route ${typeof route === 'string' ? route : route.label} renders in ${viewportCase.label}`, async ({ ownerPage }) => {
      test.setTimeout(DASHBOARD_ROUTE_TIMEOUT_MS);
      await ownerPage.setViewportSize({ width: viewportCase.width, height: viewportCase.height });
      const { label, path } = await resolveRoute(route, ownerPage);
      await gotoWithDevServerRetry(ownerPage, path, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });

      for (const theme of THEME_CASES) {
        await waitForDocumentShell(ownerPage);
        await applyTheme(ownerPage, theme);
        await settle(ownerPage);
        await assertRenderable(ownerPage, `${label} ${theme}`);
      }
    });
  }
}
