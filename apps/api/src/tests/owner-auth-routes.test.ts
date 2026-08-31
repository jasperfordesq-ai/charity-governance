import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-routes-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-routes-test';

const [
  { default: Fastify },
  { default: cookie },
  { default: rateLimit },
  bcrypt,
  { ownerRoutes },
  { setOwnerCookies, clearOwnerCookies },
] = await Promise.all([
  import('fastify'),
  import('@fastify/cookie'),
  import('@fastify/rate-limit'),
  import('bcryptjs'),
  import('../routes/owner/index.js'),
  import('../utils/owner-cookies.js'),
]);

const PASSWORD = 'correct-horse-battery-staple';

async function buildApp(operator: Record<string, unknown> | null) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: { findUnique: async () => operator },
    platformOperatorSession: {
      create: async ({ data }: { data: unknown }) => ({ id: 's-1', ...(data as object) }),
      findFirst: async () => null,
      update: async () => ({}),
    },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return app;
}

test('a correct operator password issues owner cookies', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'ACTIVE',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: PASSWORD },
  });

  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'] as string[] | string;
  const cookies = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(cookies, /charitypilot_owner_access=/);
  assert.match(cookies, /Path=\/api\/v1\/owner/);
  assert.doesNotMatch(cookies, /charitypilot_access=/, 'owner login must not set tenant cookies');
  await app.close();
});

test('a wrong operator password is rejected', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'ACTIVE',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'INVALID_CREDENTIALS');
  await app.close();
});

test('an unknown operator email is indistinguishable from a wrong password', async () => {
  const app = await buildApp(null);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'nobody@example.org', password: PASSWORD },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'INVALID_CREDENTIALS');
  await app.close();
});

test('a suspended operator cannot log in', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'SUSPENDED',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: PASSWORD },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('owner routes are not registered in personal-server mode', async () => {
  process.env.CHARITYPILOT_DEPLOYMENT_MODE = 'personal-server';
  try {
    const app = await buildApp({
      id: 'op-1',
      email: 'owner@example.org',
      name: 'Owner',
      passwordHash: await bcrypt.default.hash(PASSWORD, 10),
      lifecycleStatus: 'ACTIVE',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      payload: { email: 'owner@example.org', password: PASSWORD },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    delete process.env.CHARITYPILOT_DEPLOYMENT_MODE;
  }
});

test('a configured owner origin allowlist rejects other origins', async () => {
  process.env.OWNER_ALLOWED_ORIGINS = 'https://console.example.org';
  try {
    const app = await buildApp({
      id: 'op-1',
      email: 'owner@example.org',
      name: 'Owner',
      passwordHash: await bcrypt.default.hash(PASSWORD, 10),
      lifecycleStatus: 'ACTIVE',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      headers: { origin: 'https://evil.example.org' },
      payload: { email: 'owner@example.org', password: PASSWORD },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'OWNER_ORIGIN_REJECTED');
    await app.close();
  } finally {
    delete process.env.OWNER_ALLOWED_ORIGINS;
  }
});

test('API server wires the owner JWT boot guard ahead of route registration, gated by tenancy', () => {
  const serverSource = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');

  assert.match(
    serverSource,
    /if\s*\(isMultiTenant\(\)\)\s*{\s*assertOwnerJwtSecretConfigured\(\);\s*}/,
  );

  const guardIndex = serverSource.search(/if\s*\(isMultiTenant\(\)\)/);
  const firstRouteRegistrationIndex = serverSource.indexOf(
    "await app.register(authRoutes, { prefix: '/api/v1/auth' });",
  );

  assert.ok(guardIndex > -1, 'expected the personal-server guard to be present');
  assert.ok(firstRouteRegistrationIndex > -1, 'expected the auth route registration to be present');
  assert.ok(
    guardIndex < firstRouteRegistrationIndex,
    'expected the owner JWT boot guard to run before route registrations',
  );
});

test('owner cookies are HttpOnly, SameSite=lax, Secure in production, and scoped to /api/v1/owner', async () => {
  // Mirrors the tenant equivalent ('auth cookies are HttpOnly, SameSite=lax, and Secure in
  // production' in auth-session-reliability.test.ts) for the higher-privilege owner cookie,
  // which previously had no test asserting anything beyond its name and Path.
  const originalEnv = process.env.NODE_ENV;
  try {
    // Production: cookies must carry Secure.
    process.env.NODE_ENV = 'production';
    const prodApp = Fastify({ logger: false });
    await prodApp.register(cookie);
    prodApp.get('/set', async (_request, reply) => {
      setOwnerCookies(reply as never, { accessToken: 'a', refreshToken: 'r' });
      reply.send({ ok: true });
    });
    prodApp.get('/clear', async (_request, reply) => {
      clearOwnerCookies(reply as never);
      reply.send({ ok: true });
    });

    try {
      const setRes = await prodApp.inject({ method: 'GET', url: '/set' });
      const setCookies = setRes.headers['set-cookie'];
      const prodList = (Array.isArray(setCookies) ? setCookies : [setCookies ?? '']) as string[];
      const access = prodList.find((c) => c.startsWith('charitypilot_owner_access=')) ?? '';
      const refresh = prodList.find((c) => c.startsWith('charitypilot_owner_refresh=')) ?? '';

      for (const cookieStr of [access, refresh]) {
        assert.ok(/HttpOnly/i.test(cookieStr), `expected HttpOnly in ${cookieStr}`);
        assert.ok(/SameSite=Lax/i.test(cookieStr), `expected SameSite=Lax in ${cookieStr}`);
        assert.ok(/Secure/i.test(cookieStr), `expected Secure in ${cookieStr}`);
        assert.ok(cookieStr.toLowerCase().includes('path=/api/v1/owner'), `expected Path=/api/v1/owner in ${cookieStr}`);
        assert.match(cookieStr, /Max-Age=\d+/i, `expected Max-Age in ${cookieStr}`);
      }

      const clearRes = await prodApp.inject({ method: 'GET', url: '/clear' });
      const clearCookies = clearRes.headers['set-cookie'];
      const clearList = (Array.isArray(clearCookies) ? clearCookies : [clearCookies ?? '']) as string[];
      const clearedAccess = clearList.find((c) => c.startsWith('charitypilot_owner_access=')) ?? '';
      const clearedRefresh = clearList.find((c) => c.startsWith('charitypilot_owner_refresh=')) ?? '';
      // Check each cookie individually by name, not just somewhere in the joined response --
      // a regression that expired only one of the two cookies must fail this test.
      for (const cookieStr of [clearedAccess, clearedRefresh]) {
        assert.ok(cookieStr, 'expected both owner cookies to be present in the clear response');
        assert.ok(
          /Max-Age=0/i.test(cookieStr) || /Expires=Thu, 01 Jan 1970/i.test(cookieStr),
          `expected an expiry marker (Max-Age=0 or epoch Expires) in ${cookieStr}`,
        );
      }
    } finally {
      await prodApp.close();
    }

    // Non-production: Secure must be absent (do not weaken the production assertion above
    // to accommodate this path — both are asserted, separately, like the tenant test does).
    delete process.env.NODE_ENV;
    const devApp = Fastify({ logger: false });
    await devApp.register(cookie);
    devApp.get('/set', async (_request, reply) => {
      setOwnerCookies(reply as never, { accessToken: 'a', refreshToken: 'r' });
      reply.send({ ok: true });
    });
    try {
      const devRes = await devApp.inject({ method: 'GET', url: '/set' });
      const devCookies = devRes.headers['set-cookie'];
      const devList = (Array.isArray(devCookies) ? devCookies : [devCookies ?? '']) as string[];
      for (const cookieStr of devList) {
        assert.ok(/HttpOnly/i.test(cookieStr));
        assert.equal(/Secure/i.test(cookieStr), false, `Secure must be absent outside production in ${cookieStr}`);
      }
    } finally {
      await devApp.close();
    }
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});
