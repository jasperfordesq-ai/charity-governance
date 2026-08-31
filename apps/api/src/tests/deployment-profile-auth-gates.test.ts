import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'gate-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 'resend-test-key-placeholder';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, { authRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('../routes/auth/index.js'),
  ]);

function unreachablePrisma() {
  return new Proxy({}, {
    get: (_t, model) => new Proxy({}, {
      get: (_t2, op) => () => {
        throw new Error(`prisma.${String(model)}.${String(op)} reached — the gate did not fire`);
      },
    }),
  }) as never;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', unreachablePrisma());
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  return app;
}

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const REGISTER = { method: 'POST' as const, url: '/api/v1/auth/register', payload: { email: 'a@b.ie', password: 'x'.repeat(14), name: 'A', organisationName: 'Org' } };
const FORGOT = { method: 'POST' as const, url: '/api/v1/auth/forgot-password', payload: { email: 'a@b.ie' } };

test('registration closed => register 404s before any DB call', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_REGISTRATION: 'closed' }, async () => {
    const app = await buildApp();
    const res = await app.inject(REGISTER);
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

test('registration open in appliance mode => register is reachable (not 404)', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_REGISTRATION: 'open' }, async () => {
    const app = await buildApp();
    const res = await app.inject(REGISTER);
    assert.notEqual(res.statusCode, 404); // reaches the handler (which then hits the throwing stub => 500)
    await app.close();
  });
});

test('manual-link email => forgot-password 404s; provider email => reachable', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }, async () => {
    const app = await buildApp();
    assert.equal((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_EMAIL_DELIVERY: 'provider' }, async () => {
    const app = await buildApp();
    assert.notEqual((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
});

test('APPLIANCE COMPATIBILITY: personal-server mode with no axis vars behaves exactly as today', async () => {
  await withEnv({
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    CHARITYPILOT_REGISTRATION: undefined,
    CHARITYPILOT_EMAIL_DELIVERY: undefined,
  }, async () => {
    const app = await buildApp();
    assert.equal((await app.inject(REGISTER)).statusCode, 404, 'register must stay 404 on the appliance');
    assert.equal((await app.inject(FORGOT)).statusCode, 404, 'forgot-password must stay 404 on the appliance');
    await app.close();
  });
});

test('DEFAULT COMPATIBILITY: no mode, no axis vars => both endpoints reachable', async () => {
  await withEnv({
    CHARITYPILOT_DEPLOYMENT_MODE: undefined,
    CHARITYPILOT_REGISTRATION: undefined,
    CHARITYPILOT_EMAIL_DELIVERY: undefined,
  }, async () => {
    const app = await buildApp();
    assert.notEqual((await app.inject(REGISTER)).statusCode, 404);
    assert.notEqual((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
});
