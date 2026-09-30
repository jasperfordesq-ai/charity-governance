import type { Page } from '@playwright/test';
import { test, expect, registerViaUi, loginViaUi, reliableFill, TEST_PASSWORD, uniqueEmail } from '../fixtures';
import {
  createVerifiedOwner,
  getPasswordRecoveryResetEvidence,
  getUserAndOrg,
  injectResetToken,
  injectVerifyToken,
  isEmailVerified,
  withDb,
} from '../helpers/db';
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
      await expect(page.getByRole('heading', { name: 'Check for a reset email' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/If an active account exists for the address you entered/)).toBeVisible();
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
// Block the real logout transaction inside the disposable database. Requests
// still pass through the installed browser-origin fence without extra routes.
async function withHeldLogout(organisationId: string, check: () => Promise<void>): Promise<void> {
  await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT "id" FROM "Organisation" WHERE "id" = $1 FOR UPDATE', [organisationId]);
      await check();
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

test.describe('Authentication', () => {
  test('dashboard sign-out failure stays visible and can be retried', async ({ ownerPage }) => {
    const pageErrors: string[] = [];
    ownerPage.on('pageerror', (error) => pageErrors.push(error.message));
    await gotoWithDevServerRetry(ownerPage, '/dashboard');
    const logoutButton = ownerPage.getByRole('button', { name: 'Logout', exact: true });
    await expect(logoutButton).toBeVisible();
    // Let the initial document/navigation and workspace reads settle before
    // taking the context offline; this case targets logout, not page loading.
    await ownerPage.waitForLoadState('networkidle');
    await ownerPage.context().setOffline(true);
    await logoutButton.click();
    await expect(ownerPage.getByRole('alert').filter({ hasText: 'Sign-out could not be confirmed.' }))
      .toHaveText('Sign-out could not be confirmed. Please try again.');
    await expect(ownerPage).toHaveURL(/\/dashboard$/);
    await expect(logoutButton).toBeEnabled();
    await ownerPage.context().setOffline(false);
    await logoutButton.click();
    await expect(ownerPage).toHaveURL(/\/login(?:\?|$)/);
    expect(pageErrors).toEqual([]);
  });

  test('idle sign-out waits for cookie clearance before navigating', async ({ ownerPage, owner }) => {
    await ownerPage.clock.install();
    await gotoWithDevServerRetry(ownerPage, '/dashboard');
    await expect(ownerPage.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
    await withHeldLogout(owner.organisationId, async () => {
      const arrived = ownerPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/auth/logout');
      await ownerPage.clock.runFor(14 * 60 * 1000);
      await arrived;
      await expect(ownerPage).toHaveURL(/\/dashboard$/);
      await expect(ownerPage.getByRole('button', { name: 'Sign out', exact: true })).toBeDisabled();
    });
    await expect(ownerPage).toHaveURL(/\/login(?:\?|$)/);
    expect((await ownerPage.context().cookies()).filter((cookie) =>
      ['charitypilot_access', 'charitypilot_refresh'].includes(cookie.name))).toEqual([]);
  });

  test('dashboard sign-out waits for cookie clearance before navigating', async ({ ownerPage, owner }) => {
    await gotoWithDevServerRetry(ownerPage, '/dashboard');
    const logoutButton = ownerPage.getByRole('button', { name: 'Logout', exact: true });
    await expect(logoutButton).toBeVisible();
    let refreshes = 0;
    ownerPage.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/auth/refresh') refreshes += 1;
    });
    await withHeldLogout(owner.organisationId, async () => {
      const arrived = ownerPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/auth/logout');
      await logoutButton.click();
      await arrived;
      await expect(ownerPage.getByRole('button', { name: /Logout$/ })).toBeDisabled();
      await expect(ownerPage).toHaveURL(/\/dashboard$/);
      expect(refreshes).toBe(0);
    });
    await expect(ownerPage).toHaveURL(/\/login(?:\?|$)/);
    await expect(ownerPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    const authCookies = (await ownerPage.context().cookies()).filter((cookie) =>
      ['charitypilot_access', 'charitypilot_refresh'].includes(cookie.name));
    expect(authCookies).toEqual([]);
    const replayCount = await withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM "SecurityAuditEvent" WHERE "organisationId" = $1 AND "type" = $2',
        [owner.organisationId, 'SESSION_REPLAY_DETECTED'],
      );
      return result.rows[0].count;
    });
    expect(replayCount).toBe(0);
  });

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

  test('password recovery atomically changes the password, revokes sessions, and records security evidence', async ({ page, newFencedContext, browserOriginFence }) => {
    const email = uniqueEmail('reset');
    const newPassword = 'NewPass123';

    await createVerifiedOwner({
      email,
      password: TEST_PASSWORD,
      name: 'Reset Flow User',
      organisationName: 'Reset Flow Charity',
    });

    const firstOldSession = await newFencedContext();
    const secondOldSession = await newFencedContext();
    const firstOldSessionPage = await firstOldSession.newPage();
    const secondOldSessionPage = await secondOldSession.newPage();

    try {
      await loginViaUi(firstOldSessionPage, email, TEST_PASSWORD);
      await loginViaUi(secondOldSessionPage, email, TEST_PASSWORD);

      await requestPasswordResetViaUi(page, email);

      const token = await injectResetToken(email);
      await page.goto('about:blank');
      await gotoWithDevServerRetry(page, `/reset-password#token=${token}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => new URL(page.url()).hash).toBe('');
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
      await expect(page.getByText(/every existing session has been signed out/i)).toBeVisible();

      const evidence = await getPasswordRecoveryResetEvidence(email, token);
      expect(evidence.activeSessionCount).toBe(0);
      expect(evidence.passwordResetSessionCount).toBeGreaterThanOrEqual(2);
      expect(evidence.outstandingRecoveryCount).toBe(0);
      expect(evidence.completedRecoveryCount).toBeGreaterThanOrEqual(1);
      expect(evidence.resetAuditCount).toBe(1);
      expect(evidence.completionOutboxCount).toBe(1);
      expect(evidence.legacyResetSlotCleared).toBe(true);
      expect(evidence.plaintextArtifactCount).toBe(0);

      const revokedSessionStatuses = await Promise.all(
        [firstOldSessionPage, secondOldSessionPage].map((oldSessionPage) =>
          oldSessionPage.evaluate(async (apiOrigin) => {
            const response = await fetch(`${apiOrigin}/api/v1/auth/me`, {
              credentials: 'include',
            });
            await response.arrayBuffer();
            return response.status;
          }, browserOriginFence.apiOrigin),
        ),
      );
      expect(revokedSessionStatuses).toEqual([401, 401]);

      await page.goto('about:blank');
      await gotoWithDevServerRetry(page, `/reset-password#token=${token}`, { waitUntil: 'domcontentloaded' });
      await fillResetPasswordForm(page, newPassword);
      const replayRequest = page.waitForResponse(
        (response) => /\/api\/v1\/auth\/reset-password/.test(response.url()) && response.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: 'Reset password' }).click();
      expect((await replayRequest).status()).toBe(400);
      await expect(
        page.getByText("Reset link not accepted", { exact: true }),
      ).toBeVisible();

      await gotoWithDevServerRetry(page, '/login');
      await reliableFill(page.getByLabel('Email address'), email);
      await reliableFill(page.getByLabel('Password', { exact: true }), TEST_PASSWORD);
      const oldPasswordLogin = page.waitForResponse(
        (response) => /\/api\/v1\/auth\/login/.test(response.url()) && response.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: 'Sign in' }).click();
      expect((await oldPasswordLogin).status()).toBe(401);
      await expect(page.getByText(/invalid email or password/i)).toBeVisible();
      await expect(page).toHaveURL(/\/login/);

      await loginViaUi(page, email, newPassword);
      await expect(page).toHaveURL(/\/dashboard/);
      await gotoWithDevServerRetry(page, '/team');
      await expect(
        page.getByText('Password reset completed', { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await Promise.all([
        firstOldSession.close().catch(() => undefined),
        secondOldSession.close().catch(() => undefined),
      ]);
    }
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
    await expect(
      page.getByText("Reset link not accepted", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
  });
});
