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
