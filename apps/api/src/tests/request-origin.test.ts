import assert from 'node:assert/strict';
import test from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { registerBrowserOriginProtection } from '../plugins/browser-origin-protection.js';
import { authRoutes } from '../routes/auth/index.js';
import { teamRoutes } from '../routes/team/index.js';
import { ACCESS_TOKEN_COOKIE } from '../utils/auth-cookie-names.js';
import { validateUnsafeRequestOrigin } from '../utils/request-origin.js';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'request-origin-test-jwt-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_request_origin_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const allowedOrigins = new Set(['https://app.charitypilot.ie']);

async function buildOriginProtectedApp() {
  const app = Fastify({ logger: false });
  await registerBrowserOriginProtection(app, allowedOrigins);

  app.get('/ok', async () => ({ ok: true }));
  app.post('/ok', async () => ({ ok: true }));

  return app;
}

function request(
  method: string,
  options: { url?: string; origin?: string; authorization?: string; accessCookie?: string } = {},
) {
  return {
    method,
    url: options.url ?? '/ok',
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

test('public auth-cookie-setting requests require an Origin header', () => {
  for (const url of [
    '/auth/login',
    '/api/v1/auth/login',
    '/api/v2/auth/refresh',
    '/api/v1/team/accept-invite',
  ]) {
    const result = validateUnsafeRequestOrigin(request('POST', { url }), allowedOrigins);

    assert.deepEqual(result, {
      ok: false,
      statusCode: 403,
      payload: {
        error: 'Missing request origin',
        code: 'MISSING_ORIGIN',
      },
    });
  }
});

test('browser origin protection enforces real public cookie-setting routes at production prefixes', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    user: {
      findUnique: async () => null,
    },
    teamInvite: {
      findUnique: async () => null,
    },
  } as never);
  await registerBrowserOriginProtection(app, allowedOrigins);
  await app.register(cookie);

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(teamRoutes, { prefix: '/api/v1/team' });

  try {
    for (const route of [
      {
        url: '/api/v1/auth/login',
        payload: { email: 'missing@example.org', password: 'NewPassword1' },
        approvedStatusCode: 401,
      },
      {
        url: '/api/v1/auth/refresh',
        payload: {},
        approvedStatusCode: 401,
      },
      {
        url: '/api/v1/team/accept-invite',
        payload: { token: 'invalid-invite-token', name: 'Invitee', password: 'NewPassword1' },
        approvedStatusCode: 400,
      },
    ]) {
      const missingOrigin = await app.inject({ method: 'POST', url: route.url, payload: route.payload });
      assert.equal(missingOrigin.statusCode, 403, `${route.url} must reject missing Origin`);
      assert.equal(missingOrigin.json().code, 'MISSING_ORIGIN');

      const approvedOrigin = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { origin: 'https://app.charitypilot.ie' },
        payload: route.payload,
      });
      assert.equal(
        approvedOrigin.statusCode,
        route.approvedStatusCode,
        `${route.url} must reach its real handler with approved browser Origin`,
      );
    }
  } finally {
    await app.close();
  }
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
