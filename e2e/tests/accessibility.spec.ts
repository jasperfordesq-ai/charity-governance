import { test, expect, type Page } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';

/**
 * Concern: accessibility & resilience. A charity-sector product must clear a WCAG 2.1 AA
 * baseline. We assert ZERO serious/critical axe violations on every key page in the
 * DEFAULT (light) theme — the experience every user gets out of the box.
 *
 * Dark theme is deliberately NOT asserted here: an axe sweep found a SYSTEMIC dark-mode
 * colour-contrast problem (the brand teal #0D7377/#10998E and the gray-500 secondary text
 * are too dark on the dark surfaces; e.g. /compliance reports 23 serious contrast nodes in
 * dark mode). Fixing that is a dark-mode design-token pass — a brand/design decision, not a
 * minimal fix — so it is recorded as a human-decision item in SESSION-SUMMARY rather than
 * changed speculatively here. This test proves the default theme is clean and will catch a
 * regression in it.
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

test.describe('Accessibility — dashboard (default theme)', () => {
  for (const path of DASHBOARD_PAGES) {
    test(`${path} is axe-clean (0 serious/critical) in the default theme`, async ({ ownerPage }) => {
      await ownerPage.goto(path);
      await ownerPage.waitForLoadState('networkidle');
      expect(await seriousViolations(ownerPage), path).toEqual([]);
    });
  }
});

// The marketing home (/) is intentionally omitted: it is a public landing page (not one
// of the brief's key app/auth/pricing route groups) and its remaining axe finding is the
// hero/eyebrow `text-amber-accent` (#D4A843) on white — a brand-colour contrast decision,
// recorded in SESSION-SUMMARY rather than changed unilaterally.
test.describe('Accessibility — public & auth pages', () => {
  for (const path of ['/pricing', '/login', '/register', '/forgot-password']) {
    test(`${path} is axe-clean (0 serious/critical)`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await seriousViolations(page), path).toEqual([]);
    });
  }
});
