import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCESS_TOKEN_COOKIE } from '../utils/auth-cookie-names.js';
import { validateUnsafeRequestOrigin } from '../utils/request-origin.js';

const allowedOrigins = new Set(['https://app.charitypilot.ie']);

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
