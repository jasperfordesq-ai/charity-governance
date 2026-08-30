import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-routes-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-routes-test';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, bcrypt, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('bcryptjs'),
    import('../routes/owner/index.js'),
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
