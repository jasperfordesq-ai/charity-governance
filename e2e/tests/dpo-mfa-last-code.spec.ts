import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fromBase32, totp } from '../../apps/api/src/utils/totp';
import { test, expect, reliableFill } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { createAuthenticatedStorageState, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe('last recovery code browser proof', () => {
  test.skip(IS_DEPLOYED_QA, 'This changes a disposable synthetic account and database.');

  test('last-code sign-in permits password-proved MFA removal in that session family', async ({ owner, ownerPage, newFencedContext }) => {
    test.setTimeout(120_000);
    await gotoWithDevServerRetry(ownerPage, '/security-data');
    const setup = ownerPage.locator('section').filter({ has: ownerPage.getByRole('heading', { name: 'Your two-step sign-in' }) });
    await expect(setup.getByText('Off · password sign-in')).toBeVisible();
    await reliableFill(setup.getByLabel('Current password'), owner.password);
    const begun = ownerPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/second-factor/begin') && response.request().method() === 'POST');
    await setup.getByRole('button', { name: 'Set up authenticator' }).click();
    const beginResponse = await begun;
    expect(beginResponse.status()).toBe(200);
    const beginPayload = (await beginResponse.json()) as { secret?: string };
    const secret = beginPayload.secret;
    if (!secret) throw new Error('Authenticator setup returned no secret');
    await reliableFill(setup.getByLabel('Authenticator code'), totp(fromBase32(secret)));
    const completed = ownerPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/second-factor/complete') && response.request().method() === 'POST');
    await setup.getByRole('button', { name: 'Confirm and turn on' }).click();
    const completeResponse = await completed;
    expect(completeResponse.status()).toBe(200);
    const completePayload = (await completeResponse.json()) as { recoveryCodes?: string[] };
    const codes = completePayload.recoveryCodes;
    if (!codes || codes.length !== 10) throw new Error('Authenticator setup returned an unexpected recovery-code count');
    await expect(setup.getByText('Save these codes now. They will not be shown again.')).toBeVisible();

    const lastCode = codes[0];
    const lastHash = createHash('sha256').update(lastCode.replace(/[^0-9A-Za-z]/g, '').toUpperCase()).digest('hex');
    const retired = await withDb((client) => client.query(
      `UPDATE "UserSecondFactorRecoveryCode" SET "usedAt" = now()
        WHERE "userId" = $1 AND "usedAt" IS NULL AND "codeHash" <> $2`,
      [owner.userId, lastHash],
    ));
    assert.equal(retired.rowCount, 9);

    const context = await newFencedContext();
    const page = await context.newPage();
    let loginStatus: number | null = null;
    for (let attempt = 0; attempt < 3 && loginStatus === null; attempt += 1) {
      await gotoWithDevServerRetry(page, '/login');
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await page.waitForLoadState('load');
      await page.waitForTimeout(1000);
      await reliableFill(page.getByLabel('Email address'), owner.email);
      await reliableFill(page.getByLabel('Password', { exact: true }), owner.password);
      await reliableFill(page.getByLabel('Authenticator or recovery code'), lastCode);
      const submitted = page.waitForResponse((response) =>
        response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
      { timeout: 8000 }).catch(() => null);
      await page.getByRole('button', { name: 'Sign in' }).click();
      loginStatus = (await submitted)?.status() ?? null;
    }
    expect(loginStatus).toBe(200);
    await expect(page).toHaveURL(/\/dashboard/);
    const sameFamilyProof = await withDb(async (client) => {
      const result = await client.query<{ same_family: boolean; unused: string }>(
        `SELECT EXISTS (
           SELECT 1 FROM "SecurityAuditEvent" event
           JOIN "AuthSession" session ON session."familyId"::text = event."subjectSessionId"
           WHERE event."organisationId" = $2 AND event."subjectUserId" = $1
             AND event."type" = 'SECOND_FACTOR_RECOVERY_USED'
             AND event."reason" = 'A one-time recovery code was used for sign-in.'
             AND session."userId" = $1 AND session."revokedAt" IS NULL
         ) AS same_family,
         (SELECT count(*)::text FROM "UserSecondFactorRecoveryCode"
           WHERE "userId" = $1 AND "usedAt" IS NULL) AS unused`,
        [owner.userId, owner.organisationId],
      );
      return result.rows[0];
    });
    assert.equal(sameFamilyProof?.same_family, true);
    assert.equal(sameFamilyProof?.unused, '0');

    const otherStorage = await createAuthenticatedStorageState({
      userId: owner.userId, organisationId: owner.organisationId, role: 'OWNER',
    });
    const otherContext = await newFencedContext({ storageState: otherStorage });
    const otherPage = await otherContext.newPage();
    await gotoWithDevServerRetry(otherPage, '/security-data');
    const otherRemoval = otherPage.locator('section').filter({ has: otherPage.getByRole('heading', { name: 'Your two-step sign-in' }) });
    await expect(otherRemoval.getByText('On · 0 unused recovery codes')).toBeVisible();
    await reliableFill(otherRemoval.getByLabel('Current password'), owner.password);
    const refused = otherPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/second-factor/remove') && response.request().method() === 'POST');
    await otherRemoval.getByRole('button', { name: 'Turn off two-step sign-in' }).click();
    expect((await refused).status()).toBe(401);
    await expect(otherRemoval.getByText('On · 0 unused recovery codes')).toBeVisible();
    await otherContext.close();

    await gotoWithDevServerRetry(page, '/security-data');
    const removal = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your two-step sign-in' }) });
    await expect(removal.getByText('On · 0 unused recovery codes')).toBeVisible();
    await reliableFill(removal.getByLabel('Current password'), owner.password);
    await expect(removal.getByLabel('Authenticator or recovery code')).toHaveValue('');
    const removed = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/second-factor/remove') && response.request().method() === 'POST');
    await removal.getByRole('button', { name: 'Turn off two-step sign-in' }).click();
    expect((await removed).status()).toBe(200);
    await expect(page).toHaveURL(/\/login/);
    const stillEnrolled = await withDb(async (client) => {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "UserSecondFactor" WHERE "userId" = $1) AS exists`, [owner.userId],
      );
      return result.rows[0]?.exists;
    });
    assert.equal(stillEnrolled, false);
    await context.close();
  });
});
