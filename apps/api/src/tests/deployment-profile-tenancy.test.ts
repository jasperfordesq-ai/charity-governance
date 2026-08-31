import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenancy-gate-test-secret';
process.env.OWNER_JWT_SECRET = process.env.OWNER_JWT_SECRET ?? 'tenancy-gate-test-owner-secret';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('../routes/owner/index.js'),
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

async function buildOwnerApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', unreachablePrisma());
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
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

test('single tenancy in DEFAULT mode disables the owner console', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_TENANCY: 'single' }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 404);
    await app.close();
  });
});

test('multi tenancy in APPLIANCE mode enables the owner console', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_TENANCY: 'multi' }, async () => {
    const app = await buildOwnerApp();
    // 401 (guard engaged), not 404 (routes absent)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 401);
    await app.close();
  });
});

test('APPLIANCE COMPATIBILITY: personal-server mode, no axis vars => console absent', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_TENANCY: undefined }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 404, 'the appliance must keep 404ing owner routes');
    await app.close();
  });
});

test('DEFAULT COMPATIBILITY: no mode, no axis vars => console present', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_TENANCY: undefined }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 401, 'default mode keeps the console live behind its guard');
    await app.close();
  });
});

test('the boot guard is keyed on tenancy, not mode (source assertion)', () => {
  const serverSource = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(serverSource, /if \(isMultiTenant\(\)\) \{\s*\n\s*assertOwnerJwtSecretConfigured\(\);/);
  assert.doesNotMatch(serverSource, /!isPersonalServerDeployment\(\)\) \{\s*\n\s*assertOwnerJwtSecretConfigured/);
});
