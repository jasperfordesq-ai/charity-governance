import type { Page } from '@playwright/test';
import { test, expect, registerViaUi, loginViaUi, reliableFill, TEST_PASSWORD, uniqueEmail } from '../fixtures';
import { createVerifiedOwner, getUserAndOrg, injectResetToken, injectVerifyToken, isEmailVerified } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

async function requestPasswordResetViaUi(page: Page, email: string): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('cookie-consent', 'declined');
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await gotoWithDevServerRetry(page, '/forgot-password', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('load');
    await page.waitForTimeout(1_500);
    await reliableFill(page.getByLabel('Email address'), email);
    const forgotRequest = page
      .waitForResponse(
        (response) => /\/api\/v1\/auth\/forgot-password/.test(response.url()) && response.request().method() === 'POST',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.getByRole('button', { name: 'Send reset link' }).click({ noWaitAfter: true });
    const response = await forgotRequest;
    if (response?.ok()) {
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(email)).toBeVisible();
      return;
    }
  }
  throw new Error('Forgot-password form never produced a successful /auth/forgot-password POST');
}

async function fillResetPasswordForm(page: Page, password: string): Promise<void> {
  await reliableFill(page.getByLabel('New password', { exact: true }), password);
  await reliableFill(page.getByLabel('Confirm new password'), password);
}

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
    await gotoWithDevServerRetry(page, `/verify-email#token=${token}`);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    expect(await isEmailVerified(email)).toBe(true);

    // 3. Log in -> dashboard (only reachable once verified).
    await loginViaUi(page, email, 'TestPass123');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  });

  test('an invalid verification token shows the failure state', async ({ page }) => {
    await gotoWithDevServerRetry(page, '/verify-email#token=this-token-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Verification failed' })).toBeVisible({ timeout: 60_000 });
  });

  test('forgot-password request then reset-password form changes the password', async ({ page }) => {
    const email = uniqueEmail('reset');
    const newPassword = 'NewPass123';

    await createVerifiedOwner({
      email,
      password: TEST_PASSWORD,
      name: 'Reset Flow User',
      organisationName: 'Reset Flow Charity',
    });

    await requestPasswordResetViaUi(page, email);

    const token = await injectResetToken(email);
    await page.goto('about:blank');
    await gotoWithDevServerRetry(page, `/reset-password#token=${token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('load');
    await page.waitForTimeout(1_500);

    await fillResetPasswordForm(page, 'alllowercase');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Password must contain at least one uppercase letter')).toBeVisible();

    await fillResetPasswordForm(page, newPassword);
    const resetRequest = page.waitForResponse(
      (response) => /\/api\/v1\/auth\/reset-password/.test(response.url()) && response.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Reset password' }).click();
    expect((await resetRequest).ok()).toBe(true);
    await expect(page.getByRole('heading', { name: 'Password reset' })).toBeVisible({ timeout: 60_000 });

    await loginViaUi(page, email, newPassword);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('an invalid reset token shows the failure state without changing password', async ({ page }) => {
    await gotoWithDevServerRetry(page, '/reset-password#token=this-token-does-not-exist', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('load');
    await page.waitForTimeout(1_500);

    await fillResetPasswordForm(page, 'NewPass123');
    const resetRequest = page.waitForResponse(
      (response) => /\/api\/v1\/auth\/reset-password/.test(response.url()) && response.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Reset password' }).click();
    expect((await resetRequest).status()).toBe(400);
    await expect(page.getByText(/invalid|expired|link/i)).toBeVisible({ timeout: 60_000 });
  });
});
