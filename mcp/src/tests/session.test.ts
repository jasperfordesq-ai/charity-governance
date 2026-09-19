import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, NotConnectedError } from '../session.js';
import { createMemoryStore } from '../credentials.js';
import { redactSecrets } from '../redact.js';

/**
 * The connector routes hand tokens back in the JSON body and set no cookie.
 * That is the whole reason they may be reached without an Origin header, so
 * these stubs deliberately model a response with no Set-Cookie at all: a test
 * that fed cookies in would pass against a client that still read them.
 */
function jsonWithTokens(
  body: Record<string, unknown>,
  tokens: { accessToken?: string; refreshToken?: string },
): Response {
  return new Response(JSON.stringify({ ...body, ...tokens }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
    fetchImpl: async () => jsonWithTokens(LOGIN_BODY, {
      accessToken: 'access1',
      refreshToken: 'refresh1',
    }),
  });

  const identity = await session.login('a@b.ie', 'pw');

  assert.equal(identity.organisationName, 'hOUR Timebank CLG');
  assert.equal(identity.email, 'a@b.ie');
  assert.equal(store.read(), 'refresh1');
});

test('login posts to the connector route, not the browser one', async () => {
  const seen: string[] = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore(),
    fetchImpl: async (input) => {
      seen.push(String(input));
      return jsonWithTokens(LOGIN_BODY, { accessToken: 'a', refreshToken: 'r' });
    },
  });

  await session.login('a@b.ie', 'pw');

  assert.deepEqual(seen, ['https://example.test/api/v1/auth/connector/login']);
});

test('login asks for the access level it was configured with', async () => {
  const bodies: unknown[] = [];
  for (const level of ['read', 'write', 'admin'] as const) {
    const session = new Session({
      baseUrl: 'https://example.test',
      store: createMemoryStore(),
      accessLevel: level,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonWithTokens(LOGIN_BODY, { accessToken: 'a', refreshToken: 'r' });
      },
    });
    await session.login('a@b.ie', 'pw');
  }

  assert.deepEqual(
    bodies.map((b) => (b as { accessLevel: string }).accessLevel),
    ['READ', 'WRITE', 'ADMIN'],
    'the API enum is upper case; sending the connector spelling would be a 400',
  );
});

test('a session with no access level configured asks for WRITE, not ADMIN', async () => {
  let body: { accessLevel?: string } = {};
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore(),
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonWithTokens(LOGIN_BODY, { accessToken: 'a', refreshToken: 'r' });
    },
  });

  await session.login('a@b.ie', 'pw');

  assert.equal(body.accessLevel, 'WRITE', 'the safe default must not be the most powerful one');
});

test('accessToken reuses the cached token without another request', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => {
      calls += 1;
      return jsonWithTokens(LOGIN_BODY, { accessToken: 'access1', refreshToken: 'refresh1' });
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
    fetchImpl: async (input, init) => {
      assert.ok(String(input).endsWith('/api/v1/auth/connector/refresh'));
      assert.equal(
        JSON.parse(String(init?.body)).refreshToken,
        'refresh1',
        'the connector has no cookie jar, so the token must travel in the body',
      );
      return jsonWithTokens({}, { accessToken: 'access2', refreshToken: 'refresh2' });
    },
  });

  assert.equal(await session.accessToken(), 'access2');
  assert.equal(store.read(), 'refresh2', 'the rotated refresh token must replace the old one');
});

test('login, refresh and logout send NO Origin header, and always the client header', async () => {
  const store = createMemoryStore();
  const seenOrigins: (string | null)[] = [];
  const seenClients: (string | null)[] = [];
  const session = new Session({
    baseUrl: 'https://charitypilot.example.ts.net/',
    store,
    fetchImpl: async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenOrigins.push(headers.get('origin'));
      seenClients.push(headers.get('x-charitypilot-client'));
      return jsonWithTokens(LOGIN_BODY, { accessToken: 'access1', refreshToken: 'refresh1' });
    },
  });

  await session.login('a@b.ie', 'pw');
  session.invalidateAccessToken();
  await session.accessToken();
  await session.logout();

  assert.equal(seenOrigins.length, 3, 'login, refresh and logout must each have posted');
  for (const origin of seenOrigins) {
    // An Origin is browser evidence. The API refuses connector paths that carry
    // one, even an allow-listed one, so sending it would break every call.
    assert.equal(origin, null, 'a connector request must carry no Origin at all');
  }
  for (const client of seenClients) {
    assert.match(
      String(client),
      /^mcp-connector\/\d+\.\d+\.\d+/,
      'the API requires a versioned client header before it reads any credential',
    );
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
      'a 403 says nothing about credential validity — it is the non-browser guard refusing before the token is read');
    return true;
  });
  assert.equal(store.read(), 'refresh1', 'a 403 must not destroy the credential');
});

test('login reports a 403 as the connector guard, not bad credentials, so it cannot retry-lock the account', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://charitypilot.example.ts.net',
    store,
    fetchImpl: async () => new Response('{}', { status: 403 }),
  });

  await assert.rejects(() => session.login('a@b.ie', 'correct-password'), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.doesNotMatch((err as Error).message, /check the email address and password/i,
      'a 403 must not be reported as a credential problem — that sends a correct password back for a retry');
    assert.match((err as Error).message, /before checking the credentials/i);
    assert.match((err as Error).message, /charitypilot\.example\.ts\.net/,
      'the message should name the host being used so a baseUrl mismatch is visible');
    return true;
  });
  assert.equal(store.read(), null, 'a 403 on login never stored anything to begin with');
});

test('login reports a 404 as an out-of-date API, which is what it actually means', async () => {
  const session = new Session({
    baseUrl: 'https://charitypilot.example.ts.net',
    store: createMemoryStore(),
    fetchImpl: async () => new Response('{}', { status: 404 }),
  });

  await assert.rejects(() => session.login('a@b.ie', 'pw'), (err: unknown) => {
    assert.match((err as Error).message, /older than this connector/i);
    assert.doesNotMatch((err as Error).message, /check the email address and password/i);
    return true;
  });
});

test('login still reports a generic message for a 401, so it does not leak whether the email exists', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });

  await assert.rejects(() => session.login('a@b.ie', 'wrong-password'), /check the email address and password/i);
});

test('login throws if the body carried no refresh token, instead of reporting success', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    // Access token only — no refresh token in the body.
    fetchImpl: async () => jsonWithTokens(LOGIN_BODY, { accessToken: 'access1' }),
  });

  await assert.rejects(() => session.login('a@b.ie', 'pw'), /refresh token/i);
  assert.equal(store.read(), null, 'nothing should have been stored');
});

test('a login response that sets cookies is ignored — tokens come from the body only', async () => {
  const store = createMemoryStore();
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'charitypilot_access=cookie-access; Path=/');
  headers.append('set-cookie', 'charitypilot_refresh=cookie-refresh; Path=/');
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response(
      JSON.stringify({ ...LOGIN_BODY, accessToken: 'body-access', refreshToken: 'body-refresh' }),
      { status: 200, headers },
    ),
  });

  await session.login('a@b.ie', 'pw');

  assert.equal(store.read(), 'body-refresh');
  assert.equal(await session.accessToken(), 'body-access');
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
      return jsonWithTokens({}, {
        accessToken: `access${refreshCalls}`,
        refreshToken: `refresh${refreshCalls + 1}`,
      });
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
    fetchImpl: async () => jsonWithTokens(LOGIN_BODY, {
      accessToken: 'averylongaccesstokenvalue',
      refreshToken: 'averylongrefreshtokenvalue',
    }),
  });

  await session.login('a@b.ie', 'pw');

  assert.ok(!redactSecrets('leaked averylongaccesstokenvalue').includes('averylongaccesstokenvalue'));
  assert.ok(!redactSecrets('leaked averylongrefreshtokenvalue').includes('averylongrefreshtokenvalue'));
});

test('logout revokes server-side and clears the store', async () => {
  const store = createMemoryStore('refresh1');
  const seen: string[] = [];
  const bodies: unknown[] = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async (input, init) => {
      seen.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    },
  });

  await session.logout();

  assert.ok(seen.some((u) => u.endsWith('/api/v1/auth/connector/logout')));
  assert.equal(
    (bodies[0] as { refreshToken: string }).refreshToken,
    'refresh1',
    'the server cannot revoke a session it was not told about',
  );
  assert.equal(store.read(), null);
});

test('disconnect still works when the store refuses to answer, since that is the advice it gives', async () => {
  let cleared = false;
  const refusing = {
    read(): string | null { throw new Error('issued by another host'); },
    write() { /* unused */ },
    clear() { cleared = true; },
  };
  const session = new Session({
    baseUrl: 'https://example.test',
    store: refusing,
    fetchImpl: async () => assert.fail('nothing may be revoked without a token'),
  });

  await session.logout();

  assert.ok(cleared, 'the credential must still be removed');
});

test('a 429 says the attempts ran out, not that the password is wrong', async () => {
  const store = createMemoryStore();
  const session = new Session({
    baseUrl: 'https://example.test',
    store,
    fetchImpl: async () => new Response('{}', { status: 429 }),
  });

  await assert.rejects(() => session.login('a@b.ie', 'correct-password'), (err: unknown) => {
    assert.match((err as Error).message, /too many sign-in attempts/i);
    assert.doesNotMatch((err as Error).message, /check the email address and password/i,
      'the credentials were never looked at; sending someone back to retype a correct '
        + 'password spends the little attempt budget that remains');
    return true;
  });
  assert.equal(store.read(), null);
});
