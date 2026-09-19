import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../client.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function sessionReturning(token: string): Session {
  return new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', `charitypilot_access=${token}; Path=/`);
      headers.append('set-cookie', 'charitypilot_refresh=r2; Path=/');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    },
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
