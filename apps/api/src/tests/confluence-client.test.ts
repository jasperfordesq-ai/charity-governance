import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFLUENCE_MAX_ATTEMPTS,
  CONFLUENCE_REQUEST_TIMEOUT_MS,
  CONFLUENCE_TOTAL_DEADLINE_MS,
  createConfluenceClient,
  resolveRequestTimeoutMs,
  type ConfluenceClientDeps,
  type ConfluenceRequestSpec,
} from '../services/confluence-client.js';
import { AppError } from '../utils/errors.js';

const CLOUD_ID = '11111111-2222-3333-4444-555555555555';

// The one literal that must never appear anywhere but an Authorization header.
const ACCESS_TOKEN = 'confluence-access-token-SUPERSECRET';

type FetchCall = { url: string; init: RequestInit | undefined };
type Step = () => Promise<Response>;

function jsonStep(status: number, body: unknown, headers: Record<string, string> = {}): Step {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function emptyStep(status: number, headers: Record<string, string> = {}): Step {
  return async () => new Response(null, { status, headers });
}

function throwStep(error: unknown): Step {
  return async () => {
    throw error;
  };
}

type Harness = {
  request(spec: ConfluenceRequestSpec): Promise<{ status: number; body: unknown }>;
  calls: FetchCall[];
  sleeps: number[];
  tokenCalls(): number;
};

/**
 * A client wired to a scripted fetch. The LAST step repeats, so a single
 * `jsonStep(429, ...)` drives every attempt of a cap test while `calls.length`
 * still reports exactly how many requests were really issued.
 */
function harness(
  steps: Step[],
  opts: { deps?: ConfluenceClientDeps; cloudId?: string; token?: string } = {},
): Harness {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  let tokenCalls = 0;

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step();
  }) as unknown as typeof globalThis.fetch;

  const client = createConfluenceClient(
    {
      cloudId: opts.cloudId ?? CLOUD_ID,
      getAccessToken: async () => {
        tokenCalls += 1;
        return opts.token ?? ACCESS_TOKEN;
      },
    },
    {
      fetch: fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      // Jitter is a real requirement, so it has a seam: zero makes every
      // backoff assertion exact, and one test below exercises the spread.
      random: () => 0,
      ...opts.deps,
    },
  );

  return { request: (spec) => client.request(spec), calls, sleeps, tokenCalls: () => tokenCalls };
}

function headerOf(call: FetchCall, name: string): string | null {
  return new Headers((call.init?.headers as Record<string, string>) ?? {}).get(name);
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err;
  }
  return assert.fail('expected the request to reject');
}

function assertNoTokenLeak(err: AppError): void {
  const haystacks = [
    err.message,
    String(err.stack ?? ''),
    JSON.stringify(err.cause ?? null),
    JSON.stringify(err.details ?? null),
  ];
  for (const haystack of haystacks) {
    assert.equal(haystack.includes(ACCESS_TOKEN), false, `the access token appeared in ${haystack}`);
  }
}

const GET_PAGE: ConfluenceRequestSpec = { method: 'GET', api: 'v2', path: 'pages/42', idempotent: true };
const CREATE_PAGE: ConfluenceRequestSpec = {
  method: 'POST',
  api: 'v2',
  path: 'pages',
  body: { title: 'Safeguarding Policy' },
  idempotent: false,
};

// ── the happy path and the URL ─────────────────────────────────────────────

test('a successful GET returns the parsed JSON body and the status', async () => {
  const h = harness([jsonStep(200, { id: '42', title: 'Safeguarding Policy' })]);

  const result = await h.request(GET_PAGE);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: '42', title: 'Safeguarding Policy' });
  assert.equal(h.calls.length, 1);
});

test('v2 and v1 requests address the two documented base paths', async () => {
  const v2 = harness([jsonStep(200, {})]);
  await v2.request(GET_PAGE);
  assert.equal(v2.calls[0].url, `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/42`);

  const v1 = harness([jsonStep(200, {})]);
  await v1.request({ method: 'GET', api: 'v1', path: 'content/42/child/attachment', idempotent: true });
  assert.equal(
    v1.calls[0].url,
    `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/rest/api/content/42/child/attachment`,
  );
});

test('query parameters are encoded rather than interpolated', async () => {
  const h = harness([jsonStep(200, {})]);

  await h.request({ ...GET_PAGE, query: { title: 'POL - Data & Privacy', limit: '25' } });

  const url = new URL(h.calls[0].url);
  assert.equal(url.searchParams.get('title'), 'POL - Data & Privacy');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.pathname, `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/42`);
});

test('the bearer token is sent, and is taken fresh from the provider on every request', async () => {
  const h = harness([jsonStep(200, {}), jsonStep(200, {})]);

  await h.request(GET_PAGE);
  await h.request(GET_PAGE);

  assert.equal(headerOf(h.calls[0], 'Authorization'), `Bearer ${ACCESS_TOKEN}`);
  assert.equal(headerOf(h.calls[1], 'Authorization'), `Bearer ${ACCESS_TOKEN}`);
  assert.equal(h.tokenCalls(), 2, 'the token provider must be consulted per request, not once per client');
});

test('a retry re-consults the token provider, because a backoff can outlive a token', async () => {
  const h = harness([jsonStep(429, {}, { 'Retry-After': '2' }), jsonStep(200, { id: '42' })]);

  await h.request(GET_PAGE);

  assert.equal(h.calls.length, 2);
  assert.equal(h.tokenCalls(), 2);
});

test('a JSON body is serialised and typed; a FormData body is handed to fetch untouched', async () => {
  const jsonH = harness([jsonStep(200, {})]);
  await jsonH.request(CREATE_PAGE);
  assert.equal(headerOf(jsonH.calls[0], 'Content-Type'), 'application/json');
  assert.equal(jsonH.calls[0].init?.body, JSON.stringify({ title: 'Safeguarding Policy' }));

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'minutes.pdf');
  const formH = harness([jsonStep(200, {})]);
  await formH.request({
    method: 'POST',
    api: 'v1',
    path: 'content/42/child/attachment',
    formData: form,
    headers: { 'X-Atlassian-Token': 'nocheck' },
    idempotent: false,
  });
  assert.equal(formH.calls[0].init?.body, form);
  assert.equal(headerOf(formH.calls[0], 'Content-Type'), null, 'fetch must set the multipart boundary itself');
  assert.equal(headerOf(formH.calls[0], 'X-Atlassian-Token'), 'nocheck');
});

test('a caller-supplied Authorization header is refused, in any casing, before any fetch', async () => {
  // Header names are case-insensitive, so writing `Authorization` last into a
  // plain object does not make it the only one: `authorization` produced a
  // header set carrying BOTH, and the request went out with two bearer values.
  // Refusing the spec is the only form of this invariant that actually holds.
  for (const name of ['Authorization', 'authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
    const h = harness([jsonStep(200, {})]);
    const err = await captureError(h.request({ ...GET_PAGE, headers: { [name]: 'Bearer attacker-supplied' } }));
    assert.equal(err.code, 'CONFLUENCE_REQUEST_SPEC_INVALID', `expected ${name} to be refused`);
    assert.equal(h.calls.length, 0);
  }

  // And the client's own header is still the one that goes out.
  const ok = harness([jsonStep(200, {})]);
  await ok.request({ ...GET_PAGE, headers: { 'X-Atlassian-Token': 'nocheck' } });
  assert.deepEqual(
    Object.keys((ok.calls[0].init?.headers as Record<string, string>) ?? {}).filter(
      (key) => key.toLowerCase() === 'authorization',
    ),
    ['Authorization'],
    'exactly one Authorization header, whatever its casing',
  );
  assert.equal(headerOf(ok.calls[0], 'Authorization'), `Bearer ${ACCESS_TOKEN}`);
});

test('a caller-supplied Content-Type is refused when the request carries a body', async () => {
  for (const name of ['Content-Type', 'content-type']) {
    const h = harness([jsonStep(200, {})]);
    const err = await captureError(h.request({ ...CREATE_PAGE, headers: { [name]: 'text/plain' } }));
    assert.equal(err.code, 'CONFLUENCE_REQUEST_SPEC_INVALID', `expected ${name} to be refused`);
    assert.equal(h.calls.length, 0);
  }

  // A FormData upload is the case that matters: a Content-Type written by a
  // caller would be missing the multipart boundary.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1])]), 'minutes.pdf');
  const upload = harness([jsonStep(200, {})]);
  const err = await captureError(
    upload.request({
      method: 'POST',
      api: 'v1',
      path: 'content/42/child/attachment',
      formData: form,
      headers: { 'content-type': 'multipart/form-data' },
      idempotent: false,
    }),
  );
  assert.equal(err.code, 'CONFLUENCE_REQUEST_SPEC_INVALID');
  assert.equal(upload.calls.length, 0);

  // Without a body it is harmless, and is passed through.
  const noBody = harness([jsonStep(200, {})]);
  await noBody.request({ ...GET_PAGE, headers: { 'Content-Type': 'application/json' } });
  assert.equal(noBody.calls.length, 1);
});

test('the idempotent flag is trusted only when it is exactly true', async () => {
  // TypeScript forbids this, but the flag is the whole distance between a
  // charity and a duplicated policy, and untyped JSON reaches services.
  const truthy = 'false' as unknown as boolean;
  const h = harness([jsonStep(429, {}, { 'Retry-After': '1' })]);

  const err = await captureError(h.request({ ...CREATE_PAGE, idempotent: truthy }));

  assert.equal(h.calls.length, 1, 'a truthy non-true flag must not buy a retry');
  assert.equal(err.code, 'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY');
});

test('a redirect is refused rather than silently re-issuing the method and body', async () => {
  const h = harness([jsonStep(200, {})]);

  await h.request(CREATE_PAGE);

  assert.equal(h.calls[0].init?.redirect, 'error');
});

test('a 204 yields an undefined body rather than a parse failure', async () => {
  const h = harness([emptyStep(204)]);

  const result = await h.request({ method: 'DELETE', api: 'v2', path: 'pages/42', idempotent: true });

  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
});

// ── the retry policy: the point of this module ─────────────────────────────

test('a 429 with Retry-After: 2 on an idempotent request sleeps two seconds and retries', async () => {
  const h = harness([jsonStep(429, { message: 'slow down' }, { 'Retry-After': '2' }), jsonStep(200, { id: '42' })]);

  const result = await h.request(GET_PAGE);

  assert.deepEqual(result.body, { id: '42' });
  assert.equal(h.calls.length, 2, 'the request must be issued exactly twice');
  assert.deepEqual(h.sleeps, [2000], 'Retry-After is in seconds and must be honoured');
});

test('jitter is added on top of Retry-After, never subtracted from it', async () => {
  const h = harness([jsonStep(429, {}, { 'Retry-After': '2' }), jsonStep(200, {})], {
    deps: { random: () => 1 },
  });

  await h.request(GET_PAGE);

  assert.equal(h.sleeps.length, 1);
  assert.ok(
    h.sleeps[0] > 2000 && h.sleeps[0] <= 2000 * 1.5,
    `expected a jittered delay just above 2000ms, got ${h.sleeps[0]}`,
  );
});

test('a Retry-After given as an HTTP date is resolved against the injected clock', async () => {
  const nowMs = Date.parse('2026-09-18T12:00:00.000Z');
  const h = harness([jsonStep(429, {}, { 'Retry-After': 'Fri, 18 Sep 2026 12:00:07 GMT' }), jsonStep(200, {})], {
    deps: { now: () => nowMs },
  });

  await h.request(GET_PAGE);

  assert.deepEqual(h.sleeps, [7000]);
});

test('an hour-long Retry-After is clamped, not obeyed', async () => {
  const h = harness([jsonStep(429, {}, { 'Retry-After': '3600' })]);

  await captureError(h.request(GET_PAGE));

  assert.ok(h.sleeps.length > 0);
  for (const ms of h.sleeps) {
    assert.ok(ms <= 60_000, `a proxy's hour-long Retry-After must not pin a publish job: got ${ms}`);
  }
});

test('a zero or past Retry-After is floored, not taken as "retry immediately"', async () => {
  for (const header of ['0', '-5', 'Thu, 17 Sep 2026 00:00:00 GMT']) {
    const h = harness([jsonStep(429, {}, { 'Retry-After': header }), jsonStep(200, {})], {
      deps: { now: () => Date.parse('2026-09-18T12:00:00.000Z') },
    });

    await h.request(GET_PAGE);

    assert.equal(h.sleeps.length, 1, `for ${header}`);
    assert.ok(
      h.sleeps[0] >= 500,
      `a service that just said "slow down" must not be hit again immediately: got ${h.sleeps[0]} for ${header}`,
    );
  }
});

test('an absent Retry-After falls back to bounded exponential backoff', async () => {
  const h = harness([jsonStep(429, {})]);

  await captureError(h.request(GET_PAGE));

  assert.equal(h.calls.length, CONFLUENCE_MAX_ATTEMPTS);
  assert.equal(h.sleeps.length, CONFLUENCE_MAX_ATTEMPTS - 1);
  for (let i = 1; i < h.sleeps.length; i += 1) {
    assert.ok(h.sleeps[i] > h.sleeps[i - 1], 'each backoff must grow');
  }
  for (const ms of h.sleeps) {
    assert.ok(ms > 0 && ms <= 60_000, `backoff must stay bounded, got ${ms}`);
  }
});

test('a 429 on a NON-idempotent request throws CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY without a second fetch', async () => {
  const h = harness([jsonStep(429, {}, { 'Retry-After': '2' })]);

  const err = await captureError(h.request(CREATE_PAGE));

  assert.equal(err.code, 'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY');
  assert.equal(h.calls.length, 1, 'a page create must never be issued twice');
  assert.deepEqual(h.sleeps, [], 'nothing should have been waited for');
  // The caller needs to be able to schedule its own retry.
  assert.equal((err.details as { retryAfterSeconds?: number }).retryAfterSeconds, 2);
  assert.match(err.message, /not retried|duplicate/i);
});

test('a 500 retries on an idempotent request and does not on a non-idempotent one', async () => {
  const idempotent = harness([jsonStep(500, { message: 'boom' }), jsonStep(200, { id: '42' })]);
  const ok = await idempotent.request(GET_PAGE);
  assert.deepEqual(ok.body, { id: '42' });
  assert.equal(idempotent.calls.length, 2);

  const nonIdempotent = harness([jsonStep(500, { message: 'boom' })]);
  const err = await captureError(nonIdempotent.request(CREATE_PAGE));
  assert.equal(nonIdempotent.calls.length, 1, 'a page create must never be issued twice');
  // A 5xx arrives after Confluence has seen the request: it may or may not
  // have committed the write, which is precisely the indeterminate case.
  assert.equal(err.code, 'CONFLUENCE_REQUEST_INDETERMINATE');
});

test('a 400 is never retried, on either kind of request', async () => {
  const idempotent = harness([jsonStep(400, { errors: [{ title: 'Invalid CQL' }] })]);
  const err = await captureError(idempotent.request(GET_PAGE));
  assert.equal(idempotent.calls.length, 1);
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, 'CONFLUENCE_REQUEST_FAILED');
  assert.deepEqual(idempotent.sleeps, []);

  const nonIdempotent = harness([jsonStep(400, {})]);
  await captureError(nonIdempotent.request(CREATE_PAGE));
  assert.equal(nonIdempotent.calls.length, 1);
});

test('attempts are capped at five for a persistent 429', async () => {
  const h = harness([jsonStep(429, {}, { 'Retry-After': '1' })]);

  const err = await captureError(h.request(GET_PAGE));

  assert.equal(h.calls.length, 5);
  assert.equal(CONFLUENCE_MAX_ATTEMPTS, 5, 'Atlassian documents one attempt plus four retries');
  assert.equal(h.sleeps.length, 4);
  assert.equal(err.code, 'CONFLUENCE_RATE_LIMITED');
  assert.equal(err.statusCode, 429);
});

test('attempts are capped at five for a persistent 500', async () => {
  const h = harness([jsonStep(500, {})]);

  const err = await captureError(h.request(GET_PAGE));

  assert.equal(h.calls.length, CONFLUENCE_MAX_ATTEMPTS);
  assert.equal(err.code, 'CONFLUENCE_REQUEST_FAILED');
  assert.equal(err.statusCode, 502);
});

test('a whole request is bounded, not just each attempt', async () => {
  // Five attempts at 30s plus four clamped 60s backoffs is ~390s, which is
  // worse than the undici default the per-attempt deadline exists to beat. The
  // budget is checked before sleeping, so an in-flight attempt is never
  // abandoned part-way.
  let clock = Date.parse('2026-09-18T12:00:00.000Z');
  const started = clock;
  const h = harness([jsonStep(429, {}, { 'Retry-After': '60' })], {
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  });

  const err = await captureError(h.request(GET_PAGE));

  assert.ok(h.calls.length < CONFLUENCE_MAX_ATTEMPTS, `expected to stop before the attempt cap, made ${h.calls.length}`);
  assert.ok(
    clock - started <= CONFLUENCE_TOTAL_DEADLINE_MS,
    `the whole call must stay inside the budget: waited ${clock - started}ms`,
  );
  assert.equal(err.code, 'CONFLUENCE_RATE_LIMITED');

  // And the budget is generous enough that an ordinary retry is unaffected.
  assert.ok(CONFLUENCE_TOTAL_DEADLINE_MS >= CONFLUENCE_REQUEST_TIMEOUT_MS * 2);
});

test('a transport failure on a NON-idempotent request throws CONFLUENCE_REQUEST_INDETERMINATE', async () => {
  const h = harness([throwStep(new TypeError('fetch failed'))]);

  const err = await captureError(h.request(CREATE_PAGE));

  assert.equal(err.code, 'CONFLUENCE_REQUEST_INDETERMINATE');
  assert.equal(h.calls.length, 1, 'a dropped connection may mean the write landed; it must not be repeated');
  assert.match(err.message, /may or may not/i);
});

test('a transport failure on an idempotent request retries, then reports unreachable', async () => {
  const recovering = harness([throwStep(new TypeError('fetch failed')), jsonStep(200, { id: '42' })]);
  await recovering.request(GET_PAGE);
  assert.equal(recovering.calls.length, 2);

  const persistent = harness([throwStep(new TypeError('fetch failed'))]);
  const err = await captureError(persistent.request(GET_PAGE));
  assert.equal(persistent.calls.length, CONFLUENCE_MAX_ATTEMPTS);
  assert.equal(err.code, 'CONFLUENCE_UNREACHABLE');
});

// ── the error taxonomy ─────────────────────────────────────────────────────

test('a 401 or 403 is reported as needing a reconnect, not as an unauthorised CharityPilot session', async () => {
  for (const status of [401, 403]) {
    const h = harness([jsonStep(status, { message: 'Unauthorized' })]);
    const err = await captureError(h.request(GET_PAGE));
    assert.equal(err.code, 'CONFLUENCE_RECONNECT_REQUIRED');
    assert.notEqual(err.statusCode, 401, "apps/web's interceptors treat a 401 as an expired CharityPilot session");
    assert.notEqual(err.statusCode, 403);
    assert.equal(h.calls.length, 1);
  }
});

test('a 404 and a 409 carry distinct codes and the upstream status, for callers that must branch', async () => {
  const missing = harness([jsonStep(404, { errors: [{ title: 'Not Found' }] })]);
  const notFound = await captureError(missing.request(GET_PAGE));
  assert.equal(notFound.code, 'CONFLUENCE_NOT_FOUND');
  assert.equal((notFound.details as { status?: number }).status, 404);

  const conflicting = harness([jsonStep(409, { errors: [{ title: 'Version mismatch' }] })]);
  const conflict = await captureError(
    conflicting.request({ method: 'PUT', api: 'v2', path: 'pages/42', body: {}, idempotent: true }),
  );
  assert.equal(conflict.code, 'CONFLUENCE_CONFLICT');
  assert.equal((conflict.details as { status?: number }).status, 409);
  assert.equal(conflicting.calls.length, 1, 'a version conflict fails identically forever');
});

test('a malformed success body is reported rather than returned as undefined', async () => {
  const h = harness([
    async () =>
      new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]);

  const err = await captureError(h.request(GET_PAGE));

  assert.equal(err.code, 'CONFLUENCE_RESPONSE_INVALID');
});

// ── the 2xx whose body was lost: the write DID land ────────────────────────

test('an unreadable 2xx on a write says the change was applied and the identifier was lost', async () => {
  // The status line was already 2xx when the body failed, so Confluence did
  // not merely see the request — it committed it. A caller told "the response
  // could not be read" would create the page again.
  const cases: Array<{ name: string; step: Step }> = [
    {
      name: 'a truncated JSON body',
      step: async () =>
        new Response('{"id":"42","tit', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    },
    {
      name: 'an HTML error page behind a 201',
      step: async () =>
        new Response('<html>gateway</html>', { status: 201, headers: { 'Content-Type': 'text/html' } }),
    },
    {
      name: 'an empty body',
      step: async () => new Response('', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    },
    {
      name: 'a body that cannot be read at all',
      step: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('connection reset mid-body'));
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    },
  ];

  for (const { name, step } of cases) {
    const h = harness([step]);
    const err = await captureError(h.request(CREATE_PAGE));

    assert.equal(err.code, 'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE', `for ${name}`);
    assert.equal((err.details as { status?: number }).status, 201, `for ${name}`);
    assert.match(err.message, /WAS applied/, `for ${name}`);
    assert.match(err.message, /Do not reissue/i, `for ${name}`);
    assert.equal(h.calls.length, 1, `for ${name}`);
  }
});

test('the same unreadable 2xx on a read is only a broken response', async () => {
  const nonJson = harness([async () => new Response('<html/>', { status: 200, headers: { 'Content-Type': 'text/html' } })]);
  const result = await nonJson.request(GET_PAGE);
  assert.deepEqual(result, { status: 200, body: undefined });

  const broken = harness([
    async () => new Response('{"id":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]);
  const err = await captureError(broken.request(GET_PAGE));
  assert.equal(err.code, 'CONFLUENCE_RESPONSE_INVALID');
});

test('a 204 on a write is a success with nothing to return, not a lost identifier', async () => {
  const h = harness([emptyStep(204)]);

  const result = await h.request({ method: 'DELETE', api: 'v2', path: 'pages/42', idempotent: false });

  assert.deepEqual(result, { status: 204, body: undefined });
});

test('the real deadline firing mid-body on a write reports the write as applied', async () => {
  // Not a harness case: a real AbortSignal, aborting while the body streams.
  const calls: FetchCall[] = [];
  const client = createConfluenceClient(
    { cloudId: CLOUD_ID, getAccessToken: async () => ACCESS_TOKEN },
    {
      timeoutMs: 20,
      sleep: async () => {},
      fetch: ((input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"42"'));
            const keepAlive = setTimeout(() => controller.error(new Error('the deadline never fired')), 1_000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(keepAlive);
              controller.error(new Error('aborted mid-body'));
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 201, headers: { 'Content-Type': 'application/json' } }),
        );
      }) as unknown as typeof globalThis.fetch,
    },
  );

  const err = await captureError(client.request(CREATE_PAGE));

  assert.equal(err.code, 'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE');
  assert.equal(calls.length, 1);
});

// ── secret containment ─────────────────────────────────────────────────────

test('the access token never reaches a thrown error, whatever the failure was', async () => {
  const transport = harness([
    throwStep(new TypeError(`fetch failed for Bearer ${ACCESS_TOKEN}`, { cause: new Error(ACCESS_TOKEN) })),
  ]);
  assertNoTokenLeak(await captureError(transport.request(CREATE_PAGE)));

  const transportIdempotent = harness([throwStep(new Error(ACCESS_TOKEN))]);
  assertNoTokenLeak(await captureError(transportIdempotent.request(GET_PAGE)));

  // A body that echoes the request back is not something Confluence does, but
  // the containment rule does not depend on Atlassian's good behaviour.
  const echoed = harness([
    jsonStep(400, {
      errors: [{ title: `Bad request for token ${ACCESS_TOKEN}`, detail: ACCESS_TOKEN }],
      request: { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
    }),
  ]);
  assertNoTokenLeak(await captureError(echoed.request(GET_PAGE)));

  const rateLimited = harness([jsonStep(429, { message: ACCESS_TOKEN }, { 'Retry-After': '2' })]);
  assertNoTokenLeak(await captureError(rateLimited.request(CREATE_PAGE)));
});

test('an upstream error surfaces only the documented fields, never the raw body', async () => {
  const h = harness([
    jsonStep(400, {
      errors: [{ status: 400, code: 'INVALID_REQUEST_PARAMETER', title: 'Space id is required' }],
      internalDiagnostics: 'a field we never asked for',
    }),
  ]);

  const err = await captureError(h.request(GET_PAGE));

  assert.match(err.message, /Space id is required/);
  assert.equal(JSON.stringify(err.details).includes('internalDiagnostics'), false);
  assert.equal(err.message.includes('internalDiagnostics'), false);
});

test('an upstream body with neither errors[] nor message surfaces none of it', async () => {
  // The fall-through the v2 test above never reaches: its fixture carries
  // `errors[0].title`, so the v2 branch fires and the rest is never read.
  //
  // This is the shape a proxy in front of Confluence produces, and it is the
  // recurrence guard for the Caddy leak an earlier phase found — a gateway
  // that reflected the request, authorization code and all, into an error
  // body. Nothing off a body we do not recognise is ours to surface.
  const h = harness([
    jsonStep(403, {
      statusCode: 403,
      reason: 'Forbidden by upstream policy',
      echoedRequest: {
        authorizationCode: 'atl-authz-code-HHHH',
        body: '<p>Trustee: Maire Ni Bhriain, PPSN on file</p>',
      },
    }),
  ]);

  const err = await captureError(h.request(GET_PAGE));

  const surfaced = `${err.message} ${JSON.stringify(err.details ?? null)} ${JSON.stringify(err.cause ?? null)}`;
  for (const undocumented of [
    'Forbidden by upstream policy',
    'echoedRequest',
    'atl-authz-code-HHHH',
    'Maire Ni Bhriain',
    'reason',
  ]) {
    assert.equal(surfaced.includes(undocumented), false, `"${undocumented}" must not be surfaced`);
  }
  // And with nothing documented to say, the message carries no detail at all
  // rather than a best effort at one.
  assert.equal(
    err.message,
    'Confluence request failed with status 403. The charity must reconnect its Confluence site.',
  );
});

test('a v1 error body is read through its own documented field, and only that field', async () => {
  // v1 is not a legacy corner: `uploadAttachment` is the only v1 caller, and
  // it is the call that carries a charity's signed policy file. Its error
  // shape is `{ statusCode, message }` — nothing else on the body may travel.
  const h = harness([jsonStep(404, { statusCode: 404, message: 'No attachment container found' })]);

  const err = await captureError(
    h.request({ method: 'POST', api: 'v1', path: 'content/42/child/attachment', idempotent: false }),
  );

  assert.equal(err.code, 'CONFLUENCE_NOT_FOUND');
  assert.match(err.message, /No attachment container found/);
  assert.equal(err.message.includes('statusCode'), false, 'the envelope around the message is not the message');
  assert.equal(err.message.includes('{'), false, 'no part of the raw body may be serialised into the message');
});

test('upstream error text reaching a message is bounded at 200 characters', async () => {
  // The bound is the second half of the containment rule the two tests above
  // pin: what may be surfaced, and how much of it. An upstream body is
  // untrusted and unbounded, and the message it lands in reaches both an
  // AppError and the request logger.
  const tail = 'THE-TAIL-THAT-MUST-NOT-TRAVEL';
  const title = `${'x'.repeat(400)}${tail}`;
  const h = harness([jsonStep(400, { errors: [{ status: 400, code: 'BAD', title }] })]);

  const err = await captureError(h.request(GET_PAGE));

  assert.equal(err.message.includes(tail), false, 'the far end of an oversized body must be dropped');
  assert.match(err.message, /x{200}\.\.\./);
  assert.equal(err.message.includes('x'.repeat(201)), false, 'at most 200 characters of upstream text');
});

// ── the cloudId and the path are data ──────────────────────────────────────

test('a cloudId that could escape the path is rejected when the client is built', async () => {
  const nul = String.fromCharCode(0);
  const escapes = ['../../oauth/token', 'abc/def', '', 'abc?x=1', 'abc#y', 'a b', `abc${nul}def`, 'a'.repeat(200)];
  for (const cloudId of escapes) {
    const err = await captureError(
      (async () => createConfluenceClient({ cloudId, getAccessToken: async () => ACCESS_TOKEN }))(),
    );
    assert.equal(err.code, 'CONFLUENCE_CLOUD_ID_INVALID', `expected ${JSON.stringify(cloudId)} to be rejected`);
  }

  // The real shape Atlassian issues still works.
  assert.doesNotThrow(() => createConfluenceClient({ cloudId: CLOUD_ID, getAccessToken: async () => ACCESS_TOKEN }));
});

test('a request path that could escape the API prefix is rejected before any fetch', async () => {
  const traversals = ['/pages', '../../../oauth/token', 'pages/../../x', 'pages?limit=1', 'pages#x', '', 'pages/%2e%2e/x'];
  for (const path of traversals) {
    const h = harness([jsonStep(200, {})]);
    const err = await captureError(h.request({ ...GET_PAGE, path }));
    assert.equal(err.code, 'CONFLUENCE_REQUEST_PATH_INVALID', `expected ${JSON.stringify(path)} to be rejected`);
    assert.equal(h.calls.length, 0);
  }
});

test('a request path carrying a control character is rejected before any fetch', async () => {
  // The sibling guards (`..`, `%`, `?#\`, the cloud-id pattern) are each
  // pinned by a named test; this one was not. It matters for the same reason
  // they do: a path here is built from ids that arrived from Atlassian or from
  // a caller, and a control character in one is not something we will send and
  // find out what happens to. Written as code points so no literal control
  // character appears in this file's source, matching the guard itself.
  const controls = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f];
  for (const code of controls) {
    const h = harness([jsonStep(200, {})]);
    const path = `pages/4${String.fromCharCode(code)}2`;
    const err = await captureError(h.request({ ...GET_PAGE, path }));
    assert.equal(
      err.code,
      'CONFLUENCE_REQUEST_PATH_INVALID',
      `expected U+${code.toString(16).padStart(4, '0').toUpperCase()} to be rejected`,
    );
    assert.equal(h.calls.length, 0, 'a rejected path must not reach the network');
  }
});

test('a spec carrying both a JSON body and FormData is rejected before any fetch', async () => {
  const h = harness([jsonStep(200, {})]);

  const err = await captureError(h.request({ ...CREATE_PAGE, formData: new FormData() }));

  assert.equal(err.code, 'CONFLUENCE_REQUEST_SPEC_INVALID');
  assert.equal(h.calls.length, 0);
});

// ── the deadline ───────────────────────────────────────────────────────────

test('every request is bound by an abort signal', async () => {
  const h = harness([jsonStep(200, {})]);

  await h.request(GET_PAGE);

  const signal = h.calls[0].init?.signal;
  assert.ok(signal instanceof AbortSignal, 'fetch must be given a deadline signal');
});

test('a client built with no timeout passes the production constant to the signal it actually uses', async () => {
  // Pinning `resolveRequestTimeoutMs({})` pins the FUNCTION. It does not pin
  // the JOIN: a call site hardcoded to 600000 left every other test green
  // while the resolver kept returning 30s. This observes the number the call
  // site really passes, from a client given no timeout at all.
  const observed: number[] = [];
  const client = createConfluenceClient(
    { cloudId: CLOUD_ID, getAccessToken: async () => ACCESS_TOKEN },
    {
      fetch: (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as
        unknown as typeof globalThis.fetch,
      createSignal: (ms: number) => {
        observed.push(ms);
        return AbortSignal.timeout(ms);
      },
    },
  );

  await client.request(GET_PAGE);

  assert.deepEqual(observed, [CONFLUENCE_REQUEST_TIMEOUT_MS]);
});

test('the production deadline default is the constant, not whatever a test injected', () => {
  // The deadline test below injects five milliseconds, so a hardcoded default
  // at the call site would leave the whole suite green while production kept
  // undici's ~600s. This pins the join between the constant and the code.
  assert.equal(resolveRequestTimeoutMs({}), CONFLUENCE_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs({ timeoutMs: 5 }), 5);

  // Generous for a single Confluence call, and two orders of magnitude inside
  // undici's ~600s headers+body default, which is the thing it exists to beat.
  assert.ok(CONFLUENCE_REQUEST_TIMEOUT_MS >= 5_000, 'a slow-but-working Confluence must not be cut off');
  assert.ok(CONFLUENCE_REQUEST_TIMEOUT_MS <= 60_000, 'no caller expects to wait a minute');
});

test('a fetch that never answers is abandoned at the deadline, and is indeterminate when unsafe to repeat', async () => {
  const calls: FetchCall[] = [];
  const client = createConfluenceClient(
    { cloudId: CLOUD_ID, getAccessToken: async () => ACCESS_TOKEN },
    {
      timeoutMs: 5,
      sleep: async () => {},
      // A request that hangs forever, exactly as undici can. `AbortSignal
      // .timeout`'s own timer is unref'd, so the test needs a ref'd one to
      // hold the event loop open — and it doubles as the assertion that the
      // deadline fires at all.
      fetch: ((input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Promise<Response>((_resolve, reject) => {
          const keepAlive = setTimeout(() => reject(new Error('the deadline never fired')), 1_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(new Error('request aborted by deadline'));
          });
        });
      }) as unknown as typeof globalThis.fetch,
    },
  );

  const err = await captureError(client.request(CREATE_PAGE));

  assert.equal(err.code, 'CONFLUENCE_REQUEST_INDETERMINATE');
  assert.equal(calls.length, 1);
});
