import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'observability-reliability-test-secret';

const [
  { default: Fastify },
  { healthRoutes },
  { errorHandlerPlugin },
  { sendErrorAlert },
  { runDeadlineReminders, runProductionSchedulerOnce },
] = await Promise.all([
  import('fastify'),
  import('../routes/health/index.js'),
  import('../plugins/error-handler.js'),
  import('../services/error-alerts.service.js'),
  import('../jobs/production-scheduler.js'),
]);

type ErrorAlertPayload = Parameters<typeof sendErrorAlert>[0];

const READINESS_HEADER = 'x-charitypilot-readiness-key';
const READINESS_KEY = 'readiness-test-secret';

// Env keys that the readiness all-green / provider checks read; snapshot+restore around each test.
const READINESS_ENV_KEYS = [
  'READINESS_API_KEY',
  'READINESS_DEPENDENCY_TIMEOUT_MS',
  'DOCUMENT_STORAGE_DRIVER',
  'LOCAL_FILE_STORAGE_DIR',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) snapshot.set(key, process.env[key]);
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function buildReadinessApp(prismaOverrides: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $transaction: async () => ({ id: 1 }),
    ...prismaOverrides,
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

// ---------------------------------------------------------------------------
// x-observability-observability-5
// ---------------------------------------------------------------------------
test('authenticated readiness reports database:false when the SELECT 1 probe rejects', {
  concurrency: false,
}, async () => {
  const snapshot = snapshotEnv(READINESS_ENV_KEYS);
  process.env.READINESS_API_KEY = READINESS_KEY;

  const app = await buildReadinessApp({
    $queryRaw: async () => {
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
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// x-observability-observability-6
// ---------------------------------------------------------------------------
test('authenticated readiness returns 200 ready when every dependency check passes', {
  concurrency: false,
}, async () => {
  const snapshot = snapshotEnv(READINESS_ENV_KEYS);
  const localDir = await mkdtemp(join(tmpdir(), 'charitypilot-readiness-'));

  // Database probe succeeds.
  // Storage: local driver makes isConfigured() and verifyBucket() both true.
  process.env.READINESS_API_KEY = READINESS_KEY;
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = localDir;
  // Billing configured: secret + webhook secret + all four price IDs.
  process.env.STRIPE_SECRET_KEY = 'sk_live_readiness';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_readiness';
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentials_monthly';
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentials_yearly';
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_complete_monthly';
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_complete_yearly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_readiness';
  // Email configured: key + EMAIL_FROM containing '@'.
  process.env.RESEND_API_KEY = 're_live_readiness';
  process.env.EMAIL_FROM = 'noreply@charitypilot.ie';

  const app = await buildReadinessApp({
    $queryRaw: async () => [{ result: 1 }],
  });

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
    for (const value of Object.values(body.checks)) {
      assert.equal(value, true);
    }
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// x-observability-observability-7
// ---------------------------------------------------------------------------
test('authenticated readiness returns 503 with storageBucketReachable false when the bucket is unreachable', {
  concurrency: false,
}, async () => {
  const snapshot = snapshotEnv(READINESS_ENV_KEYS);
  // Healthy DB, but storage left unconfigured (no local driver, no Supabase env)
  // so storage.isConfigured() and verifyBucket() are both false while database stays true.
  process.env.READINESS_API_KEY = READINESS_KEY;
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;

  const app = await buildReadinessApp({
    $queryRaw: async () => [{ result: 1 }],
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
    assert.equal(body.checks.database, true);
    assert.equal(body.checks.storageConfigured, false);
    assert.equal(body.checks.storageBucketReachable, false);
  } finally {
    restoreEnv(snapshot);
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// x-observability-observability-10
// ---------------------------------------------------------------------------
test('5xx errors do not send alerts outside production or when the webhook is unconfigured', {
  concurrency: false,
}, async () => {
  const envSnapshot = snapshotEnv(['NODE_ENV', 'ERROR_ALERT_WEBHOOK_URL']);
  const originalFetch = globalThis.fetch;

  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  async function buildErrorApp() {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.post('/boom', async () => {
      throw new Error('internal failure');
    });
    return app;
  }

  try {
    // (a) Non-production env, webhook configured -> still no alert.
    process.env.NODE_ENV = 'development';
    process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
    fetchCalled = false;

    const devApp = await buildErrorApp();
    try {
      const devResponse = await devApp.inject({ method: 'POST', url: '/boom' });
      assert.equal(devResponse.statusCode, 500);
      assert.equal(fetchCalled, false);
    } finally {
      await devApp.close();
    }

    // (b) Production env, webhook unconfigured -> no alert.
    process.env.NODE_ENV = 'production';
    delete process.env.ERROR_ALERT_WEBHOOK_URL;
    fetchCalled = false;

    const prodApp = await buildErrorApp();
    try {
      const prodResponse = await prodApp.inject({ method: 'POST', url: '/boom' });
      assert.equal(prodResponse.statusCode, 500);
      assert.equal(fetchCalled, false);
    } finally {
      await prodApp.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnapshot);
  }
});

// ---------------------------------------------------------------------------
// x-observability-observability-13
// ---------------------------------------------------------------------------
test('runProductionSchedulerOnce fires no error alert when both jobs succeed', {
  concurrency: false,
}, async () => {
  const alerts: ErrorAlertPayload[] = [];

  const result = await runProductionSchedulerOnce({
    deadlineService: {
      async sendDueReminders() {},
    },
    documentService: {
      async retryPendingStorageDeletions() {
        return { processed: 2, failed: 0 };
      },
    },
    storageService: {
      async deleteFile() {},
    },
    authEmailDeliveryService: {
      async processDueDeliveries() {
        return {
          processed: 0,
          accepted: 0,
          rejected: 0,
          uncertain: 0,
          keyUnavailable: 0,
          retryScheduled: 0,
          staleQuarantined: 0,
          cleaned: 0,
        };
      },
    },
    documentStorageCleanupLimit: 7,
    authDeliveryBatchSize: 25,
    authDeliveryCleanupBatchSize: 500,
    authDeliveryStaleSendingMs: 60000,
    logger: {
      info() {},
      error() {},
    },
    alertSender: async (payload) => {
      alerts.push(payload);
    },
  });

  assert.equal(result.deadlineRemindersFailed, false);
  assert.equal(result.documentStorageCleanupFailed, false);
  assert.equal(result.authEmailDeliveryFailed, false);
  assert.equal(alerts.length, 0);
});

// ---------------------------------------------------------------------------
// x-observability-observability-14
// ---------------------------------------------------------------------------
test('runDeadlineReminders still returns failed when the alert sender throws', {
  concurrency: false,
}, async () => {
  const logs: Array<{ message: string; error?: unknown }> = [];

  const failed = await runDeadlineReminders({
    deadlineService: {
      async sendDueReminders() {
        throw new Error('reminder run blew up');
      },
    },
    logger: {
      info(message: string) {
        logs.push({ message });
      },
      error(message: string, error?: unknown) {
        logs.push({ message, error });
      },
    },
    alertSender: async () => {
      throw new Error('alert destination unavailable');
    },
  });

  // The throwing alert transport must not crash the run.
  assert.equal(failed, true);
  const alertFailureLog = logs.find((entry) =>
    entry.message.includes('Failed to send deadline-reminders failure alert'),
  );
  assert.ok(alertFailureLog);
});

// ---------------------------------------------------------------------------
// x-observability-observability-16
// ---------------------------------------------------------------------------
test('alert webhook send aborts when the webhook hangs past the timeout', {
  concurrency: false,
}, async () => {
  const envSnapshot = snapshotEnv(['ERROR_ALERT_WEBHOOK_URL', 'ERROR_ALERT_WEBHOOK_TIMEOUT_MS']);
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  process.env.ERROR_ALERT_WEBHOOK_TIMEOUT_MS = '25';

  const payload: ErrorAlertPayload = {
    service: 'charitypilot-api',
    environment: 'production',
    severity: 'error',
    method: 'POST',
    url: '/boom',
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    errorName: 'Error',
    requestId: 'req-timeout',
    timestamp: new Date().toISOString(),
  };

  let observedSignal: AbortSignal | undefined;
  // A hung webhook: the fetch only settles once its abort signal fires.
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined;
      if (observedSignal) {
        observedSignal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }
    })) as typeof fetch;

  try {
    // sendErrorAlert rethrows the rejection from the aborted fetch; the point is
    // that it settles (does not hang) within the timeout budget.
    await assert.rejects(sendErrorAlert(payload, fetchImpl));

    assert.ok(observedSignal, 'fetch should have received an AbortSignal');
    assert.equal(observedSignal?.aborted, true);
  } finally {
    restoreEnv(envSnapshot);
  }
});
