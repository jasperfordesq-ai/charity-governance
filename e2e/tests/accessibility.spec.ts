import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';
import { gotoWithDevServerRetry } from '../helpers/navigation';

type Theme = 'light' | 'dark';

const NAVIGATION_TIMEOUT_MS = 300_000;
const ACCESSIBILITY_TEST_TIMEOUT_MS = 300_000;

// axe color-contrast results are deterministic, but each scan needs a fully-rendered page.
// Retry to absorb transient dev-server navigation jitter and give protected-route cold
// compiles the same headroom as the project navigation timeout. A real contrast violation
// fails every attempt, so retries never mask one.
test.describe.configure({ retries: 2, timeout: ACCESSIBILITY_TEST_TIMEOUT_MS });

/**
 * Concern: accessibility & resilience. A charity-sector product must clear a WCAG 2.1 AA
 * baseline. We assert ZERO serious/critical axe violations on every key page, in BOTH the
 * light and dark themes (dark mode is scoped to the dashboard app routes).
 */

// Settle the page before scanning so axe never measures a transient state. HeroUI /
// framer-motion fade an element in by animating inline opacity (0 -> 1); mid-fade the
// effective contrast is lower and would flake the scan. We (1) request reduced motion so
// the library skips those enter animations, (2) also pin transitions/animations off via
// CSS, (3) wait for webfonts, and (4) let any remaining frame settle.
async function waitForDocumentShell(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.documentElement && document.body), null, { timeout: 120_000 });
}

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((theme) => {
    localStorage.setItem('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.dispatchEvent(new Event('themechange'));
  }, theme);
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined));
  await page.waitForTimeout(900);
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
}

const DASHBOARD_PAGES = [
  '/dashboard',
  '/compliance',
  '/board',
  '/documents',
  '/deadlines',
  '/registers',
  '/organisation',
  '/team',
  '/billing',
  '/export',
  '/regulator',
];

test.describe('Accessibility - dashboard (light + dark)', () => {
  for (const path of DASHBOARD_PAGES) {
    test(`${path} is axe-clean in light and dark themes`, async ({ ownerPage }) => {
      // Light theme (default).
      await ownerPage.emulateMedia({ reducedMotion: 'reduce' });
      await gotoWithDevServerRetry(ownerPage, path, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
      await waitForDocumentShell(ownerPage);
      await applyTheme(ownerPage, 'light');
      await settle(ownerPage);
      expect(await seriousViolations(ownerPage), `${path} (light)`).toEqual([]);

      await applyTheme(ownerPage, 'dark');
      await settle(ownerPage);
      expect(await seriousViolations(ownerPage), `${path} (dark)`).toEqual([]);
    });
  }
});

test.describe('Accessibility - public & auth pages', () => {
  for (const path of ['/', '/pricing', '/login', '/register', '/forgot-password']) {
    test(`${path} is axe-clean (0 serious/critical)`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await gotoWithDevServerRetry(page, path, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
      await waitForDocumentShell(page);
      await settle(page);
      expect(await seriousViolations(page), path).toEqual([]);
    });
  }
});
