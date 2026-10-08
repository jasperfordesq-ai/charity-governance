import { test, expect } from '../fixtures';
import { createHash } from 'node:crypto';
import { IS_DEPLOYED_QA } from '../env';
import { createAuthenticatedStorageState, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe('DPO session replay concurrency', () => {
  test.skip(IS_DEPLOYED_QA, 'Session manipulation requires the identity-bound disposable database.');

  test('a spent refresh records its earlier revocation time for restricted review', async ({
    owner,
    ownerPage,
    request,
    browserOriginFence,
  }) => {
    test.setTimeout(120_000);
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const refreshToken = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_refresh')?.value;
    if (!refreshToken) throw new Error('Disposable session has no refresh cookie');
    const refreshUrl = `${browserOriginFence.apiOrigin}/api/v1/auth/refresh`;
    const refreshRequest = { data: { refreshToken }, headers: { origin: browserOriginFence.webOrigin } };
    expect((await request.post(refreshUrl, refreshRequest)).status()).toBe(200);
    expect((await request.post(refreshUrl, refreshRequest)).status()).toBe(401);

    const audit = await withDb(async (client) => {
      const event = await client.query<{
        id: string; occurredAtUtc: string; revokedAtUtc: string | null; earlierRevokedAt: string | null;
      }>(
        `SELECT event."id",
                to_char(event."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAtUtc",
                to_char(session."revokedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "revokedAtUtc",
                event."context"->>'presentedSessionRevokedAt' AS "earlierRevokedAt"
           FROM "SecurityAuditEvent" event
           JOIN "AuthSession" session ON session."familyId"::text = event."subjectSessionId"
          WHERE event."organisationId" = $1
            AND event."type" = 'SESSION_REPLAY_DETECTED'
            AND session."refreshTokenHash" = $2`,
        [owner.organisationId, createHash('sha256').update(refreshToken).digest('hex')],
      );
      expect(event.rows).toHaveLength(1);
      return event.rows[0];
    });
    expect(audit.revokedAtUtc).not.toBeNull();
    expect(audit.earlierRevokedAt).toBe(audit.revokedAtUtc);
    expect(new Date(audit.earlierRevokedAt!).getTime()).toBeLessThanOrEqual(new Date(audit.occurredAtUtc).getTime());

    await gotoWithDevServerRetry(ownerPage, '/security-data');
    const replayPanel = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Session replay diagnostics' }),
    });
    await expect(replayPanel.getByText(`Event ID: ${audit.id}`, { exact: true })).toBeVisible();
    await expect(replayPanel.getByText(`Spent session revoked at: ${audit.earlierRevokedAt}`, { exact: true })).toBeVisible();
  });

  test('two tabs renew one browser session without presenting a spent refresh token', async ({
    owner,
    newFencedContext,
    browserOriginFence,
  }) => {
    test.setTimeout(120_000);
    // The Owner charity is worker-scoped. An earlier case may deliberately
    // leave a replay event there, so compare this journey's before/after count.
    const replayCount = () => withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM "SecurityAuditEvent"
          WHERE "organisationId" = $1 AND "type" = 'SESSION_REPLAY_DETECTED'`,
        [owner.organisationId],
      );
      return result.rows[0]?.count ?? 0;
    });
    const beforeReplayCount = await replayCount();
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const context = await newFencedContext({ storageState });
    const pages = [await context.newPage(), await context.newPage()];

    for (const page of pages) {
      await gotoWithDevServerRetry(page, '/security-data');
      await expect(page.getByRole('heading', { name: 'Session replay diagnostics' })).toBeVisible();
    }
    expect(await pages[0].evaluate(() => Boolean(navigator.locks && localStorage))).toBe(true);

    const accessCookie = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_access');
    if (!accessCookie) throw new Error('Disposable session has no access cookie');
    await context.addCookies([{ ...accessCookie, value: 'expired-access-token' }]);

    let refreshCount = 0;
    let unauthorizedCount = 0;
    for (const page of pages) {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/auth/refresh') refreshCount += 1;
      });
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/v1/team/replay-diagnostics' && response.status() === 401) {
          unauthorizedCount += 1;
        }
      });
    }

    const successResponses = pages.map((page) => page.waitForResponse((response) =>
      response.url().startsWith(`${browserOriginFence.apiOrigin}/api/v1/team/replay-diagnostics`)
      && response.status() === 200));
    await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Refresh', exact: true }).click()));
    await Promise.all(successResponses);

    expect(unauthorizedCount).toBeGreaterThanOrEqual(1);
    expect(unauthorizedCount).toBeLessThanOrEqual(2);
    expect(refreshCount).toBe(1);
    for (const page of pages) {
      await expect(page.getByRole('heading', { name: 'Security & Data', exact: true })).toBeVisible();
    }
    expect(await replayCount()).toBe(beforeReplayCount);
  });

  test('a second tab cannot refresh a cookie while browser sign-out is finishing', async ({
    owner,
    newFencedContext,
    browserOriginFence,
  }) => {
    test.setTimeout(120_000);
    const replayCount = () => withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM "SecurityAuditEvent"
          WHERE "organisationId" = $1 AND "type" = 'SESSION_REPLAY_DETECTED'`,
        [owner.organisationId],
      );
      return result.rows[0]?.count ?? 0;
    });
    const before = await replayCount();
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const context = await newFencedContext({ storageState });
    const signingOutPage = await context.newPage();
    const waitingPage = await context.newPage();
    for (const page of [signingOutPage, waitingPage]) {
      await gotoWithDevServerRetry(page, '/security-data');
      await expect(page.getByRole('heading', { name: 'Session replay diagnostics' })).toBeVisible();
    }
    expect(await signingOutPage.evaluate(() => Boolean(navigator.locks && localStorage))).toBe(true);

    let logoutReached!: () => void;
    const serverRevoked = new Promise<void>((resolve) => { logoutReached = resolve; });
    let finishLogout!: () => void;
    const deliverLogout = new Promise<void>((resolve) => { finishLogout = resolve; });
    // Let the server revoke the session, but hold the browser response (and
    // its cookie clearance) until the other tab has received a 401. This
    // reproduces the narrow post-logout window without copying a token.
    await signingOutPage.route('**/api/v1/auth/logout', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      logoutReached();
      await deliverLogout;
      await route.fulfill({ response });
    });
    let refreshes = 0;
    waitingPage.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/auth/refresh') refreshes += 1;
    });

    const logoutClick = signingOutPage.getByRole('button', { name: 'Logout', exact: true }).click();
    await serverRevoked;
    const unauthorised = waitingPage.waitForResponse((response) =>
      response.url().startsWith(`${browserOriginFence.apiOrigin}/api/v1/team/replay-diagnostics`)
      && response.status() === 401);
    await waitingPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await unauthorised;
    finishLogout();
    await logoutClick;
    await expect(signingOutPage).toHaveURL(/\/login(?:\?|$)/);
    await expect(waitingPage).toHaveURL(/\/login/);
    expect(refreshes).toBe(0);
    expect(await replayCount()).toBe(before);
  });

  test('an expired protected page renews in the browser without a proxy replay', async ({
    owner,
    newFencedContext,
  }) => {
    test.setTimeout(120_000);
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const context = await newFencedContext({ storageState });
    const accessCookie = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_access');
    if (!accessCookie) throw new Error('Disposable session has no access cookie');
    await context.addCookies([{ ...accessCookie, value: 'expired-access-token' }]);
    const page = await context.newPage();
    let refreshCalls = 0;
    let renewalRedirects = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/auth/refresh') refreshCalls += 1;
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/security-data' && response.status() === 307 &&
        response.headers()['location']?.includes('/session-renew')) renewalRedirects += 1;
    });
    const before = await withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM "SecurityAuditEvent"
          WHERE "organisationId" = $1 AND "type" = 'SESSION_REPLAY_DETECTED'`,
        [owner.organisationId],
      );
      return result.rows[0]?.count ?? 0;
    });

    await gotoWithDevServerRetry(page, '/security-data');
    await expect(page.getByRole('heading', { name: 'Security & Data', exact: true })).toBeVisible();
    expect(renewalRedirects).toBeGreaterThanOrEqual(1);
    expect(refreshCalls).toBe(1);
    const after = await withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM "SecurityAuditEvent"
          WHERE "organisationId" = $1 AND "type" = 'SESSION_REPLAY_DETECTED'`,
        [owner.organisationId],
      );
      return result.rows[0]?.count ?? 0;
    });
    expect(after).toBe(before);
  });

  test('an expired browser without Web Locks signs in again without refresh reuse', async ({
    owner,
    newFencedContext,
  }) => {
    test.setTimeout(120_000);
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const context = await newFencedContext({ storageState });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });
    const accessCookie = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_access');
    if (!accessCookie) throw new Error('Disposable session has no access cookie');
    await context.addCookies([{ ...accessCookie, value: 'expired-access-token' }]);
    const page = await context.newPage();
    let refreshCalls = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/auth/refresh') refreshCalls += 1;
    });
    const countReplay = () => withDb(async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM "SecurityAuditEvent"
          WHERE "organisationId" = $1 AND "type" = 'SESSION_REPLAY_DETECTED'`,
        [owner.organisationId],
      );
      return result.rows[0]?.count ?? 0;
    });
    const before = await countReplay();
    await gotoWithDevServerRetry(page, '/security-data');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByText('Your browser could not safely renew this session. Please sign in again.')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('session')).toBe('renewal-unavailable');
    expect(refreshCalls).toBe(0);
    expect(await countReplay()).toBe(before);
  });

  test('an invalid refresh cookie cannot render a protected page', async ({
    owner,
    newFencedContext,
  }) => {
    test.setTimeout(120_000);
    const storageState = await createAuthenticatedStorageState({
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'OWNER',
    });
    const context = await newFencedContext({ storageState });
    const accessCookie = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_access');
    const refreshCookie = storageState.cookies.find((cookie) => cookie.name === 'charitypilot_refresh');
    if (!accessCookie || !refreshCookie) throw new Error('Disposable session has no auth cookies');
    await context.addCookies([
      { ...accessCookie, value: 'expired-access-token' },
      { ...refreshCookie, value: 'invalid-refresh-token' },
    ]);
    const page = await context.newPage();
    await gotoWithDevServerRetry(page, '/security-data');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
    await expect(page.getByRole('heading', { name: 'Security & Data', exact: true })).toHaveCount(0);
  });
});
