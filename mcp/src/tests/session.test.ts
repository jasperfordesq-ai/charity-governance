import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, NotConnectedError } from '../session.js';
import { createMemoryStore } from '../credentials.js';
import { redactSecrets } from '../redact.js';

function jsonWithCookies(body: unknown, cookies: string[]): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const LOGIN_BODY = {
  user: {
    id: 'u1', email: 'a@b.ie', name: 'A B', role: 'OWNER',
    emailVerified: true, organisationId: 'org1',
    organisation: { id: 'org1', name: 'hOUR Timebank CLG' },
  },
};

test('login stores the refresh token and returns the identity', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => jsonWithCookies(LOGIN_BODY, [
      'charitypilot_access=access1; Path=/',
      'charitypilot_refresh=refresh1; Path=/',
    ]),
  });

  const identity = await session.login('a@b.ie', 'pw');

  assert.equal(identity.organisationName, 'hOUR Timebank CLG');
  assert.equal(identity.email, 'a@b.ie');
  assert.equal(store.read(), 'refresh1');
});

test('accessToken reuses the cached token without another request', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => {
      calls += 1;
      return jsonWithCookies(LOGIN_BODY, [
        'charitypilot_access=access1; Path=/',
        'charitypilot_refresh=refresh1; Path=/',
      ]);
    },
  });

  await session.login('a@b.ie', 'pw');
  assert.equal(await session.accessToken(), 'access1');
  assert.equal(await session.accessToken(), 'access1');
  assert.equal(calls, 1);
});

test('with only a stored refresh token, accessToken refreshes and stores the rotated token', async () => {
  const store = createMemoryStore('refresh1');
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async (input) => {
      assert.ok(String(input).endsWith('/api/v1/auth/refresh'));
      return jsonWithCookies({ ok: true }, [
        'charitypilot_access=access2; Path=/',
        'charitypilot_refresh=refresh2; Path=/',
      ]);
    },
  });

  assert.equal(await session.accessToken(), 'access2');
  assert.equal(store.read(), 'refresh2', 'the rotated refresh token must replace the old one');
});

test('login, refresh and logout all send an Origin header derived from baseUrl', async () => {
  const store = createMemoryStore();
  const seenOrigins: (string | null)[] = [];
  const session = new Session({
    baseUrl: 'https://charitypilot.example.ts.net/',
    store,
    fetchImpl: async (_input, init) => {
      seenOrigins.push(new Headers(init?.headers).get('origin'));
      return jsonWithCookies(LOGIN_BODY, [
        'charitypilot_access=access1; Path=/',
        'charitypilot_refresh=refresh1; Path=/',
      ]);
    },
  });

  await session.login('a@b.ie', 'pw'); // POST /auth/login
  session.invalidateAccessToken();
  await session.accessToken(); // POST /auth/refresh
  await session.logout(); // POST /auth/logout

  assert.equal(seenOrigins.length, 3, 'login, refresh and logout must each have posted');
  for (const origin of seenOrigins) {
    assert.equal(origin, 'https://charitypilot.example.ts.net', 'the Origin header must be scheme+host only, no path');
  }
});

test('a 403 on refresh keeps the credential instead of logging the user out', async () => {
  const store = createMemoryStore('refresh1');
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response('{}', { status: 403 }),
  });

  await assert.rejects(() => session.accessToken(), (err: unknown) => {
    assert.ok(!(err instanceof NotConnectedError),
      'a 403 says nothing about credential validity — it is the origin hook rejecting a missing Origin header, not a dead refresh token');
    return true;
  });
  assert.equal(store.read(), 'refresh1', 'a 403 must not destroy the credential');
});

test('login throws if no refresh token cookie was captured, instead of reporting success', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    // Access cookie only — no refresh cookie in the response.
    fetchImpl: async () => jsonWithCookies(LOGIN_BODY, ['charitypilot_access=access1; Path=/']),
  });

  await assert.rejects(() => session.login('a@b.ie', 'pw'), /refresh token/i);
  assert.equal(store.read(), null, 'nothing should have been stored');
});

test('a rejected refresh clears the store and reports NOT_CONNECTED', async () => {
  const store = createMemoryStore('stale');
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });

  await assert.rejects(() => session.accessToken(), (err: unknown) => {
    assert.ok(err instanceof NotConnectedError);
    return true;
  });
  assert.equal(store.read(), null, 'a dead refresh token must not be left behind');
});

test('a 500 on refresh keeps the credential instead of logging the user out', async () => {
  const store = createMemoryStore('refresh1');
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response('{}', { status: 500 }),
  });

  await assert.rejects(() => session.accessToken(), (err: unknown) => {
    assert.ok(!(err instanceof NotConnectedError), 'a server error is not a dead session');
    return true;
  });
  assert.equal(store.read(), 'refresh1', 'a transient server error must not destroy the credential');
});

test('accessToken with no stored token reports NOT_CONNECTED without any request', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore(),
    fetchImpl: async () => assert.fail('must not make a request'),
  });
  await assert.rejects(() => session.accessToken(), NotConnectedError);
});

test('concurrent callers share one refresh instead of racing to spend the token', async () => {
  const store = createMemoryStore('refresh1');
  let refreshCalls = 0;
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', `charitypilot_access=access${refreshCalls}; Path=/`);
      headers.append('set-cookie', `charitypilot_refresh=refresh${refreshCalls + 1}; Path=/`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    },
  });

  const [a, b, c] = await Promise.all([
    session.accessToken(), session.accessToken(), session.accessToken(),
  ]);

  assert.equal(refreshCalls, 1, 'a single-use refresh token must be spent exactly once');
  assert.equal(a, 'access1');
  assert.equal(b, 'access1');
  assert.equal(c, 'access1');
  assert.equal(store.read(), 'refresh2');
});

test('tokens are registered for redaction so later errors cannot leak them', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore(),
    fetchImpl: async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'charitypilot_access=averylongaccesstokenvalue; Path=/');
      headers.append('set-cookie', 'charitypilot_refresh=averylongrefreshtokenvalue; Path=/');
      return new Response(JSON.stringify(LOGIN_BODY), { status: 200, headers });
    },
  });

  await session.login('a@b.ie', 'pw');

  assert.ok(!redactSecrets('leaked averylongaccesstokenvalue').includes('averylongaccesstokenvalue'));
  assert.ok(!redactSecrets('leaked averylongrefreshtokenvalue').includes('averylongrefreshtokenvalue'));
});

test('logout revokes server-side and clears the store', async () => {
  const store = createMemoryStore('refresh1');
  const seen: string[] = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async (input) => {
      seen.push(String(input));
      return new Response('{}', { status: 200 });
    },
  });

  await session.logout();

  assert.ok(seen.some((u) => u.endsWith('/api/v1/auth/logout')));
  assert.equal(store.read(), null);
});
