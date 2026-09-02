import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, handleError } from '../utils/errors.js';
import { apiLoggerOptionsForEnvironment } from '../utils/logger.js';

const { default: Fastify } = await import('fastify');

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value;
  globalThis.fetch = originalFetch;
});

function rootCauseError(): AppError {
  const cause = Object.assign(
    new Error(
      'Root postgresql://operator:db-password@db.charitypilot.ie/production '
      + 'token=root-token trustee@example.org org-1/private.pdf sk_live_abcdefghijklmnop',
    ),
    {
      code: 'PGRST500 token=code-secret',
      status: '500 api_key="status-secret"',
      response: {
        data: {
          providerPayload: 'raw-provider-payload',
          serviceRoleKey: 'raw-service-role-key',
        },
      },
    },
  );
  const error = new AppError(
    503,
    'STORAGE_DOWNLOAD_FAILED',
    'Storage provider failed provider-secret',
    { providerPayload: 'raw-app-error-details' },
  );
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
}

async function buildDiagnosticApp(logLines: string[]) {
  const loggerOptions = apiLoggerOptionsForEnvironment('production');
  assert.equal(typeof loggerOptions, 'object');
  assert.notEqual(loggerOptions, null);
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      ...(loggerOptions as Record<string, unknown>),
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  app.get('/caught-root-cause', async (_request, reply) => {
    try {
      throw rootCauseError();
    } catch (error) {
      handleError(reply, error);
    }
  });
  return app;
}

async function waitForAlertFailureLog(logLines: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (logLines.some((line) => line.includes('Failed to send error alert webhook'))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('alert failure diagnostic was not logged');
}

function assertGenericClientResponse(response: { statusCode: number; json: () => Record<string, unknown> }): void {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}

function assertOriginalDiagnosticIsSanitized(serializedLogs: string): void {
  assert.match(serializedLogs, /Route-caught request failed/);
  assert.match(serializedLogs, /STORAGE_DOWNLOAD_FAILED/);
  assert.match(serializedLogs, /PGRST500/);
  assert.match(serializedLogs, /\[redacted-database-url\]/);
  assert.match(serializedLogs, /token=\[redacted\]/);
  assert.match(serializedLogs, /\[email\]/);
  assert.match(serializedLogs, /\[storage-path\]/);
  assert.match(serializedLogs, /stripe-key=\[redacted\]/);
  assert.match(serializedLogs, /provider-secret=\[redacted\]/);
  for (const secret of [
    'db-password',
    'root-token',
    'trustee@example.org',
    'org-1/private.pdf',
    'sk_live_abcdefghijklmnop',
    'raw-provider-payload',
    'raw-service-role-key',
    'raw-app-error-details',
    'code-secret',
    'status-secret',
  ]) {
    assert.equal(serializedLogs.includes(secret), false, `${secret} must be absent from local diagnostics`);
  }
}

test('route-caught 5xx retains its sanitized original cause when an alert resolves non-ok', {
  concurrency: false,
}, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  let serializedAlert = '';
  globalThis.fetch = (async (_url, init) => {
    serializedAlert = String(init?.body ?? '');
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const logLines: string[] = [];
  const app = await buildDiagnosticApp(logLines);

  try {
    const response = await app.inject({ method: 'GET', url: '/caught-root-cause?token=query-secret' });
    assertGenericClientResponse(response);
    await waitForAlertFailureLog(logLines);

    const logs = logLines.join('\n');
    assertOriginalDiagnosticIsSanitized(logs);
    assert.match(logs, /Failed to send error alert webhook/);
    assert.match(logs, /HTTP 503/);
    assert.ok(logs.indexOf('Route-caught request failed') < logs.indexOf('Failed to send error alert webhook'));
    assert.equal(serializedAlert.includes('query-secret'), false);
    assert.equal(serializedAlert.includes('provider-secret'), false);
    assert.equal(serializedAlert.includes('raw-provider-payload'), false);
  } finally {
    await app.close();
  }
});

test('route-caught 5xx retains its sanitized original cause when alert transport throws', {
  concurrency: false,
}, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
  globalThis.fetch = (async () => {
    throw new Error('Webhook transport failed Bearer alert-secret token=alert-token');
  }) as typeof fetch;
  const logLines: string[] = [];
  const app = await buildDiagnosticApp(logLines);

  try {
    const response = await app.inject({ method: 'GET', url: '/caught-root-cause' });
    assertGenericClientResponse(response);
    await waitForAlertFailureLog(logLines);

    const logs = logLines.join('\n');
    assertOriginalDiagnosticIsSanitized(logs);
    assert.match(logs, /Failed to send error alert webhook/);
    assert.match(logs, /Bearer \[redacted\]/);
    assert.match(logs, /token=\[redacted\]/);
    assert.equal(logs.includes('alert-secret'), false);
    assert.equal(logs.includes('alert-token'), false);
    assert.ok(logs.indexOf('Route-caught request failed') < logs.indexOf('Failed to send error alert webhook'));
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Global error handler: a client error keeps its actionable machine code
// ─────────────────────────────────────────────────────────────────────────────

async function buildGlobalErrorHandlerApp() {
  const [{ default: Fastify }, { errorHandlerPlugin }] = await Promise.all([
    import('fastify'),
    import('../plugins/error-handler.js'),
  ]);
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.post('/echo', async () => ({ ok: true }));
  app.get('/boom', async () => {
    throw new Error('database connection lost at /var/secret/path/db.ts:42');
  });
  return app;
}

test('a malformed JSON body is reported with its own code, not INTERNAL_ERROR', async () => {
  // A caller that sent a bad request must be able to tell that apart from a
  // server fault; labelling every uncaught 4xx INTERNAL_ERROR hides it.
  process.env.NODE_ENV = 'production';
  const app = await buildGlobalErrorHandlerApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"unterminated":',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code?: string; error?: string };
    assert.notEqual(body.code, 'INTERNAL_ERROR', 'a client error must not be labelled a server fault');
    assert.equal(body.code, 'FST_ERR_CTP_INVALID_JSON_BODY');
  } finally {
    await app.close();
  }
});

test('an uncaught server fault stays opaque in production', async () => {
  process.env.NODE_ENV = 'production';
  const app = await buildGlobalErrorHandlerApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    assert.ok(!res.payload.includes('db.ts:42'), 'the underlying path must not leak');
  } finally {
    await app.close();
  }
});
