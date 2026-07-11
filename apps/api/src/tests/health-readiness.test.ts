import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const [{ default: Fastify }, { healthRoutes }] = await Promise.all([
  import('fastify'),
  import('../routes/health/index.js'),
]);

const originalReadinessKey = process.env.READINESS_API_KEY;

async function buildHealthApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => [{ result: 1 }],
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

test('basic health stays public without exposing dependency checks', { concurrency: false }, async () => {
  const app = await buildHealthApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal('checks' in body, false);
  } finally {
    await app.close();
  }
});

test('unauthenticated readiness does not expose detailed dependency checks', { concurrency: false }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  const app = await buildHealthApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health/readiness' });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.equal(body.code, 'READINESS_UNAUTHORIZED');
    assert.equal('checks' in body, false);
    assert.equal(JSON.stringify(body).includes('billingConfigured'), false);
    assert.equal(JSON.stringify(body).includes('storageBucketReachable'), false);
  } finally {
    process.env.READINESS_API_KEY = originalReadinessKey;
    await app.close();
  }
});

test('readiness key comparison uses timing-safe equality', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'health', 'index.ts'), 'utf8');

  assert.match(routeSource, /timingSafeEqual/);
  assert.doesNotMatch(routeSource, /suppliedKey\s*===\s*configuredKey/);
});

test('authenticated readiness times out a stuck database check', { concurrency: false, timeout: 5_000 }, async () => {
  process.env.READINESS_API_KEY = 'readiness-test-secret';
  process.env.READINESS_DEPENDENCY_TIMEOUT_MS = '25';
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => new Promise(() => {}),
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'readiness-test-secret' },
    });
    const body = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.database, false);
  } finally {
    delete process.env.READINESS_DEPENDENCY_TIMEOUT_MS;
    process.env.READINESS_API_KEY = originalReadinessKey;
    await app.close();
  }
});
