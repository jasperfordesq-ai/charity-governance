import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Concern: auth & session integrity (UI). Protected app routes must bounce an
 * unauthenticated visitor to /login (preserving the intended destination), and an expired
 * session must redirect to login rather than flashing stale data or crashing. Enforced at
 * the edge by proxy.ts before any protected page renders.
 */
test.describe('Auth & session integrity (UI)', () => {
  test('an unauthenticated visit to a protected route redirects to login with a next param', async ({ newFencedContext }) => {
    const context = await newFencedContext(); // no auth cookies
    const page = await context.newPage();
    try {
      await gotoWithDevServerRetry(page, '/team');
      await expect(page).toHaveURL(/\/login\?next=%2Fteam/);
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('an expired/cleared session is redirected to login, not left on a protected page', async ({ newFencedContext, owner }) => {
    const context = await newFencedContext({ storageState: owner.storageState });
    const authenticatedPage = await context.newPage();
    try {
      await gotoWithDevServerRetry(authenticatedPage, '/dashboard');
      await expect(authenticatedPage).toHaveURL(/\/dashboard(?:$|[?#])/);
      await expect(authenticatedPage.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

      // End the live dashboard before dropping cookies so its API 401 interceptor
      // cannot race the explicit protected-route navigation below.
      await authenticatedPage.close();
      await context.clearCookies();
      const expiredPage = await context.newPage();
      await gotoWithDevServerRetry(expiredPage, '/organisation', { waitUntil: 'commit' });
      await expect(expiredPage).toHaveURL(/\/login\?next=%2Forganisation(?:$|[&#])/, { timeout: 30_000 });
      await expect(expiredPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
