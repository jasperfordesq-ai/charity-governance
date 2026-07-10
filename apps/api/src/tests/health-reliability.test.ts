import assert from 'node:assert/strict';
import test from 'node:test';

// Health/readiness reads env at request time inside the route handler (via the
// Billing/Email/Storage service constructors and the readiness key gate), so the
// env mutations below are applied per-test and always restored in a finally block.

const [{ default: Fastify }, { healthRoutes }] = await Promise.all([
  import('fastify'),
  import('../routes/health/index.js'),
]);

const READINESS_KEY = 'readiness-test-secret';
const READINESS_HEADER = 'x-charitypilot-readiness-key';

// Every env var any readiness dependency probe reads, captured up-front so each
// test can mutate freely and restore the exact prior values afterwards.
const ENV_KEYS = [
  'READINESS_API_KEY',
  'READINESS_DEPENDENCY_TIMEOUT_MS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'DOCUMENT_STORAGE_DRIVER',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setFullyConfiguredProviders(): void {
  process.env.STRIPE_SECRET_KEY = 'sk_test_readiness';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_readiness';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentials_monthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentials_yearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_complete_monthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_complete_yearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_readiness';
  process.env.RESEND_API_KEY = 're_readiness_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  // local storage driver => StorageService.isConfigured() and verifyBucket()
  // both succeed without any Supabase wiring.
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
}

function clearProviderConfiguration(): void {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID;
  delete process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;
  delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  // Supabase-mode storage with no Supabase config => unconfigured.
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
}

interface HealthAppOptions {
  queryRaw?: () => Promise<unknown>;
}

async function buildHealthApp(options: HealthAppOptions = {}) {
  const queryRaw = options.queryRaw ?? (async () => [{ result: 1 }]);
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: queryRaw,
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

test('authenticated readiness reports ready when every dependency is healthy', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  process.env.READINESS_API_KEY = READINESS_KEY;
  setFullyConfiguredProviders();
  const app = await buildHealthApp({ queryRaw: async () => [{ result: 1 }] });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: READINESS_KEY },
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.database, true);
    assert.equal(body.checks.billingConfigured, true);
    assert.equal(body.checks.emailConfigured, true);
    assert.equal(body.checks.storageConfigured, true);
    assert.equal(body.checks.storageBucketReachable, true);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('authenticated readiness reports not_ready when the database query throws', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  process.env.READINESS_API_KEY = READINESS_KEY;
  setFullyConfiguredProviders();
  const app = await buildHealthApp({
    queryRaw: async () => {
      throw new Error('connection refused');
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: READINESS_KEY },
    });
    const body = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.database, false);
    // The thrown error is swallowed and logged, never serialised into the body.
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes('connection refused'), false);
    assert.equal(serialised.includes('Error'), false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('authenticated readiness reports not_ready when billing/email/storage are unconfigured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  process.env.READINESS_API_KEY = READINESS_KEY;
  clearProviderConfiguration();
  // Database stays healthy; only the external providers are unconfigured.
  const app = await buildHealthApp({ queryRaw: async () => [{ result: 1 }] });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: READINESS_KEY },
    });
    const body = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.database, true);
    assert.equal(body.checks.billingConfigured, false);
    assert.equal(body.checks.emailConfigured, false);
    assert.equal(body.checks.storageConfigured, false);
    assert.equal(body.checks.storageBucketReachable, false);

    // The public liveness probe keeps serving 200 regardless of dependency state.
    const liveness = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(liveness.statusCode, 200);
    assert.equal(liveness.json().status, 'ok');
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('readiness rejects a wrong readiness key without exposing checks', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  process.env.READINESS_API_KEY = READINESS_KEY;
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: 'wrong-key' },
    });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.equal(body.code, 'READINESS_UNAUTHORIZED');
    assert.equal('checks' in body, false);
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes('billingConfigured'), false);
    assert.equal(serialised.includes('storageBucketReachable'), false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('readiness fails closed when no readiness key is configured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  delete process.env.READINESS_API_KEY;
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: 'any-value' },
    });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.equal(body.code, 'READINESS_UNAUTHORIZED');
    assert.equal('checks' in body, false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('readiness never echoes the readiness key in the response body', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  const configuredSentinel = 'configured-key-SENTINEL-9f3a';
  const suppliedSentinel = 'supplied-key-SENTINEL-1b7c';
  process.env.READINESS_API_KEY = configuredSentinel;
  const app = await buildHealthApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: suppliedSentinel },
    });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.equal(body.code, 'READINESS_UNAUTHORIZED');
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes(configuredSentinel), false);
    assert.equal(serialised.includes(suppliedSentinel), false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

test('readiness rejects a duplicated readiness key header without a 500', { concurrency: false }, async () => {
  const snapshot = snapshotEnv();
  process.env.READINESS_API_KEY = READINESS_KEY;
  const app = await buildHealthApp();

  try {
    // A duplicated header arrives as a string[] in Fastify, so suppliedKey is a
    // non-string value; the typeof guard must reject it cleanly as 401, not 500.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { [READINESS_HEADER]: [READINESS_KEY, 'second-value'] },
    });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.equal(body.code, 'READINESS_UNAUTHORIZED');
    assert.equal('checks' in body, false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});
