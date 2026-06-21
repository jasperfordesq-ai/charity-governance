import { test, expect, registerViaUi, loginViaUi, uniqueEmail } from '../fixtures';
import { getUserAndOrg, injectVerifyToken, isEmailVerified } from '../helpers/db';

/**
 * Journey: register -> email-verify -> create organisation -> log in.
 *
 * Registration creates the Organisation + OWNER user + trialing Subscription in
 * one transaction. Email delivery is a local no-op and the verify token is
 * stored sha256-hashed, so we inject a known token via the DB and then drive
 * the REAL /verify-email page + endpoint.
 */
test.describe('Authentication', () => {
  test('register, verify email, then log in to the dashboard', async ({ page }) => {
    const email = uniqueEmail('auth');

    // 1. Register (public). UI lands on the verify-email "pending" screen.
    await registerViaUi(page, { email, name: 'Auth Journey User', organisationName: 'Auth Journey Charity' });
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // The organisation + owner user now exist; email is not yet verified.
    const { userId, organisationId } = await getUserAndOrg(email);
    expect(userId).toBeTruthy();
    expect(organisationId).toBeTruthy();
    expect(await isEmailVerified(email)).toBe(false);

    // 2. Verify via the real flow using an injected, known token.
    // Leave the pending verify page first so navigating to the same path with a
    // #token fragment triggers a full document load (and the auto-verify effect).
    const token = await injectVerifyToken(email);
    await page.goto('about:blank');
    await page.goto(`/verify-email#token=${token}`);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    expect(await isEmailVerified(email)).toBe(true);

    // 3. Log in -> dashboard (only reachable once verified).
    await loginViaUi(page, email, 'TestPass123');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  });

  test('an invalid verification token shows the failure state', async ({ page }) => {
    await page.goto('/verify-email#token=this-token-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Verification failed' })).toBeVisible();
  });
});
