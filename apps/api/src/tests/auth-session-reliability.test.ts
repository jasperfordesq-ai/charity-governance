import assert from 'node:assert/strict';
import test from 'node:test';

// Every env var read at import/construction time must be set BEFORE the dynamic imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-session-reliability-test-secret';

const [
  { default: Fastify },
  cookiePlugin,
  { authRoutes },
  { authGuard },
  { signAccessToken, verifyAccessToken },
  { rotateSessionTokens, hashOpaqueToken },
  { AuthService },
  { setAuthCookies, clearAuthCookies },
  { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE },
  { AppError },
  { apiLoggerOptionsForEnvironment },
  { default: bcrypt },
] = await Promise.all([
  import('fastify'),
  import('@fastify/cookie'),
  import('../routes/auth/index.js'),
  import('../middleware/auth.js'),
  import('../utils/jwt.js'),
  import('../services/session-tokens.js'),
  import('../services/auth.service.js'),
  import('../utils/auth-cookies.js'),
  import('../utils/auth-cookie-names.js'),
  import('../utils/errors.js'),
  import('../utils/logger.js'),
  import('bcryptjs'),
]);

const fastifyCookie = (cookiePlugin as { default?: unknown }).default ?? cookiePlugin;

function createReply() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

function publicOrganisation() {
  return {
    id: 'org-1',
    name: 'Org One',
    rcnNumber: null,
    croNumber: null,
    legalForm: 'CLG',
    legalFormConfirmedAt: null,
    complexity: 'STANDARD',
    charitablePurpose: null,
    financialYearEnd: null,
    registeredAddress: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    dateRegistered: null,
    incorporationDate: null,
    croAnnualReturnDate: null,
    croAnnualReturnDateConfirmedAt: null,
    lastActualAgmDate: null,
    lastUnanimousAnnualMemberResolutionDate: null,
    memberCount: null,
    conditionalObligationProfile: null,
    lifecycleStatus: 'ACTIVE',
    updatedAt: new Date('2026-07-10T00:00:00.000Z'),
  };
}

// ── auth-auth-session-8: login route issues cookies + returns the public user ──

test('login route issues auth cookies and returns the public user without secrets', async () => {
  const passwordHash = bcrypt.hashSync('NewPassword1', 12);
  let sessionCreated = false;
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie as never);
  app.decorate('prisma', {
    user: {
      findUnique: async () => ({
        id: 'u1',
        email: 'owner@example.org',
        name: 'Owner One',
        passwordHash,
        role: 'OWNER',
        emailVerified: true,
        lifecycleStatus: 'ACTIVE',
        organisationId: 'org-1',
        organisation: publicOrganisation(),
      }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [{
        id: 'u1',
        organisationId: 'org-1',
        role: 'OWNER',
        userLifecycleStatus: 'ACTIVE',
        organisationLifecycleStatus: 'ACTIVE',
      }],
      authSession: {
        create: async () => {
          sessionCreated = true;
          return { id: 's1' };
        },
      },
    }),
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.org', password: 'NewPassword1' },
    });

    assert.equal(response.statusCode, 200);
    assert.notEqual(response.headers['set-cookie'], undefined);
    assert.equal(sessionCreated, true);
    const body = response.json() as { user: Record<string, unknown> };
    assert.equal(body.user.id, 'u1');
    assert.equal(body.user.email, 'owner@example.org');
    assert.equal('passwordHash' in body.user, false);
    assert.equal('accessToken' in body, false);
    assert.equal('refreshToken' in body, false);
  } finally {
    await app.close();
  }
});

// ── x-auth-session-auth-session-6: no token at all → 401 UNAUTHORIZED ──

test('authGuard rejects requests with no bearer token and no access cookie', async () => {
  let sessionLookupRan = false;
  let userLookupRan = false;
  const request = {
    headers: {},
    cookies: {},
    server: {
      prisma: {
        authSession: {
          findFirst: async () => {
            sessionLookupRan = true;
            return { id: 's1' };
          },
        },
        user: {
          findUnique: async () => {
            userLookupRan = true;
            return { id: 'u1' };
          },
        },
      },
    },
  };
  const reply = createReply();

  await authGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 401);
  assert.deepEqual(reply.payload, {
    error: 'Missing or invalid authentication token',
    code: 'UNAUTHORIZED',
  });
  assert.equal((request as { user?: unknown }).user, undefined);
  assert.equal(sessionLookupRan, false);
  assert.equal(userLookupRan, false);
});

// ── x-auth-session-auth-session-7: cookie fallback authenticates ──

test('authGuard authenticates from the access-token cookie when no bearer header is present', async () => {
  const token = signAccessToken({
    userId: 'u1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  });
  const request = {
    headers: {},
    cookies: { [ACCESS_TOKEN_COOKIE]: token },
    server: {
      prisma: {
        authSession: {
          findFirst: async () => ({ id: 'session-1' }),
        },
        user: {
          findUnique: async () => ({
            id: 'u1',
            organisationId: 'org-1',
            role: 'OWNER',
            emailVerified: true,
          }),
        },
      },
    },
  };
  const reply = createReply();

  await authGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload, undefined);
  assert.deepEqual((request as { user?: unknown }).user, {
    userId: 'u1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  });
});

// ── x-auth-session-auth-session-8: happy-path rotation ──

test('refresh token rotation revokes the old session and issues a new session with a fresh hash', async () => {
  const future = new Date(Date.now() + 60_000);
  const familyCreatedAt = new Date(Date.now() - 60_000);
  const familyId = '00000000-0000-4000-8000-000000000010';
  let revokeWhere: Record<string, unknown> | undefined;
  let revokeData: Record<string, unknown> | undefined;
  let createdFamilyId = '';
  let createdFamilyAt: Date | undefined;
  let createdHash = '';
  const tx = {
    $queryRaw: async () => [{
      id: 'u1',
      organisationId: 'org-1',
      role: 'OWNER',
      userLifecycleStatus: 'ACTIVE',
      organisationLifecycleStatus: 'ACTIVE',
      sessionId: 's1',
      refreshTokenHash: hashOpaqueToken('old-token'),
      familyId,
      familyCreatedAt,
      expiresAt: future,
      revokedAt: null,
    }],
    authSession: {
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        revokeWhere = where;
        revokeData = data;
        return { id: 's1' };
      },
      create: async ({ data }: { data: { refreshTokenHash: string; familyId: string; familyCreatedAt: Date } }) => {
        createdHash = data.refreshTokenHash;
        createdFamilyId = data.familyId;
        createdFamilyAt = data.familyCreatedAt;
        return { id: 'session-2' };
      },
    },
  };
  const prisma = {
    $queryRaw: async () => [{ id: 's1', userId: 'u1', familyId }],
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };

  const result = await rotateSessionTokens(prisma as never, 'old-token');

  // A genuinely new opaque refresh token is returned (not the presented one).
  assert.notEqual(result.refreshToken, 'old-token');
  // The persisted hash is the SHA-256 of the NEW token, never the old token's hash.
  assert.equal(createdHash, hashOpaqueToken(result.refreshToken));
  assert.notEqual(createdHash, hashOpaqueToken('old-token'));
  // The old session row is the one revoked (scoped to id + not-yet-revoked).
  assert.equal(revokeWhere?.id, 's1');
  assert.equal(revokeData?.revocationReason, 'ROTATED');
  assert.ok(revokeData?.revokedAt instanceof Date);
  assert.equal(createdFamilyId, familyId);
  assert.equal(createdFamilyAt, familyCreatedAt);
  // The fresh access token is bound to the newly created session id.
  assert.equal(verifyAccessToken(result.accessToken).sessionId, 'session-2');
});

// ── x-auth-session-auth-session-10: unknown + expired refresh tokens ──

test('refresh rotation rejects unknown and expired refresh tokens without minting a session', async () => {
  // (a) Unknown token: $queryRaw returns no row.
  let createCalledUnknown = false;
  const unknownPrisma = {
    $queryRaw: async () => [],
    user: {
      findUnique: async () => {
        throw new Error('user lookup must not run for an unknown refresh token');
      },
    },
    authSession: {
      create: async () => {
        createCalledUnknown = true;
        return { id: 'should-not-happen' };
      },
    },
  };
  await assert.rejects(
    () => rotateSessionTokens(unknownPrisma as never, 'unknown-token'),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 401 && error.code === 'INVALID_REFRESH_TOKEN',
  );
  assert.equal(createCalledUnknown, false);

  // (b) Expired but not revoked token: row exists, expiresAt in the past.
  let createCalledExpired = false;
  const expiredPrisma = {
    $queryRaw: async () => [{
      id: 's1',
      userId: 'u1',
      familyId: '00000000-0000-4000-8000-000000000011',
    }],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [{
        id: 'u1',
        organisationId: 'org-1',
        role: 'OWNER',
        userLifecycleStatus: 'ACTIVE',
        organisationLifecycleStatus: 'ACTIVE',
        sessionId: 's1',
        refreshTokenHash: hashOpaqueToken('expired-token'),
        familyId: '00000000-0000-4000-8000-000000000011',
        familyCreatedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      }],
      authSession: {
        create: async () => {
          createCalledExpired = true;
          return { id: 'should-not-happen' };
        },
      },
    }),
  };
  await assert.rejects(
    () => rotateSessionTokens(expiredPrisma as never, 'expired-token'),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 401 && error.code === 'INVALID_REFRESH_TOKEN',
  );
  assert.equal(createCalledExpired, false);
});

// ── x-auth-session-auth-session-11: login persists hashed refresh token ──

test('login issues tokens and persists a session with the hashed refresh token on valid credentials', async () => {
  const passwordHash = bcrypt.hashSync('GoodPass1', 12);
  let storedHash = '';
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'u1',
        email: 'owner@example.org',
        name: 'Owner One',
        passwordHash,
        role: 'OWNER',
        emailVerified: true,
        lifecycleStatus: 'ACTIVE',
        organisationId: 'org-1',
        organisation: publicOrganisation(),
      }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [{
        id: 'u1',
        organisationId: 'org-1',
        role: 'OWNER',
        userLifecycleStatus: 'ACTIVE',
        organisationLifecycleStatus: 'ACTIVE',
      }],
      authSession: {
        create: async ({ data }: { data: { refreshTokenHash: string } }) => {
          storedHash = data.refreshTokenHash;
          return { id: 's1' };
        },
      },
    }),
  };
  const service = new AuthService(prisma as never, {} as never);

  const result = await service.login({ email: 'owner@example.org', password: 'GoodPass1' });

  assert.equal(typeof result.accessToken, 'string');
  assert.ok(result.accessToken.length > 0);
  assert.equal(typeof result.refreshToken, 'string');
  assert.ok(result.refreshToken.length > 0);
  // The stored value is the SHA-256 hash of the issued refresh token, never the raw token.
  assert.equal(storedHash, hashOpaqueToken(result.refreshToken));
  assert.notEqual(storedHash, result.refreshToken);
});

// ── x-auth-session-auth-session-12: logout revokes only the presented hash ──

test('logout revokes only the session for the presented refresh token', async () => {
  let capturedValues: unknown[] = [];
  const prisma = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedValues = values;
      return 1;
    },
  };
  const service = new AuthService(prisma as never, {} as never);

  const result = await service.logout('tok');

  // The UPDATE is scoped to exactly the hash of the presented token.
  assert.ok(capturedValues.includes(hashOpaqueToken('tok')));
  assert.equal(capturedValues.includes('tok'), false);
  assert.deepEqual(result, { message: 'Signed out successfully.' });

  // Never throws for an unknown/absent token (0 rows affected).
  const noopPrisma = { $executeRaw: async () => 0 };
  const noopService = new AuthService(noopPrisma as never, {} as never);
  await assert.doesNotReject(() => noopService.logout('unknown-token'));
});

// ── x-auth-session-auth-session-16: refresh route clears cookies + 401 ──

test('refresh route clears cookies and returns 401 when the refresh token is invalid', async () => {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie as never);
  app.decorate('prisma', {
    // Unknown token: no matching session row.
    $queryRaw: async () => [],
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `${REFRESH_TOKEN_COOKIE}=stale-refresh-token` },
      payload: {},
    });

    assert.equal(response.statusCode, 401);
    assert.equal((response.json() as { code?: string }).code, 'INVALID_REFRESH_TOKEN');

    const setCookies = response.headers['set-cookie'];
    const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
    const joined = cookieList.join('\n');
    // Both auth cookies are cleared (Max-Age=0 / Expires in the past).
    assert.ok(joined.includes(REFRESH_TOKEN_COOKIE));
    assert.ok(joined.includes(ACCESS_TOKEN_COOKIE));
    assert.ok(/Max-Age=0/i.test(joined) || /Expires=Thu, 01 Jan 1970/i.test(joined));
  } finally {
    await app.close();
  }
});

// ── x-auth-session-auth-session-17: cookie security attributes ──

test('auth cookies are HttpOnly, SameSite=lax, and Secure in production', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    // Production: cookies must carry Secure.
    process.env.NODE_ENV = 'production';
    const prodApp = Fastify({ logger: false });
    await prodApp.register(fastifyCookie as never);
    prodApp.get('/set', async (_request, reply) => {
      setAuthCookies(reply as never, { accessToken: 'a', refreshToken: 'r' });
      reply.send({ ok: true });
    });
    prodApp.get('/clear', async (_request, reply) => {
      clearAuthCookies(reply as never);
      reply.send({ ok: true });
    });

    try {
      const setRes = await prodApp.inject({ method: 'GET', url: '/set' });
      const setCookies = setRes.headers['set-cookie'];
      const prodList = (Array.isArray(setCookies) ? setCookies : [setCookies ?? '']) as string[];
      const access = prodList.find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`)) ?? '';
      const refresh = prodList.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE}=`)) ?? '';

      for (const cookie of [access, refresh]) {
        assert.ok(/HttpOnly/i.test(cookie), `expected HttpOnly in ${cookie}`);
        assert.ok(/SameSite=Lax/i.test(cookie), `expected SameSite=Lax in ${cookie}`);
        assert.ok(/Secure/i.test(cookie), `expected Secure in ${cookie}`);
        assert.ok(/Path=\//i.test(cookie), `expected Path=/ in ${cookie}`);
        assert.ok(/Max-Age=\d+/i.test(cookie), `expected Max-Age in ${cookie}`);
      }
      // Access cookie has the documented 15-minute TTL.
      assert.ok(/Max-Age=900\b/.test(access), `expected Max-Age=900 in ${access}`);

      const clearRes = await prodApp.inject({ method: 'GET', url: '/clear' });
      const clearCookies = clearRes.headers['set-cookie'];
      const clearList = (Array.isArray(clearCookies) ? clearCookies : [clearCookies ?? '']) as string[];
      const clearJoined = clearList.join('\n');
      assert.ok(clearList.length >= 2);
      assert.ok(/Max-Age=0/i.test(clearJoined) || /Expires=Thu, 01 Jan 1970/i.test(clearJoined));
    } finally {
      await prodApp.close();
    }

    // Non-production: Secure must be absent.
    delete process.env.NODE_ENV;
    const devApp = Fastify({ logger: false });
    await devApp.register(fastifyCookie as never);
    devApp.get('/set', async (_request, reply) => {
      setAuthCookies(reply as never, { accessToken: 'a', refreshToken: 'r' });
      reply.send({ ok: true });
    });
    try {
      const devRes = await devApp.inject({ method: 'GET', url: '/set' });
      const devCookies = devRes.headers['set-cookie'];
      const devList = (Array.isArray(devCookies) ? devCookies : [devCookies ?? '']) as string[];
      for (const cookie of devList) {
        assert.ok(/HttpOnly/i.test(cookie));
        assert.equal(/Secure/i.test(cookie), false, `Secure must be absent outside production in ${cookie}`);
      }
    } finally {
      await devApp.close();
    }
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

// ── x-auth-session-observability-19: JWT secret + refresh hash redacted ──

test('production logger redacts the JWT signing secret env path', () => {
  const loggerOptions = apiLoggerOptionsForEnvironment('production');
  const redact = (loggerOptions as { redact?: { paths?: string[] } }).redact;
  assert.ok(redact?.paths?.includes('env.JWT_SECRET'));
  assert.ok(redact?.paths?.includes('refreshTokenHash'));
});
