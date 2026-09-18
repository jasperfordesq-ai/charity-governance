import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exchangeAuthorizationCode,
  listAccessibleResources,
  refreshAccessToken,
  type OAuthDeps,
} from '../services/atlassian-oauth.js';
import { AppError } from '../utils/errors.js';

const SECRET_CODE = 'auth-code-super-secret-value';
const SECRET_REFRESH_TOKEN = 'refresh-token-super-secret-value';
const SECRET_CLIENT_SECRET = 'client-secret-super-secret-value';
const CLIENT_ID = 'client-id-123';
const REDIRECT_URI = 'https://app.example.org/oauth/callback';

type FakeCall = { url: string; init: RequestInit | undefined };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string, contentType = 'text/html'): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
  });
}

function buildDeps(fetchImpl: typeof globalThis.fetch): OAuthDeps {
  return {
    fetch: fetchImpl,
    clientId: CLIENT_ID,
    clientSecret: SECRET_CLIENT_SECRET,
  };
}

function assertNoSecretLeak(err: unknown, secrets: string[]): AppError {
  assert.equal(err instanceof AppError, true, 'expected an AppError');
  const appError = err as AppError;
  const haystacks = [
    appError.message,
    JSON.stringify(appError.cause ?? null),
    JSON.stringify(appError.details ?? null),
  ];
  for (const secret of secrets) {
    for (const haystack of haystacks) {
      assert.equal(
        haystack.includes(secret),
        false,
        `expected secret ${JSON.stringify(secret)} not to appear in ${haystack}`,
      );
    }
  }
  return appError;
}

test('exchangeAuthorizationCode parses accessToken, an issued refreshToken, expiresAt (with margin) and scopes', async () => {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, {
      access_token: 'access-token-1',
      refresh_token: 'refresh-token-1',
      expires_in: 3600,
      scope: 'read:confluence write:confluence',
    });
  }) as typeof globalThis.fetch;

  const before = Date.now();
  const tokens = await exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl));
  const after = Date.now();

  assert.equal(tokens.accessToken, 'access-token-1');
  assert.deepEqual(tokens.refreshToken, { kind: 'issued', token: 'refresh-token-1' });
  assert.deepEqual(tokens.scopes, ['read:confluence', 'write:confluence']);

  const expectedMin = before + (3600 - 60) * 1000;
  const expectedMax = after + (3600 - 60) * 1000;
  assert.ok(tokens.expiresAt instanceof Date);
  assert.ok(
    tokens.expiresAt.getTime() >= expectedMin && tokens.expiresAt.getTime() <= expectedMax,
    `expiresAt ${tokens.expiresAt.toISOString()} should carry a 60s safety margin`,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://auth.atlassian.com/oauth/token');
  const sentBody = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(sentBody.grant_type, 'authorization_code');
  assert.equal(sentBody.client_id, CLIENT_ID);
  assert.equal(sentBody.client_secret, SECRET_CLIENT_SECRET);
  assert.equal(sentBody.code, SECRET_CODE);
  assert.equal(sentBody.redirect_uri, REDIRECT_URI);
});

test('exchangeAuthorizationCode yields refreshToken: { kind: "unavailable" } when offline_access was not granted', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      access_token: 'access-token-1b',
      expires_in: 3600,
      scope: 'read:confluence',
      // no refresh_token field: offline_access was not granted
    })) as typeof globalThis.fetch;

  const tokens = await exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl));

  assert.deepEqual(tokens.refreshToken, { kind: 'unavailable' });
});

test('refreshAccessToken parses accessToken, an issued refreshToken, expiresAt (with margin) and scopes', async () => {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, {
      access_token: 'access-token-2',
      refresh_token: 'refresh-token-2',
      expires_in: 7200,
      scope: 'read:confluence',
    });
  }) as typeof globalThis.fetch;

  const tokens = await refreshAccessToken(SECRET_REFRESH_TOKEN, buildDeps(fetchImpl));

  assert.equal(tokens.accessToken, 'access-token-2');
  assert.deepEqual(tokens.refreshToken, { kind: 'issued', token: 'refresh-token-2' });
  assert.deepEqual(tokens.scopes, ['read:confluence']);
  assert.ok(tokens.expiresAt instanceof Date);

  assert.equal(calls.length, 1);
  const sentBody = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(sentBody.grant_type, 'refresh_token');
  assert.equal(sentBody.refresh_token, SECRET_REFRESH_TOKEN);
  assert.equal(sentBody.client_secret, SECRET_CLIENT_SECRET);
});

test('refreshAccessToken yields refreshToken: { kind: "not_rotated" } when Atlassian omits refresh_token — the existing stored token is still valid', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      access_token: 'access-token-3',
      expires_in: 3600,
      scope: 'read:confluence',
      // no refresh_token field at all: NOT the same meaning as exchange's
      // "unavailable" — Atlassian simply did not rotate it this time.
    })) as typeof globalThis.fetch;

  const tokens = await refreshAccessToken(SECRET_REFRESH_TOKEN, buildDeps(fetchImpl));

  assert.equal(tokens.accessToken, 'access-token-3');
  assert.deepEqual(tokens.refreshToken, { kind: 'not_rotated' });
});

test('a non-2xx token response throws an AppError that leaks none of the secret inputs', async () => {
  const fetchImpl = (async () =>
    // Simulates Atlassian's error body, which the brief warns can echo back
    // parts of the request. Even though the raw body below contains every
    // secret involved in this call, only `error` / `error_description` may
    // ever reach the thrown error.
    jsonResponse(400, {
      error: 'invalid_grant',
      error_description: 'Invalid authorization code',
      code: SECRET_CODE,
      refresh_token: SECRET_REFRESH_TOKEN,
      client_secret: SECRET_CLIENT_SECRET,
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl)),
    (err: unknown) => {
      const appError = assertNoSecretLeak(err, [SECRET_CODE, SECRET_REFRESH_TOKEN, SECRET_CLIENT_SECRET]);
      assert.match(appError.message, /invalid_grant/);
      assert.match(appError.message, /Invalid authorization code/);
      assert.equal(appError.code, 'ATLASSIAN_OAUTH_TOKEN_FAILED');
      // A rejected grant is the charity's own stale/invalid input, not our
      // server failing — it must not be a >=500 that pages the operator or
      // sends error_description to the alert webhook.
      assert.equal(appError.statusCode, 400);
      assert.deepEqual(appError.details, {
        status: 400,
        error: 'invalid_grant',
        error_description: 'Invalid authorization code',
      });
      return true;
    },
  );
});

test('a non-2xx refresh response throws an AppError that leaks none of the secret inputs', async () => {
  const fetchImpl = (async () =>
    jsonResponse(401, {
      error: 'invalid_grant',
      error_description: 'The refresh token is invalid or expired',
      refresh_token: SECRET_REFRESH_TOKEN,
      client_secret: SECRET_CLIENT_SECRET,
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => refreshAccessToken(SECRET_REFRESH_TOKEN, buildDeps(fetchImpl)),
    (err: unknown) => {
      assertNoSecretLeak(err, [SECRET_REFRESH_TOKEN, SECRET_CLIENT_SECRET]);
      return true;
    },
  );
});

test('a 502 with an HTML error body and a 400 with a JSON body lacking `error` are distinguishable, not byte-identical', async () => {
  const htmlFetch = (async () =>
    textResponse(502, '<html><body>Bad Gateway</body></html>')) as typeof globalThis.fetch;
  const jsonNoErrorFetch = (async () => jsonResponse(400, { message: 'nope' })) as typeof globalThis.fetch;

  let htmlError: AppError | undefined;
  try {
    await exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(htmlFetch));
  } catch (err) {
    htmlError = err as AppError;
  }

  let jsonNoErrorError: AppError | undefined;
  try {
    await exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(jsonNoErrorFetch));
  } catch (err) {
    jsonNoErrorError = err as AppError;
  }

  assert.ok(htmlError instanceof AppError);
  assert.ok(jsonNoErrorError instanceof AppError);
  assert.equal(htmlError.code, 'ATLASSIAN_OAUTH_ERROR_BODY_UNREADABLE');
  assert.equal(jsonNoErrorError.code, 'ATLASSIAN_OAUTH_ERROR_BODY_UNREADABLE');
  // Same code is fine (both are "we don't know what went wrong"), but they
  // must not be byte-identical: the status — the one discriminator that
  // can never echo the request back — must appear in both message and
  // details, and differ between the two.
  assert.deepEqual(htmlError.details, { status: 502 });
  assert.deepEqual(jsonNoErrorError.details, { status: 400 });
  assert.notEqual(htmlError.message, jsonNoErrorError.message);
  assert.match(htmlError.message, /502/);
  assert.match(jsonNoErrorError.message, /400/);
  // A genuinely unreachable/malformed upstream still maps to 502...
  assert.equal(htmlError.statusCode, 502);
  // ...but a 4xx with an unreadable body is still the caller's own client
  // error, and must not escalate to a >=500 that pages the operator.
  assert.equal(jsonNoErrorError.statusCode, 400);
});

test('a success body missing expires_in throws ATLASSIAN_OAUTH_RESPONSE_INVALID instead of yielding an Invalid Date', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      access_token: 'access-token-4',
      refresh_token: 'refresh-token-4',
      // expires_in omitted
      scope: 'read:confluence',
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl)),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).code, 'ATLASSIAN_OAUTH_RESPONSE_INVALID');
      return true;
    },
  );
});

test('a success body missing access_token throws ATLASSIAN_OAUTH_RESPONSE_INVALID instead of yielding accessToken: undefined', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      // access_token omitted
      refresh_token: 'refresh-token-5',
      expires_in: 3600,
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl)),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).code, 'ATLASSIAN_OAUTH_RESPONSE_INVALID');
      return true;
    },
  );
});

test('a success body with a non-string scope throws ATLASSIAN_OAUTH_RESPONSE_INVALID instead of a raw TypeError', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      access_token: 'access-token-6',
      refresh_token: 'refresh-token-6',
      expires_in: 3600,
      scope: ['read:confluence', 'write:confluence'], // not a string
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl)),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
      assert.equal((err as AppError).code, 'ATLASSIAN_OAUTH_RESPONSE_INVALID');
      return true;
    },
  );
});

test('listAccessibleResources parses the accessible site list from a bearer-authorized GET', async () => {
  const accessToken = 'access-token-for-sites';
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, [
      {
        id: 'cloud-id-1',
        url: 'https://example1.atlassian.net',
        name: 'Example One',
        scopes: ['read:confluence-content.all'],
        avatarUrl: 'https://example1.atlassian.net/avatar.png',
      },
      {
        id: 'cloud-id-2',
        url: 'https://example2.atlassian.net',
        name: 'Example Two',
      },
    ]);
  }) as typeof globalThis.fetch;

  const sites = await listAccessibleResources(accessToken, { fetch: fetchImpl });

  assert.deepEqual(sites, [
    { id: 'cloud-id-1', url: 'https://example1.atlassian.net', name: 'Example One' },
    { id: 'cloud-id-2', url: 'https://example2.atlassian.net', name: 'Example Two' },
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.atlassian.com/oauth/token/accessible-resources');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${accessToken}`);
});

test('listAccessibleResources throws ATLASSIAN_OAUTH_RESPONSE_INVALID instead of a raw TypeError on a null entry', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, [
      { id: 'cloud-id-1', url: 'https://example1.atlassian.net', name: 'Example One' },
      null,
    ])) as typeof globalThis.fetch;

  await assert.rejects(
    () => listAccessibleResources('access-token-for-sites', { fetch: fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
      assert.equal((err as AppError).code, 'ATLASSIAN_OAUTH_RESPONSE_INVALID');
      return true;
    },
  );
});

test('a non-2xx accessible-resources response throws an AppError that leaks none of the access token', async () => {
  const accessToken = 'access-token-that-must-not-leak';
  const fetchImpl = (async () =>
    jsonResponse(403, {
      error: 'invalid_token',
      error_description: 'The access token is invalid',
      authorization: `Bearer ${accessToken}`,
    })) as typeof globalThis.fetch;

  await assert.rejects(
    () => listAccessibleResources(accessToken, { fetch: fetchImpl }),
    (err: unknown) => {
      assertNoSecretLeak(err, [accessToken]);
      return true;
    },
  );
});

test('a rejected fetch (transport failure) throws ATLASSIAN_OAUTH_UNREACHABLE with no cause attached, even though the underlying error carries a secret', async () => {
  const fetchImpl = (async () => {
    // Mirrors Node's real `fetch failed` shape, where `cause` can carry the
    // request URL/body. Plants a secret directly in the message to prove
    // the module truly never attaches it, rather than merely not logging
    // it today.
    throw new Error(`fetch failed: could not reach auth.atlassian.com with code=${SECRET_CODE}`);
  }) as typeof globalThis.fetch;

  await assert.rejects(
    () => exchangeAuthorizationCode(SECRET_CODE, REDIRECT_URI, buildDeps(fetchImpl)),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      const appError = err as AppError;
      assert.equal(appError.code, 'ATLASSIAN_OAUTH_UNREACHABLE');
      assert.equal(appError.cause, undefined);
      assertNoSecretLeak(appError, [SECRET_CODE]);
      return true;
    },
  );
});

test('a rejected fetch (transport failure) on listAccessibleResources throws ATLASSIAN_OAUTH_UNREACHABLE with no cause attached', async () => {
  const accessToken = 'access-token-that-must-not-leak-2';
  const fetchImpl = (async () => {
    throw new Error(`fetch failed: could not reach api.atlassian.com, Authorization: Bearer ${accessToken}`);
  }) as typeof globalThis.fetch;

  await assert.rejects(
    () => listAccessibleResources(accessToken, { fetch: fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      const appError = err as AppError;
      assert.equal(appError.code, 'ATLASSIAN_OAUTH_UNREACHABLE');
      assert.equal(appError.cause, undefined);
      assertNoSecretLeak(appError, [accessToken]);
      return true;
    },
  );
});
