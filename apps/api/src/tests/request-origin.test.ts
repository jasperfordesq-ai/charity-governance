import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerBrowserOriginProtection } from '../plugins/browser-origin-protection.js';
import { ACCESS_TOKEN_COOKIE } from '../utils/auth-cookie-names.js';
import { validateUnsafeRequestOrigin } from '../utils/request-origin.js';

const allowedOrigins = new Set(['https://app.charitypilot.ie']);

async function buildOriginProtectedApp() {
  const app = Fastify({ logger: false });
  await registerBrowserOriginProtection(app, allowedOrigins);

  app.get('/ok', async () => ({ ok: true }));
  app.post('/ok', async () => ({ ok: true }));

  return app;
}

function request(method: string, options: { origin?: string; authorization?: string; accessCookie?: string } = {}) {
  return {
    method,
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    cookies: {
      ...(options.accessCookie ? { [ACCESS_TOKEN_COOKIE]: options.accessCookie } : {}),
    },
  };
}

test('unsafe cookie-authenticated requests require an Origin header', () => {
  const result = validateUnsafeRequestOrigin(
    request('POST', { accessCookie: 'access-token' }),
    allowedOrigins,
  );

  assert.deepEqual(result, {
    ok: false,
    statusCode: 403,
    payload: {
      error: 'Missing request origin',
      code: 'MISSING_ORIGIN',
    },
  });
});

test('unsafe bearer-authenticated requests may omit Origin headers for non-browser clients', () => {
  const result = validateUnsafeRequestOrigin(
    request('POST', { authorization: 'Bearer api-token', accessCookie: 'ignored-cookie' }),
    allowedOrigins,
  );

  assert.deepEqual(result, { ok: true });
});

test('unsafe requests reject unapproved origins', () => {
  const result = validateUnsafeRequestOrigin(
    request('DELETE', { origin: 'https://evil.example', accessCookie: 'access-token' }),
    allowedOrigins,
  );

  assert.deepEqual(result, {
    ok: false,
    statusCode: 403,
    payload: {
      error: 'Invalid request origin',
      code: 'INVALID_ORIGIN',
    },
  });
});

test('safe methods and approved browser origins pass origin validation', () => {
  assert.deepEqual(validateUnsafeRequestOrigin(request('GET'), allowedOrigins), { ok: true });
  assert.deepEqual(
    validateUnsafeRequestOrigin(
      request('PATCH', { origin: 'https://app.charitypilot.ie', accessCookie: 'access-token' }),
      allowedOrigins,
    ),
    { ok: true },
  );
});

test('disallowed CORS origins do not become server errors before the origin guard', async () => {
  const app = await buildOriginProtectedApp();

  try {
    const getResponse = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(getResponse.statusCode, 200);
    assert.equal(getResponse.headers['access-control-allow-origin'], undefined);

    const postResponse = await app.inject({
      method: 'POST',
      url: '/ok',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(postResponse.statusCode, 403);
    assert.equal(postResponse.json().code, 'INVALID_ORIGIN');

    const optionsResponse = await app.inject({
      method: 'OPTIONS',
      url: '/ok',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    assert.notEqual(optionsResponse.statusCode, 500);
  } finally {
    await app.close();
  }
});
