import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, NotConnectedError } from '../session.js';
import { createMemoryStore } from '../credentials.js';

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

test('accessToken with no stored token reports NOT_CONNECTED without any request', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore(),
    fetchImpl: async () => assert.fail('must not make a request'),
  });
  await assert.rejects(() => session.accessToken(), NotConnectedError);
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
