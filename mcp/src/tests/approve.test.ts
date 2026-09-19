import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../config.js';
import { assertApproveAllowed } from '../connect-input.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

function tokenResponse(): Response {
  return new Response(JSON.stringify({ accessToken: 'a1', refreshToken: 'r2' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('approve takes the identifier as a bare argument, the way the refusal prints it', () => {
  const config = parseArgs(['approve', 'apr-123']);

  assert.equal(config.command, 'approve');
  assert.equal(config.approvalId, 'apr-123');
});

test('approve refuses to run without a terminal, so an agent cannot grant its own actions', () => {
  assert.throws(
    () => assertApproveAllowed({ approvalId: 'apr-1', passwordStdin: false }, false),
    /must be run at a terminal/,
  );
});

test('approve refuses a piped password even on the local profile', () => {
  assert.throws(
    () => assertApproveAllowed({ approvalId: 'apr-1', passwordStdin: true }, true),
    /does not accept a piped password/,
  );
});

test('approve without an identifier says what to run', () => {
  assert.throws(
    () => assertApproveAllowed({ passwordStdin: false }, true),
    /charitypilot-mcp approve <id>/,
  );
});

test('approve at a terminal with an identifier is allowed', () => {
  assert.doesNotThrow(() =>
    assertApproveAllowed({ approvalId: 'apr-1', passwordStdin: false }, true),
  );
});

test('approving uses the session already connected rather than signing in again', async () => {
  const seen: Array<{ url: string; headers: Headers; body: string }> = [];
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      if (url.endsWith('/refresh')) return tokenResponse();
      return new Response(
        JSON.stringify({ ok: true, summary: 'Permanently delete: board members (DELETE)' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const outcome = await session.approve('apr-7', 'the-password');

  assert.equal(outcome.summary, 'Permanently delete: board members (DELETE)');

  const approve = seen.find((call) => call.url.endsWith('/approve'))!;
  assert.ok(approve, 'the approve route must be called');
  assert.match(String(approve.headers.get('authorization')), /^Bearer /);
  assert.equal(approve.headers.get('origin'), null, 'a connector request carries no origin');
  assert.match(
    String(approve.headers.get('x-charitypilot-client')),
    /^mcp-connector\//,
  );
  assert.deepEqual(JSON.parse(approve.body), {
    approvalId: 'apr-7',
    password: 'the-password',
  });

  assert.ok(
    !seen.some((call) => call.url.endsWith('/login')),
    'approving is not signing in; a second credential would be minted for no reason',
  );
});

test('a refused approval says the same thing whatever the reason was', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async (input) =>
      String(input).endsWith('/refresh')
        ? tokenResponse()
        : new Response('{}', { status: 401 }),
  });

  await assert.rejects(
    () => session.approve('apr-7', 'wrong'),
    /could not be granted/,
  );
});

test('a rate-limited approval says so, rather than blaming the password', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async (input) =>
      String(input).endsWith('/refresh')
        ? tokenResponse()
        : new Response('{}', { status: 429 }),
  });

  await assert.rejects(() => session.approve('apr-7', 'right'), (err: unknown) => {
    assert.match((err as Error).message, /too many approval attempts/i);
    assert.match((err as Error).message, /nothing is wrong with it/i);
    return true;
  });
});

test('the password is never written into an error, even when the call fails', async () => {
  const session = new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async (input) =>
      String(input).endsWith('/refresh')
        ? tokenResponse()
        : new Response('{}', { status: 401 }),
  });

  await assert.rejects(
    () => session.approve('apr-7', 'correct-horse-battery-staple'),
    (err: unknown) => {
      assert.ok(!(err as Error).message.includes('correct-horse-battery-staple'));
      return true;
    },
  );
});
