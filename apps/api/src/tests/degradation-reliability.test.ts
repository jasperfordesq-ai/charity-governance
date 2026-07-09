import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

// Env that imported modules read at import/construction time MUST be set BEFORE the
// dynamic imports below. JWT_SECRET is required for token signing; the billing /
// readiness / email surfaces also read provider env, but those are mutated per-test
// (and always restored in a finally block).
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'degradation-reliability-test-secret';

const [
  { default: Fastify },
  { StorageService },
  { EmailService },
  { billingRoutes },
  { healthRoutes },
  { formatProviderError },
  { AppError },
] = await Promise.all([
  import('fastify'),
  import('../services/storage.service.js'),
  import('../services/email.service.js'),
  import('../routes/billing/index.js'),
  import('../routes/health/index.js'),
  import('../utils/provider-errors.js'),
  import('../utils/errors.js'),
]);

const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function listen(server: Server): Promise<{ port: number }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected test server to listen on a TCP port');
  }
  return { port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function assertAppError(
  action: () => Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  await assert.rejects(action, (err) => {
    assert.equal(err instanceof AppError, true, 'expected an AppError');
    const appError = err as InstanceType<typeof AppError>;
    assert.equal(appError.statusCode, statusCode);
    assert.equal(appError.code, code);
    return true;
  });
}

// ── x-degradation-graceful-degradation-1 ───────────────────────────────────────
test('storage operations throw 503 STORAGE_NOT_CONFIGURED when Supabase is unconfigured and local driver is off', { concurrency: false }, async () => {
  const snapshot = snapshotEnv(['DOCUMENT_STORAGE_DRIVER', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const service = new StorageService();

    await assertAppError(
      () => service.uploadFile('org-a', 'f.pdf', Buffer.from('x'), 'application/pdf'),
      503,
      'STORAGE_NOT_CONFIGURED',
    );
    await assertAppError(
      () => service.getSignedUrl('org-a', 'org-a/f.pdf'),
      503,
      'STORAGE_NOT_CONFIGURED',
    );
    await assertAppError(
      () => service.deleteFile('org-a', 'org-a/f.pdf'),
      503,
      'STORAGE_NOT_CONFIGURED',
    );
  } finally {
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-2 ───────────────────────────────────────
test('Supabase storage errors map to stable STORAGE_* AppErrors without leaking provider detail', { concurrency: false }, async () => {
  const snapshot = snapshotEnv([
    'DOCUMENT_STORAGE_DRIVER',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
  ]);

  // Every storage REST call answers with a non-2xx + a secret-bearing message, which
  // supabase-js surfaces as { error } on upload/createSignedUrl/remove.
  const server = createServer((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'raw secret', message: 'raw secret provider detail' }));
  });
  const { port } = await listen(server);

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'documents';

  try {
    const service = new StorageService();

    await assert.rejects(
      () => service.uploadFile('org-a', 'f.pdf', Buffer.from('x'), 'application/pdf'),
      (err) => {
        const appError = err as InstanceType<typeof AppError>;
        assert.equal(appError instanceof AppError, true);
        assert.equal(appError.statusCode, 500);
        assert.equal(appError.code, 'STORAGE_UPLOAD_FAILED');
        assert.equal(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
        assert.equal(appError.message.includes('raw secret'), false);
        return true;
      },
    );

    await assert.rejects(
      () => service.getSignedUrl('org-a', 'org-a/f.pdf'),
      (err) => {
        const appError = err as InstanceType<typeof AppError>;
        assert.equal(appError instanceof AppError, true);
        assert.equal(appError.statusCode, 500);
        assert.equal(appError.code, 'STORAGE_SIGNED_URL_FAILED');
        assert.equal(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
        assert.equal(appError.message.includes('raw secret'), false);
        return true;
      },
    );

    await assert.rejects(
      () => service.deleteFile('org-a', 'org-a/f.pdf'),
      (err) => {
        const appError = err as InstanceType<typeof AppError>;
        assert.equal(appError instanceof AppError, true);
        assert.equal(appError.statusCode, 500);
        assert.equal(appError.code, 'STORAGE_DELETE_FAILED');
        assert.equal(appError.message, STORAGE_OPERATION_FAILED_MESSAGE);
        assert.equal(appError.message.includes('raw secret'), false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-3 ───────────────────────────────────────
test('verifyBucket returns false when Supabase getBucket errors or is unconfigured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv([
    'DOCUMENT_STORAGE_DRIVER',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
    'STORAGE_READINESS_TIMEOUT_MS',
  ]);

  // Case A: configured but the bucket probe errors (HTTP 500) -> verifyBucket() === false.
  const server = createServer((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'bucket lookup failed' }));
  });
  const { port } = await listen(server);

  try {
    delete process.env.DOCUMENT_STORAGE_DRIVER;
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-service-role-key';
    process.env.SUPABASE_STORAGE_BUCKET = 'documents';
    process.env.STORAGE_READINESS_TIMEOUT_MS = '1000';

    assert.equal(await new StorageService().verifyBucket(), false);

    // Case B: Supabase entirely unconfigured with the local driver off -> the
    // isConfigured() short-circuit returns false rather than throwing.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET;

    assert.equal(await new StorageService().verifyBucket(), false);
  } finally {
    await closeServer(server);
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-4 ───────────────────────────────────────
test('_send returns false without throwing when Resend is unconfigured or the SDK rejects', { concurrency: false }, async () => {
  const snapshot = snapshotEnv(['RESEND_API_KEY', 'EMAIL_FROM', 'FRONTEND_URL']);

  try {
    // Case A: missing key -> construction and send both degrade without touching
    // the SDK. CI does not always provide optional provider config for route tests.
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = 'noreply@example.org';
    process.env.FRONTEND_URL = 'https://app.example.org';

    const unconfigured = new EmailService();
    let sdkCalled = false;
    (unconfigured as unknown as { resend: { emails: { send: () => Promise<unknown> } } }).resend = {
      emails: {
        send: async () => {
          sdkCalled = true;
          return {};
        },
      },
    };

    let resultA: boolean | undefined;
    await assert.doesNotReject(async () => {
      resultA = await unconfigured.sendWelcomeEmail('a@b.org', 'N', 'Org');
    });
    assert.equal(resultA, false);
    assert.equal(sdkCalled, false, 'no send should be attempted when Resend is unconfigured');

    // Case B: configured key but the Resend SDK rejects with a secret-bearing error ->
    // _send catches it and resolves to false without throwing.
    process.env.RESEND_API_KEY = 're_test_key';
    const configured = new EmailService();
    (configured as unknown as { resend: { emails: { send: () => Promise<unknown> } } }).resend = {
      emails: {
        send: async () => {
          throw new Error('Resend failure for re_live_secret_key');
        },
      },
    };

    let resultB: boolean | undefined;
    await assert.doesNotReject(async () => {
      resultB = await configured.sendWelcomeEmail('a@b.org', 'N', 'Org');
    });
    assert.equal(resultB, false);
  } finally {
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-5 ───────────────────────────────────────
test('billing webhook returns 503 BILLING_NOT_CONFIGURED when Stripe secret is unconfigured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv(['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY']);

  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;

  let subscriptionWriteCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    subscription: {
      upsert: async () => {
        subscriptionWriteCalled = true;
        return {};
      },
      update: async () => {
        subscriptionWriteCalled = true;
        return {};
      },
    },
    stripeWebhookEvent: {
      findUnique: async () => null,
      create: async () => {
        subscriptionWriteCalled = true;
        return {};
      },
    },
  } as never);
  await app.register(billingRoutes, { prefix: '/billing' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=deadbeef',
      },
      payload: JSON.stringify({ id: 'evt_unconfigured', type: 'checkout.session.completed', data: { object: {} } }),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'BILLING_NOT_CONFIGURED');
    assert.equal(subscriptionWriteCalled, false, 'no subscription write should occur when billing is unconfigured');
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-6 ───────────────────────────────────────
test('document upload returns 503 STORAGE_NOT_CONFIGURED and persists nothing when storage is unconfigured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv(['DOCUMENT_STORAGE_DRIVER', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const [{ default: multipart }, { documentRoutes }, { signAccessToken }] = await Promise.all([
    import('@fastify/multipart'),
    import('../routes/documents/index.js'),
    import('../utils/jwt.js'),
  ]);

  let documentCreateCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'ADMIN', emailVerified: true }) },
    subscription: { findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null, plan: 'ESSENTIALS' }) },
    document: {
      aggregate: async () => ({ _sum: { fileSize: 0 } }),
      create: async () => {
        documentCreateCalled = true;
        return { id: 'doc-1' };
      },
    },
  } as never);
  await app.register(multipart);
  await app.register(documentRoutes);

  const authHeader = `Bearer ${signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'ADMIN',
    sessionId: 'session-1',
  })}`;

  const boundary = 'charitypilot-degradation-upload';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries({ name: 'Safeguarding policy', category: 'POLICY' })) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="policy.pdf"\r\n'));
  chunks.push(Buffer.from('Content-Type: application/pdf\r\n\r\n'));
  chunks.push(Buffer.from('%PDF-1.7\n%%EOF'));
  chunks.push(Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: authHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat(chunks),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'STORAGE_NOT_CONFIGURED');
    assert.equal(documentCreateCalled, false, 'no Document row should be persisted when storage is unconfigured');
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});

// ── x-degradation-graceful-degradation-7 ───────────────────────────────────────
test('formatProviderError redacts emails, tokens, storage paths and caps length', () => {
  const longTail = 'z'.repeat(200);
  const error = Object.assign(
    new Error(`failed for a@b.com path org-1/x.pdf?token=abc #refresh_token=xyz ${longTail}`),
    { code: 'E', status: 503 },
  );

  const output = formatProviderError(error);

  assert.match(output, /name=Error/);
  assert.match(output, /code=E/);
  assert.match(output, /status=503/);
  assert.match(output, /\[email\]/);
  assert.match(output, /\[storage-path\]/);
  assert.match(output, /token=\[redacted\]/);
  assert.match(output, /refresh_token=\[redacted\]/);
  assert.equal(output.includes('a@b.com'), false);
  assert.equal(output.includes('abc'), false);
  assert.equal(output.includes('xyz'), false);
  // The message segment is capped at 160 chars and ends with the truncation marker.
  const messageSegment = output.slice(output.indexOf('message=') + 'message='.length);
  assert.equal(messageSegment.endsWith('...'), true);
  assert.equal(messageSegment.length <= 163, true);
});

// ── x-degradation-observability-8 ──────────────────────────────────────────────
test('formatProviderError redacts provider key material from messages', () => {
  const error = new Error([
    'sk_live_secretA pk_live_secretB',
    'whsec_secretC',
    're_secretD',
    'Bearer secretE',
    'apikey=secretF',
  ].join(' '));

  const output = formatProviderError(error);

  assert.match(output, /stripe-key=\[redacted\]/);
  assert.match(output, /stripe-webhook-secret=\[redacted\]/);
  assert.match(output, /resend-key=\[redacted\]/);
  assert.match(output, /Bearer \[redacted\]/);
  assert.match(output, /apikey=\[redacted\]/);
  assert.doesNotMatch(output, /sk_live_secretA/);
  assert.doesNotMatch(output, /pk_live_secretB/);
  assert.doesNotMatch(output, /whsec_secretC/);
  assert.doesNotMatch(output, /re_secretD/);
  assert.doesNotMatch(output, /secretE/);
  assert.doesNotMatch(output, /secretF/);
});

test('readiness reports 503 not_ready with billingConfigured false when Stripe env is unconfigured', { concurrency: false }, async () => {
  const snapshot = snapshotEnv([
    'READINESS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
    'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
    'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
    'STRIPE_COMPLETE_YEARLY_PRICE_ID',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'DOCUMENT_STORAGE_DRIVER',
    'LOCAL_FILE_STORAGE_DIR',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
  ]);

  process.env.READINESS_API_KEY = 'readiness-test-secret';

  // Email + storage configured so their checks pass; database passes via the mock.
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = '.charitypilot-readiness-test-storage';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;

  // Billing left unconfigured -> billingConfigured must be the single failing check.
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID;
  delete process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;

  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => [{ result: 1 }],
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
    assert.equal(body.checks.database, true);
    assert.equal(body.checks.billingConfigured, false);
  } finally {
    await app.close();
    restoreEnv(snapshot);
  }
});
