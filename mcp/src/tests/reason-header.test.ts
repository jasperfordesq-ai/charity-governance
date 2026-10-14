import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, isNetworkFailure, reasonHeaders } from '../client.js';
import { ConnectionError, RequestNotSentError } from '../errors.js';
import { Session } from '../session.js';
import { createMemoryStore } from '../credentials.js';

/*
 * Found in live use on 2026-10-14: a reason containing an em dash made fetch
 * throw "Cannot convert argument to a ByteString", and the connector reported
 * it as "Cannot reach CharityPilot. Check that Tailscale is connected." The
 * header could not carry the text, and the error blamed the network.
 *
 * The characters below are written literally, not as escapes, on purpose.
 */
const EM_DASH = 'Code of Conduct — Trustee Declaration, signed and filed';
const FADA = 'Dearbhú ón gcathaoirleach: síníodh an cód iompair';
const EMOJI = 'Both declarations signed 🎉 and uploaded as evidence';

function sessionReturning(token: string): Session {
  return new Session({
    baseUrl: 'https://example.test',
    store: createMemoryStore('r1'),
    fetchImpl: async () => new Response(
      JSON.stringify({ accessToken: token, refreshToken: 'r2' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
}

/**
 * A fetch that builds real Headers from what it is given, which is exactly
 * where Node's fetch throws the ByteString error. A value that survives this
 * would survive the real fetch.
 */
function capturingClient(seen: Headers[]) {
  return new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('the unencoded reasons really do break a Headers object, so the tests below test something', () => {
  for (const reason of [EM_DASH, EMOJI]) {
    assert.throws(() => new Headers({ 'x-charitypilot-reason': reason }), TypeError, reason);
  }
});

for (const [label, reason] of [['an em dash', EM_DASH], ['a fada', FADA], ['an emoji', EMOJI]] as const) {
  test(`a reason with ${label} is sent, encoded, and decodes to exactly what was written`, async () => {
    const seen: Headers[] = [];
    await capturingClient(seen).patch('/api/v1/board-members/b1', { name: 'x' }, { reason });

    assert.equal(seen.length, 1);
    const header = seen[0]!.get('x-charitypilot-reason');
    assert.ok(header, 'the reason header was sent');
    assert.match(header, /^[\x20-\x7e]+$/, 'the value on the wire is plain ASCII');
    assert.equal(seen[0]!.get('x-charitypilot-reason-encoding'), 'percent');
    assert.equal(decodeURIComponent(header), reason);
  });
}

test('a plain ASCII reason is sent as written, with no encoding marker, as it always was', async () => {
  const seen: Headers[] = [];
  const reason = 'Mark both declarations as signed - 50% done';
  await capturingClient(seen).patch('/api/v1/board-members/b1', { name: 'x' }, { reason });

  assert.equal(seen[0]!.get('x-charitypilot-reason'), reason);
  assert.equal(seen[0]!.get('x-charitypilot-reason-encoding'), null);
});

test('the reason is capped at 500 code points without splitting an emoji', () => {
  const reason = 'a'.repeat(499) + '🎉🎉';
  const headers = reasonHeaders(reason);
  const decoded = decodeURIComponent(headers['x-charitypilot-reason']!);
  assert.equal(Array.from(decoded).length, 500);
  assert.ok(decoded.endsWith('🎉'), 'the last whole emoji is kept, not half of one');
});

test('a lone surrogate cannot make the encoder throw', () => {
  const headers = reasonHeaders('broken \uD83C text');
  assert.equal(decodeURIComponent(headers['x-charitypilot-reason']!), 'broken � text');
});

test('a TypeError raised while building the request is its own error, not a network failure', async () => {
  let attempts = 0;
  const client = new ApiClient({
    session: sessionReturning('access1'),
    baseUrl: 'https://example.test',
    fetchImpl: async () => {
      attempts += 1;
      // The exact error Node's fetch raised in the incident.
      throw new TypeError('Cannot convert argument to a ByteString because the character at index 16 has a value of 8212 which is greater than 255.');
    },
  });

  // A POST carries an idempotency key, which is what would license a retry
  // on a genuine dropped connection. It must not be spent on a local fault.
  await assert.rejects(() => client.post('/api/v1/deadlines', { title: 'x' }), (err: unknown) => {
    assert.ok(err instanceof RequestNotSentError, 'must not be reported as a connection failure');
    assert.ok(!(err instanceof ConnectionError));
    assert.equal(err.code, 'REQUEST_NOT_SENT');
    assert.equal(err.retryable, false);
    assert.doesNotMatch(err.message, /Tailscale|Cannot reach/i);
    assert.match(err.message, /nothing was sent/i);
    return true;
  });
  assert.equal(attempts, 1, 'a local fault is not retried');
});

test('genuine transport failures are still network failures', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 100.64.0.1:443'), { code: 'ECONNREFUSED' });
  assert.equal(isNetworkFailure(new TypeError('fetch failed', { cause: refused })), true);
  assert.equal(isNetworkFailure(new TypeError('fetch failed')), true);
  assert.equal(isNetworkFailure(refused), true);
  assert.equal(isNetworkFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true);

  assert.equal(isNetworkFailure(new TypeError('Cannot convert argument to a ByteString')), false);
  assert.equal(isNetworkFailure(new TypeError('Failed to parse URL from http://exa mple')), false);
  assert.equal(isNetworkFailure('fetch failed'), false);
});

test('with the real fetch, an em-dash reason reaches the network instead of failing locally', async () => {
  // Port 9 on loopback refuses the connection. Before the fix, real fetch
  // threw the ByteString TypeError before ever trying; now the request is
  // built, leaves, and meets a genuine refusal, reported as one.
  const client = new ApiClient({ session: sessionReturning('access1'), baseUrl: 'http://127.0.0.1:9' });
  await assert.rejects(
    () => client.patch('/api/v1/board-members/b1', { name: 'x' }, { reason: EM_DASH }),
    ConnectionError,
  );
});

test('with the real fetch, an unbuildable request is reported as not sent', async () => {
  const client = new ApiClient({ session: sessionReturning('access1'), baseUrl: 'http://exa mple.invalid' });
  await assert.rejects(() => client.get('/api/v1/organisation'), RequestNotSentError);
});
