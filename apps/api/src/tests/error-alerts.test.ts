import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sendErrorAlert, type ErrorAlertPayload } from '../services/error-alerts.service.js';
import { AppError, handleError } from '../utils/errors.js';

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

  app.get('/caught-bad-request', async (_request, reply) => {
    try {
      throw new AppError(400, 'BAD_REQUEST', 'Bad request', { field: 'name' });
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/caught-provider-error', async (_request, reply) => {
    try {
      throw new AppError(
        500,
        'STORAGE_SIGNED_URL_FAILED',
        'Failed to generate signed URL: provider-secret',
      );
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/caught-provider-unavailable', async (_request, reply) => {
    try {
      throw new AppError(
        503,
        'STORAGE_PROVIDER_UNAVAILABLE',
        'Storage provider unavailable: provider-secret',
      );
    } catch (err) {
      handleError(reply, err);
    }
  });

  return app;
}

test('production 5xx errors send a sanitized alert webhook payload', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

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
    assert.equal(alert.url, 'https://alerts.charitypilot.ie/hooks/charitypilot');
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
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const app = await buildErrorApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/caught-bad-request' });
    const body = response.json();

    assert.equal(response.statusCode, 400);
    assert.equal(body.error, 'Bad request');
    assert.equal(body.code, 'BAD_REQUEST');
    assert.deepEqual(body.details, { field: 'name' });
    assert.equal(fetchCalled, false);
  } finally {
    await app.close();
  }
});

test('caught route 5xx errors are sanitized and still send alert webhooks', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

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
    const response = await app.inject({ method: 'GET', url: '/caught-provider-error' });
    const body = response.json();

    assert.equal(response.statusCode, 500);
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(body).includes('provider-secret'), false);
    assert.equal(alertCalls.length, 1);
    assert.equal(alertCalls[0].url, 'https://alerts.charitypilot.ie/hooks/charitypilot');
    assert.equal(alertCalls[0].body.statusCode, 500);
    assert.equal(alertCalls[0].body.code, 'STORAGE_SIGNED_URL_FAILED');
    assert.equal(alertCalls[0].body.method, 'GET');
    assert.equal(alertCalls[0].body.url, '/caught-provider-error');
    assert.equal(alertCalls[0].body.errorName, 'AppError');
    assert.equal(typeof alertCalls[0].body.requestId, 'string');
    assert.equal(typeof alertCalls[0].body.timestamp, 'string');
    assert.equal('message' in alertCalls[0].body, false);
    assert.equal('stack' in alertCalls[0].body, false);

    const serializedAlert = JSON.stringify(alertCalls[0].body);
    assert.equal(serializedAlert.includes('provider-secret'), false);
  } finally {
    await app.close();
  }
});

test('caught route non-500 5xx errors keep status while sanitizing response and alerts', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

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
    const response = await app.inject({ method: 'GET', url: '/caught-provider-unavailable' });
    const body = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(body).includes('provider-secret'), false);
    assert.equal(alertCalls.length, 1);
    assert.equal(alertCalls[0].body.statusCode, 503);
    assert.equal(alertCalls[0].body.code, 'STORAGE_PROVIDER_UNAVAILABLE');
    assert.equal(alertCalls[0].body.url, '/caught-provider-unavailable');
    assert.equal(JSON.stringify(alertCalls[0].body).includes('provider-secret'), false);
  } finally {
    await app.close();
  }
});

test('alert webhook failures do not change the API error response', { concurrency: false }, async () => {
  process.env.NODE_ENV = 'production';
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

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
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';
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
  process.env.ERROR_ALERT_WEBHOOK_URL = 'https://alerts.charitypilot.ie/hooks/charitypilot';

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
