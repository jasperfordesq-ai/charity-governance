import type { BrowserContext, Page } from '@playwright/test';
import { TEST_PASSWORD, expect, test, uniqueEmail } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import {
  createAuthenticatedStorageState,
  createVerifiedAdmin,
  createVerifiedOwner,
  sha256Hex,
  withDb,
} from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

type ApiResult = {
  status: number;
  body: unknown;
};

type RawAuthResult = ApiResult & {
  accessToken?: string;
  refreshToken?: string;
};

type TeamMemberContract = {
  id: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  membershipVersion: number;
};

async function openOriginPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await gotoWithDevServerRetry(page, '/', { waitUntil: 'domcontentloaded' });
  return page;
}

async function callApi(
  page: Page,
  apiOrigin: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {},
): Promise<ApiResult> {
  return page.evaluate(
    async ({ origin, requestPath, method, body }) => {
      const response = await fetch(`${origin}${requestPath}`, {
        method,
        credentials: 'include',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed };
    },
    {
      origin: apiOrigin,
      requestPath: path,
      method: options.method ?? 'GET',
      body: options.body,
    },
  );
}

function responseCookie(response: Response, name: string): string | undefined {
  const prefix = `${name}=`;
  const header = response.headers.getSetCookie().find((value) => value.startsWith(prefix));
  const encodedValue = header?.slice(prefix.length).split(';', 1)[0];
  return encodedValue ? decodeURIComponent(encodedValue) : undefined;
}

async function callRawRefreshEndpoint(
  apiOrigin: string,
  webOrigin: string,
  path: '/api/v1/auth/refresh' | '/api/v1/auth/logout',
  refreshToken: string,
): Promise<RawAuthResult> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: webOrigin,
    },
    body: JSON.stringify({ refreshToken }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return {
    status: response.status,
    body,
    accessToken: responseCookie(response, 'charitypilot_access'),
    refreshToken: responseCookie(response, 'charitypilot_refresh'),
  };
}

async function probeRawAccessToken(apiOrigin: string, accessToken: string): Promise<number> {
  const response = await fetch(`${apiOrigin}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await response.arrayBuffer();
  return response.status;
}

function teamMembers(body: unknown): TeamMemberContract[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Team endpoint returned a non-object response');
  }
  const members = (body as { members?: unknown }).members;
  if (!Array.isArray(members)) {
    throw new Error('Team endpoint response did not include members');
  }
  return members as TeamMemberContract[];
}

async function authFamilyState(refreshToken: string): Promise<{
  familyId: string;
  totalCount: number;
  activeCount: number;
  revocationReasons: string[];
}> {
  return withDb(async (client) => {
    const result = await client.query<{
      familyId: string;
      totalCount: number;
      activeCount: number;
      revocationReasons: string[];
    }>(
      `WITH original AS (
         SELECT "userId", "familyId"
           FROM "AuthSession"
          WHERE "refreshTokenHash" = $1
      )
      SELECT family."familyId",
             COUNT(*)::int AS "totalCount",
             (COUNT(*) FILTER (
               WHERE family."revokedAt" IS NULL AND family."expiresAt" > NOW()
             ))::int AS "activeCount",
             COALESCE(
               ARRAY_AGG(family."revocationReason"::text ORDER BY family."createdAt")
                 FILTER (WHERE family."revocationReason" IS NOT NULL),
               ARRAY[]::text[]
             ) AS "revocationReasons"
        FROM original
        JOIN "AuthSession" AS family
          ON family."userId" = original."userId"
         AND family."familyId" = original."familyId"
       GROUP BY family."familyId"`,
      [sha256Hex(refreshToken)],
    );
    const state = result.rows[0];
    if (!state) throw new Error('Refresh-token family was not found in the disposable database');
    return state;
  });
}

async function membershipSecurityState(userId: string): Promise<{
  lifecycleStatus: string;
  activeSessionCount: number;
  revocationReasons: string[];
}> {
  return withDb(async (client) => {
    const result = await client.query<{
      lifecycleStatus: string;
      activeSessionCount: number;
      revocationReasons: string[];
    }>(
      `SELECT account."lifecycleStatus"::text AS "lifecycleStatus",
              (COUNT(session."id") FILTER (
                WHERE session."revokedAt" IS NULL AND session."expiresAt" > NOW()
              ))::int AS "activeSessionCount",
              COALESCE(
                ARRAY_AGG(session."revocationReason"::text ORDER BY session."createdAt")
                  FILTER (WHERE session."revocationReason" IS NOT NULL),
                ARRAY[]::text[]
              ) AS "revocationReasons"
         FROM "User" AS account
         LEFT JOIN "AuthSession" AS session ON session."userId" = account."id"
        WHERE account."id" = $1
        GROUP BY account."id", account."lifecycleStatus"`,
      [userId],
    );
    const state = result.rows[0];
    if (!state) throw new Error('Membership security state was not found');
    return state;
  });
}

test.describe('Team lifecycle security on real PostgreSQL and API infrastructure', () => {
  test.skip(IS_DEPLOYED_QA, 'Destructive lifecycle proofs require the identity-bound disposable database.');

  test('simultaneous reuse of one refresh token yields one rotation and quarantines its successor', async ({
    newFencedContext,
    browserOriginFence,
  }) => {
    const principal = await createVerifiedOwner({
      email: uniqueEmail('refresh-race-owner'),
      password: TEST_PASSWORD,
      name: 'Refresh Race Owner',
      organisationName: 'Refresh Race Charity',
    });
    const storageState = await createAuthenticatedStorageState({
      userId: principal.userId,
      organisationId: principal.organisationId,
      role: 'OWNER',
    });
    const refreshToken = storageState.cookies.find(
      (cookie) => cookie.name === 'charitypilot_refresh',
    )?.value;
    if (!refreshToken) throw new Error('Disposable authenticated state did not contain a refresh cookie');

    // Separate cookie jars cloned from the exact same state guarantee both
    // requests carry the same original token even if one response wins first.
    const leftContext = await newFencedContext({ storageState });
    const rightContext = await newFencedContext({ storageState });
    try {
      const [leftPage, rightPage] = await Promise.all([
        openOriginPage(leftContext),
        openOriginPage(rightContext),
      ]);
      const results = await Promise.all([
        callApi(leftPage, browserOriginFence.apiOrigin, '/api/v1/auth/refresh', {
          method: 'POST',
          body: {},
        }),
        callApi(rightPage, browserOriginFence.apiOrigin, '/api/v1/auth/refresh', {
          method: 'POST',
          body: {},
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
      await expect.poll(async () => (await authFamilyState(refreshToken)).activeCount).toBe(0);

      const family = await authFamilyState(refreshToken);
      expect(family.totalCount).toBe(2);
      expect(family.revocationReasons).toContain('ROTATED');
      expect(family.revocationReasons).toContain('REFRESH_REUSE');
    } finally {
      await Promise.all([
        leftContext.close().catch(() => undefined),
        rightContext.close().catch(() => undefined),
      ]);
    }
  });

  test('logout racing refresh revokes the whole family and invalidates any returned successor', async ({
    newFencedContext,
    browserOriginFence,
  }) => {
    const principal = await createVerifiedOwner({
      email: uniqueEmail('logout-refresh-race-owner'),
      password: TEST_PASSWORD,
      name: 'Logout Refresh Race Owner',
      organisationName: 'Logout Refresh Race Charity',
    });
    const storageState = await createAuthenticatedStorageState({
      userId: principal.userId,
      organisationId: principal.organisationId,
      role: 'OWNER',
    });
    const originalRefreshToken = storageState.cookies.find(
      (cookie) => cookie.name === 'charitypilot_refresh',
    )?.value;
    const originalAccessToken = storageState.cookies.find(
      (cookie) => cookie.name === 'charitypilot_access',
    )?.value;
    if (!originalRefreshToken) {
      throw new Error('Disposable authenticated state did not contain a refresh cookie');
    }
    if (!originalAccessToken) {
      throw new Error('Disposable authenticated state did not contain an access cookie');
    }

    // Keep logout as a real browser-origin HttpOnly-cookie request. The racing
    // refresh uses raw loopback HTTP solely so the test can retain and replay
    // the real Set-Cookie credentials even though Chromium refuses production
    // Secure response cookies on this HTTP disposable transport.
    const logoutContext = await newFencedContext({ storageState });
    try {
      const logoutPage = await openOriginPage(logoutContext);
      const [refreshResult, logoutResult] = await Promise.all([
        callRawRefreshEndpoint(
          browserOriginFence.apiOrigin,
          browserOriginFence.webOrigin,
          '/api/v1/auth/refresh',
          originalRefreshToken,
        ),
        callApi(logoutPage, browserOriginFence.apiOrigin, '/api/v1/auth/logout', {
          method: 'POST',
          body: {},
        }),
      ]);

      expect(logoutResult.status).toBe(200);
      expect([200, 401]).toContain(refreshResult.status);
      await expect.poll(
        async () => (await authFamilyState(originalRefreshToken)).activeCount,
      ).toBe(0);

      const family = await authFamilyState(originalRefreshToken);
      expect(family.revocationReasons).toContain('LOGOUT');
      expect(await probeRawAccessToken(browserOriginFence.apiOrigin, originalAccessToken)).toBe(401);

      const originalRefreshProbe = await callRawRefreshEndpoint(
        browserOriginFence.apiOrigin,
        browserOriginFence.webOrigin,
        '/api/v1/auth/refresh',
        originalRefreshToken,
      );
      expect(originalRefreshProbe.status).toBe(401);

      if (refreshResult.status === 200) {
        expect(family.totalCount).toBe(2);
        expect(family.revocationReasons).toContain('ROTATED');
        const returnedAccessToken = refreshResult.accessToken;
        const returnedRefreshToken = refreshResult.refreshToken;
        expect(Boolean(
          returnedAccessToken &&
          returnedRefreshToken &&
          returnedRefreshToken !== originalRefreshToken
        )).toBe(true);
        if (!returnedAccessToken || !returnedRefreshToken) {
          throw new Error('Successful refresh did not return both rotated auth cookies');
        }
        expect(await probeRawAccessToken(browserOriginFence.apiOrigin, returnedAccessToken)).toBe(401);
        const successorRefreshProbe = await callRawRefreshEndpoint(
          browserOriginFence.apiOrigin,
          browserOriginFence.webOrigin,
          '/api/v1/auth/refresh',
          returnedRefreshToken,
        );
        expect(successorRefreshProbe.status).toBe(401);
      }

      expect((await authFamilyState(originalRefreshToken)).activeCount).toBe(0);
    } finally {
      await logoutContext.close().catch(() => undefined);
    }
  });

  for (const action of ['suspend', 'remove'] as const) {
    test(`${action} immediately denies the affected admin session a valid read and write`, async ({
      newFencedContext,
      browserOriginFence,
    }) => {
      const owner = await createVerifiedOwner({
        email: uniqueEmail(`${action}-owner`),
        password: TEST_PASSWORD,
        name: `${action} Owner`,
        organisationName: `${action} Lifecycle Charity`,
      });
      const target = await createVerifiedAdmin({
        email: uniqueEmail(`${action}-admin`),
        name: `${action} Admin`,
        organisationId: owner.organisationId,
      });
      const ownerState = await createAuthenticatedStorageState({
        userId: owner.userId,
        organisationId: owner.organisationId,
        role: 'OWNER',
      });
      const targetState = await createAuthenticatedStorageState({
        userId: target.userId,
        organisationId: target.organisationId,
        role: 'ADMIN',
      });

      const ownerContext = await newFencedContext({ storageState: ownerState });
      const readContext = await newFencedContext({ storageState: targetState });
      const writeContext = await newFencedContext({ storageState: targetState });
      try {
        const [ownerPage, readPage, writePage] = await Promise.all([
          openOriginPage(ownerContext),
          openOriginPage(readContext),
          openOriginPage(writeContext),
        ]);

        const validRead = await callApi(
          readPage,
          browserOriginFence.apiOrigin,
          '/api/v1/deadlines?page=1&pageSize=1',
        );
        expect(validRead.status).toBe(200);

        const validWrite = await callApi(
          writePage,
          browserOriginFence.apiOrigin,
          '/api/v1/deadlines',
          {
            method: 'POST',
            body: {
              title: `Before ${action} ${Date.now()}`,
              dueDate: '2030-12-31',
              reminderDays: [30],
            },
          },
        );
        expect(validWrite.status).toBe(201);

        const team = await callApi(ownerPage, browserOriginFence.apiOrigin, '/api/v1/team');
        expect(team.status).toBe(200);
        const targetMembership = teamMembers(team.body).find((member) => member.id === target.userId);
        if (!targetMembership) throw new Error('Target membership was absent from the owner team response');

        const lifecycleMutation = await callApi(
          ownerPage,
          browserOriginFence.apiOrigin,
          `/api/v1/team/members/${target.userId}/${action}`,
          {
            method: 'POST',
            body: {
              expectedMembershipVersion: targetMembership.membershipVersion,
              reason: `E2E ${action} immediate session revocation proof`,
            },
          },
        );
        expect(lifecycleMutation.status).toBe(200);

        // Independent cloned jars prove both calls present the previously valid
        // session rather than the second assertion merely observing cleared cookies.
        const [deniedRead, deniedWrite] = await Promise.all([
          callApi(
            readPage,
            browserOriginFence.apiOrigin,
            '/api/v1/deadlines?page=1&pageSize=1',
          ),
          callApi(writePage, browserOriginFence.apiOrigin, '/api/v1/deadlines', {
            method: 'POST',
            body: {
              title: `After ${action} ${Date.now()}`,
              dueDate: '2031-12-31',
              reminderDays: [30],
            },
          }),
        ]);
        expect(deniedRead.status).toBe(401);
        expect(deniedWrite.status).toBe(401);

        const securityState = await membershipSecurityState(target.userId);
        expect(securityState.lifecycleStatus).toBe(action === 'suspend' ? 'SUSPENDED' : 'REMOVED');
        expect(securityState.activeSessionCount).toBe(0);
        expect(securityState.revocationReasons).toContain(
          action === 'suspend' ? 'MEMBER_SUSPENDED' : 'MEMBER_REMOVED',
        );
      } finally {
        await Promise.all([
          ownerContext.close().catch(() => undefined),
          readContext.close().catch(() => undefined),
          writeContext.close().catch(() => undefined),
        ]);
      }
    });
  }

  test('ownership transfer leaves one active owner and revokes both principals sessions', async ({
    newFencedContext,
    browserOriginFence,
  }) => {
    const oldOwner = await createVerifiedOwner({
      email: uniqueEmail('transfer-old-owner'),
      password: TEST_PASSWORD,
      name: 'Old Owner',
      organisationName: 'Ownership Transfer Charity',
    });
    const newOwner = await createVerifiedAdmin({
      email: uniqueEmail('transfer-new-owner'),
      name: 'New Owner',
      organisationId: oldOwner.organisationId,
    });
    const oldOwnerState = await createAuthenticatedStorageState({
      userId: oldOwner.userId,
      organisationId: oldOwner.organisationId,
      role: 'OWNER',
    });
    const newOwnerState = await createAuthenticatedStorageState({
      userId: newOwner.userId,
      organisationId: newOwner.organisationId,
      role: 'ADMIN',
    });

    const actionContext = await newFencedContext({ storageState: oldOwnerState });
    const oldOwnerProbeContext = await newFencedContext({ storageState: oldOwnerState });
    const newOwnerProbeContext = await newFencedContext({ storageState: newOwnerState });
    try {
      const [actionPage, oldOwnerProbePage, newOwnerProbePage] = await Promise.all([
        openOriginPage(actionContext),
        openOriginPage(oldOwnerProbeContext),
        openOriginPage(newOwnerProbeContext),
      ]);
      const preflight = await Promise.all([
        callApi(oldOwnerProbePage, browserOriginFence.apiOrigin, '/api/v1/team'),
        callApi(newOwnerProbePage, browserOriginFence.apiOrigin, '/api/v1/team'),
      ]);
      expect(preflight.map((result) => result.status)).toEqual([200, 200]);

      const team = await callApi(actionPage, browserOriginFence.apiOrigin, '/api/v1/team');
      expect(team.status).toBe(200);
      const members = teamMembers(team.body);
      const currentOwner = members.find((member) => member.id === oldOwner.userId);
      const targetOwner = members.find((member) => member.id === newOwner.userId);
      if (!currentOwner || !targetOwner) {
        throw new Error('Ownership transfer principals were absent from the team response');
      }

      const transfer = await callApi(
        actionPage,
        browserOriginFence.apiOrigin,
        '/api/v1/team/ownership/transfer',
        {
          method: 'POST',
          body: {
            targetMemberId: newOwner.userId,
            expectedCurrentOwnerVersion: currentOwner.membershipVersion,
            expectedTargetVersion: targetOwner.membershipVersion,
            confirmation: 'TRANSFER OWNERSHIP',
            reason: 'E2E atomic ownership transfer and session revocation proof',
          },
        },
      );
      expect(transfer.status).toBe(200);

      const [oldOwnerDenied, newOwnerDenied] = await Promise.all([
        callApi(oldOwnerProbePage, browserOriginFence.apiOrigin, '/api/v1/team'),
        callApi(newOwnerProbePage, browserOriginFence.apiOrigin, '/api/v1/team'),
      ]);
      expect(oldOwnerDenied.status).toBe(401);
      expect(newOwnerDenied.status).toBe(401);

      const databaseState = await withDb(async (client) => {
        const membersResult = await client.query<{
          id: string;
          role: string;
          lifecycleStatus: string;
          activeSessionCount: number;
          revocationReasons: string[];
        }>(
          `SELECT account."id",
                  account."role"::text AS "role",
                  account."lifecycleStatus"::text AS "lifecycleStatus",
                  (COUNT(session."id") FILTER (
                    WHERE session."revokedAt" IS NULL AND session."expiresAt" > NOW()
                  ))::int AS "activeSessionCount",
                  COALESCE(
                    ARRAY_AGG(session."revocationReason"::text ORDER BY session."createdAt")
                      FILTER (WHERE session."revocationReason" IS NOT NULL),
                    ARRAY[]::text[]
                  ) AS "revocationReasons"
             FROM "User" AS account
             LEFT JOIN "AuthSession" AS session ON session."userId" = account."id"
            WHERE account."organisationId" = $1
            GROUP BY account."id", account."role", account."lifecycleStatus"
            ORDER BY account."id"`,
          [oldOwner.organisationId],
        );
        return membersResult.rows;
      });

      const activeOwners = databaseState.filter(
        (member) => member.role === 'OWNER' && member.lifecycleStatus === 'ACTIVE',
      );
      expect(activeOwners.map((member) => member.id)).toEqual([newOwner.userId]);

      const oldOwnerStateAfter = databaseState.find((member) => member.id === oldOwner.userId);
      const newOwnerStateAfter = databaseState.find((member) => member.id === newOwner.userId);
      expect(oldOwnerStateAfter?.role).toBe('ADMIN');
      expect(newOwnerStateAfter?.role).toBe('OWNER');
      expect(oldOwnerStateAfter?.activeSessionCount).toBe(0);
      expect(newOwnerStateAfter?.activeSessionCount).toBe(0);
      expect(oldOwnerStateAfter?.revocationReasons).toContain('OWNERSHIP_CHANGED');
      expect(newOwnerStateAfter?.revocationReasons).toContain('OWNERSHIP_CHANGED');
    } finally {
      await Promise.all([
        actionContext.close().catch(() => undefined),
        oldOwnerProbeContext.close().catch(() => undefined),
        newOwnerProbeContext.close().catch(() => undefined),
      ]);
    }
  });
});
