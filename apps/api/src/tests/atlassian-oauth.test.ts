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

test('exchangeAuthorizationCode parses accessToken, refreshToken, expiresAt (with margin) and scopes', async () => {
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
  assert.equal(tokens.refreshToken, 'refresh-token-1');
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

test('refreshAccessToken parses accessToken, refreshToken, expiresAt (with margin) and scopes', async () => {
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
  assert.equal(tokens.refreshToken, 'refresh-token-2');
  assert.deepEqual(tokens.scopes, ['read:confluence']);
  assert.ok(tokens.expiresAt instanceof Date);

  assert.equal(calls.length, 1);
  const sentBody = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(sentBody.grant_type, 'refresh_token');
  assert.equal(sentBody.refresh_token, SECRET_REFRESH_TOKEN);
  assert.equal(sentBody.client_secret, SECRET_CLIENT_SECRET);
});

test('refreshAccessToken yields refreshToken: null when Atlassian omits refresh_token (no offline_access)', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      access_token: 'access-token-3',
      expires_in: 3600,
      scope: 'read:confluence',
      // no refresh_token field at all
    })) as typeof globalThis.fetch;

  const tokens = await refreshAccessToken(SECRET_REFRESH_TOKEN, buildDeps(fetchImpl));

  assert.equal(tokens.accessToken, 'access-token-3');
  assert.equal(tokens.refreshToken, null);
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
