import { test, expect, type Page } from '../fixtures';

type Theme = 'light' | 'dark';

const VIEWPORT_THEME_CASES = [
  { label: 'desktop light', width: 1440, height: 1000, theme: 'light' },
  { label: 'mobile dark', width: 390, height: 844, theme: 'dark' },
] as const;

const PUBLIC_ROUTES = [
  '/',
  '/pricing',
  '/login',
  '/register',
] as const;

const DASHBOARD_ROUTES = [
  '/dashboard',
  '/documents',
  '/registers',
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
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined));
  await page.waitForTimeout(250);
}

async function assertRenderable(page: Page, route: string): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  await expect.poll(
    async () => page.locator('body').evaluate((body) => body.innerText.trim().length),
    { message: `${route} should render visible text`, timeout: 10_000 },
  ).toBeGreaterThan(20);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${route} should not create horizontal page overflow`).toBeLessThanOrEqual(2);
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
      await ownerPage.goto(route, { waitUntil: 'domcontentloaded' });
      await applyTheme(ownerPage, viewportCase.theme as Theme);
      await settle(ownerPage);
      await assertRenderable(ownerPage, route);
    }
  });
}
