import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function sessionReturning(token: string): Session {
  return new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    // The connector routes return tokens in the body and set no cookie.
    fetchImpl: async () => new Response(
      JSON.stringify({ accessToken: token, refreshToken: 'r2' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
}

test('get attaches the bearer token', async () => {
  let seenAuth: string | null = null;
  const session = sessionReturning('access1');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ total: 3 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.get<{ total: number }>('/api/v1/compliance/summary');

  assert.equal(seenAuth, 'Bearer access1');
  assert.deepEqual(result, { total: 3 });
});

test('a 403 surfaces as ApiError with the status and no response body echoed', async () => {
  const session = sessionReturning('access1');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(
      JSON.stringify({ error: 'Forbidden', internalHint: 'org mismatch at row 42' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  });

  await assert.rejects(() => client.get('/api/v1/compliance/summary'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('row 42'), 'internal detail must not be echoed');
    return true;
  });
});

test('an expired access token is retried once, transparently', async () => {
  const session = sessionReturning('access1');
  let calls = 0;
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ total: 7 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.get<{ total: number }>('/api/v1/compliance/summary');

  assert.deepEqual(result, { total: 7 }, 'the retry result must be returned');
  assert.equal(calls, 2, 'exactly one retry, no more');
});

test('a second consecutive 401 gives up rather than looping', async () => {
  const session = sessionReturning('access1');
  let calls = 0;
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 401 });
    },
  });

  await assert.rejects(() => client.get('/x'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    return true;
  });
  assert.equal(calls, 2, 'one original attempt plus one retry, then stop');
});

test('a network failure is reported as a Tailscale hint', async () => {
  const session = sessionReturning('access1');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });

  await assert.rejects(() => client.get('/x'), (err: unknown) => {
    assert.match((err as Error).message, /Tailscale/i);
    return true;
  });
});

test('error messages never contain a token value', async () => {
  const session = sessionReturning('supersecrettoken123');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw new Error('failed calling with Bearer supersecrettoken123'); },
  });

  await assert.rejects(() => client.get('/x'), (err: unknown) => {
    assert.ok(!(err as Error).message.includes('supersecrettoken123'));
    return true;
  });
});

test('a non-JSON body is not echoed back in the error', async () => {
  const session = sessionReturning('access1');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response('<html><body>Captive portal sign-in</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
  });

  await assert.rejects(() => client.get('/x'), (err: unknown) => {
    assert.ok(err instanceof ApiError, 'must be an ApiError, not a raw SyntaxError');
    assert.ok(!err.message.includes('<html>'), 'the body must not be echoed');
    assert.ok(!err.message.includes('Captive portal sign-in'), 'the body must not be echoed');
    return true;
  });
});

test('the retry uses a NEW token, not the expired one', async () => {
  let refreshes = 0;
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => {
      refreshes += 1;
      return new Response(
        JSON.stringify({ accessToken: `access${refreshes}`, refreshToken: `r${refreshes + 1}` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const seen: (string | null)[] = [];
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      if (seen.length === 1) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.get('/x');

  assert.equal(seen.length, 2, 'one original attempt plus one retry');
  assert.notEqual(seen[0], seen[1], 'the retry must carry a freshly refreshed token');
  assert.equal(seen[0], 'Bearer access1');
  assert.equal(seen[1], 'Bearer access2');
});

test('a 204 is a successful removal, not a broken connection', async () => {
  const session = sessionReturning('access1');
  const client = new ApiClient({
    session,
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  // Insisting on JSON here made every delete report a captive portal.
  const result = await client.delete<{ ok: boolean }>('/api/v1/governance-registers/risks/x');

  assert.equal(result.ok, true);
});
