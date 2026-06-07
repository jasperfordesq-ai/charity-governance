import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sendErrorAlert, type ErrorAlertPayload } from '../services/error-alerts.service.js';
import { AppError } from '../utils/errors.js';

const [{ default: Fastify }, { errorHandlerPlugin }] = await Promise.all([
  import('fastify'),
  import('../plugins/error-handler.js'),
]);

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }

  globalThis.fetch = originalFetch;
});

async function buildErrorApp() {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);

  app.post('/boom', async () => {
    throw new Error('raw database secret should stay out of alert payload');
  });

  app.get('/bad-request', async () => {
    throw new AppError(400, 'BAD_REQUEST', 'Bad request');
  });

  return app;
}

test('production 5xx errors send a sanitized alert webhook payload', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.example/hooks/charitypilot';

  const alertCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url, init) => {
    alertCalls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });

    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const app = await buildErrorApp();

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/boom?token=query-secret',
      headers: {
        cookie: 'charitypilot_access=cookie-secret',
      },
      payload: {
        secret: 'payload-secret',
      },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'Internal server error');
    assert.equal(alertCalls.length, 1);

    const alert = alertCalls[0];
    assert.equal(alert.url, 'https://alerts.example/hooks/charitypilot');
    assert.equal(alert.body.service, 'charitypilot-api');
    assert.equal(alert.body.environment, 'production');
    assert.equal(alert.body.severity, 'error');
    assert.equal(alert.body.method, 'POST');
    assert.equal(alert.body.url, '/boom');
    assert.equal(alert.body.statusCode, 500);
    assert.equal(alert.body.code, 'INTERNAL_ERROR');
    assert.equal(alert.body.errorName, 'Error');
    assert.equal(typeof alert.body.requestId, 'string');
    assert.equal(typeof alert.body.timestamp, 'string');

    const serializedAlert = JSON.stringify(alert.body);
    assert.equal('headers' in alert.body, false);
    assert.equal('cookies' in alert.body, false);
    assert.equal('body' in alert.body, false);
    assert.equal('stack' in alert.body, false);
    assert.equal('message' in alert.body, false);
    assert.equal(serializedAlert.includes('query-secret'), false);
    assert.equal(serializedAlert.includes('cookie-secret'), false);
    assert.equal(serializedAlert.includes('payload-secret'), false);
    assert.equal(serializedAlert.includes('raw database secret'), false);
  } finally {
    await app.close();
  }
});

test('client errors do not send alert webhooks', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.example/hooks/charitypilot';

  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const app = await buildErrorApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/bad-request' });

    assert.equal(response.statusCode, 400);
    assert.equal(fetchCalled, false);
  } finally {
    await app.close();
  }
});

test('alert webhook failures do not change the API error response', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.example/hooks/charitypilot';

  globalThis.fetch = (async () => {
    throw new Error('alert destination unavailable');
  }) as typeof fetch;

  const app = await buildErrorApp();

  try {
    const response = await app.inject({ method: 'POST', url: '/boom' });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'Internal server error');
  } finally {
    await app.close();
  }
});

test('alert webhook sends are capped during error storms', { concurrency: false }, async () => {
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.example/hooks/charitypilot';
  process.env.ERROR_ALERT_WEBHOOK_MAX_IN_FLIGHT = '1';

  const payload: ErrorAlertPayload = {
    service: 'charitypilot-api',
    environment: 'production',
    severity: 'error',
    method: 'POST',
    url: '/boom',
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    errorName: 'Error',
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
  };

  let callCount = 0;
  const resolvers: Array<() => void> = [];
  const fetchImpl = (async () => {
    callCount += 1;
    await new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });

    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const firstAlert = sendErrorAlert(payload, fetchImpl);
  const secondAlert = sendErrorAlert({ ...payload, requestId: 'req-2' }, fetchImpl);
  const callsBeforeRelease = callCount;

  for (const resolve of resolvers) {
    resolve();
  }

  await Promise.all([firstAlert, secondAlert]);
  assert.equal(callsBeforeRelease, 1);
});

test('alert webhook sends do not follow redirects', { concurrency: false }, async () => {
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.example/hooks/charitypilot';

  const payload: ErrorAlertPayload = {
    service: 'charitypilot-api',
    environment: 'production',
    severity: 'error',
    method: 'POST',
    url: '/boom',
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    errorName: 'Error',
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
  };

  let redirectMode: string | undefined;
  const fetchImpl = (async (_url, init) => {
    redirectMode = init?.redirect;
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  await sendErrorAlert(payload, fetchImpl);

  assert.equal(redirectMode, 'error');
});
