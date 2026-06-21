import { test, expect } from '../fixtures';

/**
 * Concern: auth & session integrity (UI). Protected app routes must bounce an
 * unauthenticated visitor to /login (preserving the intended destination), and an expired
 * session must redirect to login rather than flashing stale data or crashing. Enforced at
 * the edge by proxy.ts before any protected page renders.
 */
test.describe('Auth & session integrity (UI)', () => {
  test('an unauthenticated visit to a protected route redirects to login with a next param', async ({ browser }) => {
    const context = await browser.newContext(); // no auth cookies
    const page = await context.newPage();
    try {
      await page.goto('/team');
      await expect(page).toHaveURL(/\/login\?next=%2Fteam/);
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('an expired/cleared session is redirected to login, not left on a protected page', async ({ browser, owner }) => {
    const context = await browser.newContext({ storageState: owner.storageState });
    const page = await context.newPage();
    try {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

      // Simulate the session expiring: drop the auth cookies, then hit a protected route.
      await context.clearCookies();
      await page.goto('/organisation');
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
