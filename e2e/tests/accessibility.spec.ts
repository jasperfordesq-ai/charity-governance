import { test, expect, type Page } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';

/**
 * Concern: accessibility & resilience. A charity-sector product must clear a WCAG 2.1 AA
 * baseline. We assert ZERO serious/critical axe violations on every key page, in both the
 * light and dark themes (dark mode is scoped to the dashboard app routes).
 */

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help}`);
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

test.describe('Accessibility — dashboard (light + dark)', () => {
  for (const path of DASHBOARD_PAGES) {
    test(`${path} is axe-clean in light and dark themes`, async ({ ownerPage }) => {
      // Light theme (default).
      await ownerPage.goto(path);
      await ownerPage.waitForLoadState('networkidle');
      expect(await seriousViolations(ownerPage), `${path} (light)`).toEqual([]);

      // Dark theme: the dashboard layout applies `.dark` on a `themechange` event.
      await ownerPage.evaluate(() => {
        localStorage.setItem('theme', 'dark');
        window.dispatchEvent(new Event('themechange'));
      });
      await ownerPage.waitForTimeout(150);
      expect(await seriousViolations(ownerPage), `${path} (dark)`).toEqual([]);
    });
  }
});

test.describe('Accessibility — public & auth pages', () => {
  for (const path of ['/', '/pricing', '/login', '/register', '/forgot-password']) {
    test(`${path} is axe-clean`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await seriousViolations(page), path).toEqual([]);
    });
  }
});
