import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, ApprovalRequiredError } from '../client.js';
import { ConnectionError } from '../errors.js';
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

function clientAnswering(status: number, body: unknown, headers: Record<string, string> = {}): ApiClient {
  return new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  });
}

test('a validation error names the fields that were wrong', async () => {
  const client = clientAnswering(400, {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: [{ field: 'dueDate', message: 'Invalid date' }],
  });
  await assert.rejects(() => client.post('/api/v1/deadlines', {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.match(err.message, /dueDate: Invalid date/);
    assert.match(err.message, /Correct the fields/);
    assert.equal(err.action, 'fix_arguments');
    assert.deepEqual(err.details, [{ field: 'dueDate', message: 'Invalid date' }]);
    return true;
  });
});

test('a conflict tells the agent to read the record again', async () => {
  const client = clientAnswering(409, {
    error: 'Deadline was changed by someone else',
    code: 'DEADLINE_UPDATE_CONFLICT',
  });
  await assert.rejects(() => client.patch('/api/v1/deadlines/d1', {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /DEADLINE_UPDATE_CONFLICT/);
    assert.match(err.message, /Read it again/);
    assert.equal(err.action, 'reread');
    assert.equal(err.retryable, true);
    return true;
  });
});

test('a missing record is distinguished from a missing route', async () => {
  const record = clientAnswering(404, { error: 'Deadline not found', code: 'DEADLINE_NOT_FOUND' });
  await assert.rejects(() => record.get('/api/v1/deadlines/d1'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /No such record in this charity/);
    return true;
  });

  const route = clientAnswering(404, { message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 });
  await assert.rejects(() => route.get('/api/v1/x'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, null);
    assert.match(err.message, /older than this connector/);
    return true;
  });
});

test('a rate limit carries the seconds to wait', async () => {
  const client = clientAnswering(429, { error: 'Too many', code: 'CONNECTOR_WRITE_LIMIT' }, { 'retry-after': '17' });
  await assert.rejects(() => client.post('/api/v1/deadlines', {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.retryAfterSeconds, 17);
    assert.match(err.message, /Wait 17 seconds/);
    assert.equal(err.action, 'wait');
    return true;
  });
});

test('a code the connector does not know is named but its text is not quoted', async () => {
  const client = clientAnswering(403, { error: 'path /srv/files/x.pdf is outside the root', code: 'STORAGE_PATH_FORBIDDEN' });
  await assert.rejects(() => client.get('/api/v1/documents/1'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /STORAGE_PATH_FORBIDDEN/);
    assert.ok(!err.message.includes('/srv/files'), 'unknown codes keep their text server-side');
    return true;
  });
});

test('a server error is marked retryable', async () => {
  const client = clientAnswering(500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
  await assert.rejects(() => client.get('/api/v1/organisation'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.retryable, true);
    assert.match(err.message, /try again shortly/);
    return true;
  });
});

test('an approval refusal says to call again with the same arguments and the identifier', async () => {
  const client = clientAnswering(428, {
    code: 'APPROVAL_REQUIRED',
    approvalId: 'apr_9',
    summary: 'Permanently delete risk "Flood"',
    command: 'charitypilot-mcp approve apr_9',
    expiresAt: '2026-09-20T10:00:00.000Z',
    resourceId: 'risk_1',
  });
  await assert.rejects(() => client.delete('/api/v1/governance-registers/risks/risk_1'), (err: unknown) => {
    assert.ok(err instanceof ApprovalRequiredError);
    assert.match(err.message, /exactly the same arguments plus approvalId: apr_9/);
    assert.equal(err.resourceId, 'risk_1');
    return true;
  });
});

test('a network failure is a ConnectionError, retryable, with the cause redacted', async () => {
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw new Error('ECONNREFUSED Bearer access1'); },
  });
  await assert.rejects(() => client.get('/api/v1/organisation'), (err: unknown) => {
    assert.ok(err instanceof ConnectionError);
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.retryable, true);
    assert.ok(!err.message.includes('access1'));
    return true;
  });
});

test('a download whose access token has expired is retried once', async () => {
  let calls = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 401 });
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="minutes.pdf"' },
      });
    },
  });
  const { bytes, fileName } = await client.download('/api/v1/documents/d1/download');
  assert.equal(calls, 2);
  assert.equal(fileName, 'minutes.pdf');
  assert.equal(bytes.toString('latin1'), '%PDF');
});

// ── naming a create so it happens once ─────────────────────────────────────

test('every create carries a key, and no two creates carry the same one', async () => {
  const keys: (string | null)[] = [];
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      return new Response(JSON.stringify({ data: { id: 'x' } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.post('/api/v1/board-members', { name: 'A Trustee' });
  await client.post('/api/v1/board-members', { name: 'A Trustee' });

  assert.equal(keys.length, 2);
  assert.ok(keys[0], 'a create must be named');
  assert.notEqual(keys[0], keys[1], 'two creates are two requests');
  assert.match(keys[0] as string, /^[0-9a-f-]{36}$/);
});

test('a caller may name a create itself, to make two calls one request', async () => {
  let seen: string | null = null;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      seen = new Headers(init?.headers).get('idempotency-key');
      return new Response(JSON.stringify({}), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.post('/api/v1/board-members', { name: 'A Trustee' }, {
    idempotencyKey: 'a-key-the-caller-chose',
  });

  assert.equal(seen, 'a-key-the-caller-chose');
});

test('a change and a removal carry no key, because repeating them is already safe', async () => {
  const keys: (string | null)[] = [];
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      return new Response(JSON.stringify({}), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.patch('/api/v1/board-members/bm-1', { name: 'Renamed' });
  await client.delete('/api/v1/board-members/bm-1');

  assert.deepEqual(keys, [null, null]);
});

test('a create that meets a dropped connection is asked again, with the same key', async () => {
  const keys: (string | null)[] = [];
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: { id: 'act-1' } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.post<{ data: { id: string } }>('/api/v1/governing-acts', {
    title: 'Board meeting',
  });

  assert.equal(attempts, 2);
  assert.equal(keys[0], keys[1], 'the retry must be the same request, not a second one');
  assert.deepEqual(result, { data: { id: 'act-1' } });
});

test('a create is asked again once and no more', async () => {
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => client.post('/api/v1/governing-acts', { title: 'Board meeting' }),
    (err: unknown) => {
      assert.ok(err instanceof ConnectionError);
      return true;
    },
  );
  assert.equal(attempts, 2, 'one attempt and one retry, never a loop');
});

test('a read that meets a dropped connection is not asked again', async () => {
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(() => client.get('/api/v1/board-members'), ConnectionError);
  assert.equal(attempts, 1);
});

test('an upload that meets a dropped connection is reported, never resent', async () => {
  // Held by two things. An upload carries no key, so the retry is not offered
  // in the first place; and a FormData body is consumed by the first attempt,
  // so even a named upload would be refused a second send rather than putting
  // an empty file where the operator's document should be.
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => client.upload(
      '/api/v1/documents',
      { name: 'policy.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') },
      { name: 'Policy', category: 'POLICY' },
    ),
    ConnectionError,
  );
  assert.equal(attempts, 1);
});

test('a token refresh and a dropped connection are each allowed their own attempt', async () => {
  const seen: string[] = [];
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      attempts += 1;
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      if (attempts === 1) return new Response('{}', { status: 401 });
      if (attempts === 2) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: { id: 'x' } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.post<{ data: { id: string } }>('/api/v1/governing-acts', {
    title: 'Board meeting',
  });

  assert.equal(attempts, 3, 'the refresh must not have spent the connection attempt');
  assert.deepEqual(result, { data: { id: 'x' } });
});
