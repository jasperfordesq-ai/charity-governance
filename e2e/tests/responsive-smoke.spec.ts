import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { getPrincipleIdByNumber } from '../helpers/db';

type Theme = 'light' | 'dark';
type RouteSpec = string | { label: string; resolve: () => Promise<string> };

const VIEWPORT_THEME_CASES = [
  { label: 'desktop light', width: 1440, height: 1000, theme: 'light' },
  { label: 'desktop dark', width: 1440, height: 1000, theme: 'dark' },
  { label: 'mobile light', width: 390, height: 844, theme: 'light' },
  { label: 'mobile dark', width: 390, height: 844, theme: 'dark' },
] as const;

const PUBLIC_ROUTES = [
  '/',
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
    resolve: async () => `/compliance/${await getPrincipleIdByNumber(1)}`,
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

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((nextTheme) => {
    localStorage.setItem('theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    window.dispatchEvent(new Event('themechange'));
  }, theme);
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined));
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

async function resolveRoute(route: RouteSpec): Promise<{ label: string; path: string }> {
  if (typeof route === 'string') return { label: route, path: route };
  return { label: route.label, path: await route.resolve() };
}

for (const viewportCase of VIEWPORT_THEME_CASES) {
  test(`launch-critical public and auth routes render in ${viewportCase.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewportCase.width, height: viewportCase.height });

    for (const route of PUBLIC_ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await applyTheme(page, viewportCase.theme as Theme);
      await settle(page);
      await assertRenderable(page, route);
    }
  });

  test(`launch-critical dashboard routes render in ${viewportCase.label}`, async ({ ownerPage }) => {
    await ownerPage.setViewportSize({ width: viewportCase.width, height: viewportCase.height });

    for (const route of DASHBOARD_ROUTES) {
      const { label, path } = await resolveRoute(route);
      await ownerPage.goto(path, { waitUntil: 'domcontentloaded' });
      await applyTheme(ownerPage, viewportCase.theme as Theme);
      await settle(ownerPage);
      await assertRenderable(ownerPage, label);
    }
  });
}
