import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
});

test('DPO dashboard routes redirect a visitor before rendering and use protected no-store headers', async () => {
  Object.assign(process.env, { NODE_ENV: 'production' });
  for (const pathname of ['/governance-audit', '/security-data', '/data-lifecycle']) {
    const response = await proxy(new NextRequest(`https://app.charitypilot.ie${pathname}`));
    assert.equal(response.status, 307, pathname);
    assert.equal(new URL(response.headers.get('location')!).pathname, '/login', pathname);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/, pathname);
  }
});

test('expired protected page requests hand renewal to the browser without spending a refresh token', async () => {
  Object.assign(process.env, { NODE_ENV: 'production' });
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input.toString());
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const request = () => new NextRequest(
    'https://app.charitypilot.ie/documents?view=board&code=hidden-code&state=hidden-state',
    { headers: { cookie: 'charitypilot_access=expired; charitypilot_refresh=valid-refresh' } },
  );
  const responses = await Promise.all([proxy(request()), proxy(request())]);
  for (const response of responses) {
    assert.equal(response.status, 307);
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.pathname, '/session-renew');
    assert.equal(location.searchParams.get('next'), '/documents?view=board');
    assert.doesNotMatch(response.headers.get('location') ?? '', /hidden-code|hidden-state/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call === 'https://api.charitypilot.ie/api/v1/auth/me'));
});

test('a rejected protected page without a refresh cookie still goes to login', async () => {
  Object.assign(process.env, { NODE_ENV: 'production' });
  process.env.NEXT_PUBLIC_API_URL = 'https://api.charitypilot.ie';
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  const response = await proxy(new NextRequest('https://app.charitypilot.ie/dashboard', {
    headers: { cookie: 'charitypilot_access=expired' },
  }));
  assert.equal(new URL(response.headers.get('location') ?? '').pathname, '/login');
});

test('the public session-renew page has sensitive no-store headers', async () => {
  Object.assign(process.env, { NODE_ENV: 'production' });
  const response = await proxy(new NextRequest('https://app.charitypilot.ie/session-renew?next=%2Fdashboard'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test("parallel protected route checks share only an in-flight auth validation", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  let finishValidation: ((response: Response) => void) | undefined;
  const pendingValidation = new Promise<Response>((resolve) => {
    finishValidation = resolve;
  });
  let validationCalls = 0;
  globalThis.fetch = (async () => {
    validationCalls += 1;
    return validationCalls === 1
      ? pendingValidation
      : new Response(null, { status: 401 });
  }) as typeof fetch;

  const request = () => new NextRequest("https://app.charitypilot.ie/dashboard", {
    headers: { cookie: "charitypilot_access=valid-access" },
  });
  const first = proxy(request());
  const second = proxy(request());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(validationCalls, 1);
  const otherCredential = await proxy(new NextRequest("https://app.charitypilot.ie/dashboard", {
    headers: { cookie: "charitypilot_access=other-access" },
  }));
  assert.equal(otherCredential.status, 307, "a second account must never borrow the pending success");
  assert.equal(validationCalls, 2);
  finishValidation?.(new Response(null, { status: 200 }));

  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(validationCalls, 2);

  // A completed success is not cached: revocation is checked on the next request.
  const later = await proxy(request());
  assert.equal(later.status, 307);
  assert.equal(validationCalls, 3);
});

test("non-401 auth validation failures fail closed without a false login redirect or refresh storm", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  for (const failure of [
    400,
    403,
    404,
    302,
    429,
    500,
    "network",
    "abort",
  ] as const) {
    const fetchCalls: Array<{
      url: string;
      signal: AbortSignal | null | undefined;
    }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCalls.push({ url: input.toString(), signal: init?.signal });
      if (failure === "network") throw new TypeError("network unavailable");
      if (failure === "abort")
        throw new DOMException("request timed out", "AbortError");
      return new Response(null, {
        status: failure,
        headers: failure === 429 ? { "Retry-After": "17" } : undefined,
      });
    }) as typeof fetch;

    const response = await proxy(
      new NextRequest("https://app.charitypilot.ie/compliance", {
        headers: {
          cookie:
            "charitypilot_access=valid-access; charitypilot_refresh=valid-refresh",
        },
      }),
    );

    assert.equal(response.status, 503, String(failure));
    assert.equal(response.headers.get("location"), null, String(failure));
    assert.equal(
      response.headers.get("retry-after"),
      failure === 429 ? "17" : "5",
      String(failure),
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate",
    );
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      await response.text(),
      "Authentication service temporarily unavailable",
    );
    assert.deepEqual(
      fetchCalls.map(({ url }) => url),
      ["https://api.charitypilot.ie/api/v1/auth/me"],
    );
    assert.ok(
      fetchCalls[0]?.signal instanceof AbortSignal,
      `expected bounded fetch for ${failure}`,
    );
  }
});

test("only the exact auth/me 200 contract authenticates a protected request", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  for (const upstreamStatus of [201, 202, 204, 206, 299]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: upstreamStatus });
    }) as typeof fetch;

    const response = await proxy(
      new NextRequest("https://app.charitypilot.ie/dashboard", {
        headers: { cookie: "charitypilot_access=present" },
      }),
    );

    assert.equal(response.status, 503, String(upstreamStatus));
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(calls, 1);
  }
});

test("invalid or excessive auth Retry-After values fall back to a bounded delay", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  let retryAfter = "not-a-number";
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 429,
      headers: { "Retry-After": retryAfter },
    })) as typeof fetch;

  const request = () =>
    new NextRequest("https://app.charitypilot.ie/compliance", {
      headers: { cookie: "charitypilot_access=valid-access" },
    });

  assert.equal((await proxy(request())).headers.get("retry-after"), "5");
  retryAfter = "301";
  assert.equal((await proxy(request())).headers.get("retry-after"), "5");
});

test("local Docker server-side protected route validation uses the internal API origin", async () => {
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:3002";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3002";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("http://localhost:3003/dashboard", {
      headers: {
        cookie:
          "charitypilot_access=local-access; charitypilot_refresh=local-refresh",
      },
    }),
  );

  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(fetchCalls, ["http://api:3002/api/v1/auth/me"]);
  assert.match(
    response.headers.get("Content-Security-Policy") ?? "",
    /connect-src[^;]*http:\/\/localhost:3002/,
  );
});

test("isolated production browser CSP and server auth validation use their distinct exact API origins", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE = "local-disposable";
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3302";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3302";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("http://127.0.0.1:3303/dashboard", {
      headers: {
        host: "127.0.0.1:3303",
        cookie:
          "charitypilot_access=isolated-access; charitypilot_refresh=isolated-refresh",
      },
    }),
  );

  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(fetchCalls, ["http://api:3302/api/v1/auth/me"]);
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3302(?:;|$)/);
  assert.doesNotMatch(
    csp,
    /localhost:|ws:\/\/|unsafe-eval|upgrade-insecure-requests|api\.charitypilot\.ie/,
  );
});

test("personal-server production uses Caddy's public origin and the internal Fastify service", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE = "personal-server";
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:8080";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3002";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("http://127.0.0.1:8080/dashboard", {
      headers: {
        host: "127.0.0.1:8080",
        cookie: "charitypilot_access=personal-access; charitypilot_refresh=personal-refresh",
      },
    }),
  );

  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(fetchCalls, ["http://api:3002/api/v1/auth/me"]);
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:8080(?:;|$)/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests|api\.charitypilot\.ie|unsafe-eval/);
});

test("personal-server production redirects public setup and billing entry points", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE = "personal-server";
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:8080";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3002";

  for (const [pathname, expectedPathname] of [
    ["/", "/login"],
    ["/register", "/login"],
    ["/forgot-password", "/login"],
    ["/billing", "/dashboard"],
  ] as const) {
    const response = await proxy(new NextRequest(`http://127.0.0.1:8080${pathname}`));
    assert.equal(new URL(response.headers.get("location") ?? "").pathname, expectedPathname);
  }
});

test("personal-server HTTPS renewal uses the public origin across an internal HTTP proxy hop", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE = "personal-server";
  process.env.NEXT_PUBLIC_API_URL =
    "https://charitypilot-board.example-tailnet.ts.net";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3002";

  const fetchCalls: Array<{ url: string; origin: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: input.toString(),
      origin: new Headers(init?.headers).get("Origin"),
    });
    if (input.toString().endsWith("/api/v1/auth/me")) {
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("http://web:3003/dashboard?view=board", {
      headers: {
        host: "web:3003",
        "x-forwarded-proto": "http",
        cookie:
          "charitypilot_access=expired-personal; charitypilot_refresh=personal-refresh",
      },
    }),
  );

  assert.deepEqual(fetchCalls, [
    { url: "http://api:3002/api/v1/auth/me", origin: null },
  ]);
  const redirect = new URL(response.headers.get("location") ?? "");
  assert.equal(redirect.origin, "https://charitypilot-board.example-tailnet.ts.net");
  assert.equal(redirect.pathname, "/session-renew");
  assert.equal(redirect.searchParams.get("next"), "/dashboard?view=board");
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(
    csp,
    /connect-src 'self' https:\/\/charitypilot-board\.example-tailnet\.ts\.net(?:;|$)/,
  );
  assert.doesNotMatch(csp, /http:\/\/web:3003/);

  const setupRedirect = await proxy(
    new NextRequest("http://web:3003/register", {
      headers: { host: "web:3003", "x-forwarded-proto": "http" },
    }),
  );
  assert.equal(
    setupRedirect.headers.get("location"),
    "https://charitypilot-board.example-tailnet.ts.net/login",
  );
});

test("a lookalike isolated marker cannot enable loopback production API access", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE = "local-disposable-lookalike";
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3302";
  process.env.CHARITYPILOT_INTERNAL_API_URL = "http://api:3302";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("http://127.0.0.1:3303/dashboard", {
      headers: {
        host: "127.0.0.1:3303",
        cookie:
          "charitypilot_access=isolated-access; charitypilot_refresh=isolated-refresh",
      },
    }),
  );

  assert.deepEqual(fetchCalls, []);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(
    csp,
    /connect-src 'self' https:\/\/api\.charitypilot\.ie(?:;|$)/,
  );
  assert.doesNotMatch(csp, /connect-src[^;]*127\.0\.0\.1:3302/);
});

test("server-side protected route validation fails closed for unapproved production API origins", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.attacker.example";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("https://app.charitypilot.ie/dashboard", {
      headers: {
        cookie:
          "charitypilot_access=sensitive-access; charitypilot_refresh=sensitive-refresh",
      },
    }),
  );

  assert.deepEqual(fetchCalls, []);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
});

// ── The OAuth callback's live authorization code must not reach a redirect ──
//
// `/integrations` is a protected prefix, so before these tests the callback
// page sat behind this middleware and a dead session answered
//   307 Location: /login?next=%2F…%3Fcode%3D<live code>%26state%3D<state>
// putting an UNSPENT, single-use authorization code into the Location header,
// the address bar, the history entry for /login, the Referer of /login's
// subresources, and the proxy access log — Caddy's `delete code` filter only
// deletes TOP-LEVEL parameters, and this one is nested inside `next`.
//
// It is also self-defeating: renewing the session is precisely what that page
// does for itself.

const LIVE_CODE = "LIVE-AUTHORIZATION-CODE";
const LIVE_STATE = "LIVE-OAUTH-STATE";

/**
 * Everything a client or a proxy could read off the response — the status and
 * every header, `Set-Cookie` included. A leak into any one of them is the
 * failure these tests exist to catch, so they assert against this rather than
 * against `location` alone.
 */
function everythingOnTheWire(response: Response): string {
  const parts: string[] = [`STATUS ${response.status}`];
  response.headers.forEach((value, key) => parts.push(`${key}: ${value}`));
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    parts.push(`set-cookie: ${cookie}`);
  }
  return parts.join("\n");
}

function callbackRequest(cookie?: string): NextRequest {
  return new NextRequest(
    `https://app.charitypilot.ie/integrations/confluence/callback?code=${LIVE_CODE}&state=${LIVE_STATE}`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

test("the Confluence callback is never bounced to /login when no session cookie is present", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const response = await proxy(callbackRequest());

  assert.equal(response.headers.get("location"), null);
  assert.notEqual(response.status, 307);
  // The page renews the session itself, so it has to actually be reached.
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate",
  );
  assert.deepEqual(fetchCalls, []);

  const wire = everythingOnTheWire(response);
  assert.equal(
    wire.includes(LIVE_CODE),
    false,
    `the live authorization code must appear nowhere in the response:\n${wire}`,
  );
  assert.equal(wire.includes(LIVE_STATE), false, wire);
  assert.equal(wire.includes("/login"), false, wire);
});

test("the Confluence callback reaches its own renewal logic without server refresh", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input.toString());
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const response = await proxy(
    callbackRequest(
      "charitypilot_access=expired-access; charitypilot_refresh=revoked-refresh",
    ),
  );

  assert.equal(response.headers.get("location"), null);
  assert.notEqual(response.status, 307);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['https://api.charitypilot.ie/api/v1/auth/me']);
  assert.equal(response.headers.getSetCookie().length, 0);

  const wire = everythingOnTheWire(response);
  assert.equal(
    wire.includes(LIVE_CODE),
    false,
    `the live authorization code must appear nowhere in the response:\n${wire}`,
  );
  assert.equal(wire.includes(LIVE_STATE), false, wire);
  assert.equal(wire.includes("/login"), false, wire);
});

test("a login redirect for any other protected path strips code and state out of next", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

  const response = await proxy(
    new NextRequest(
      `https://app.charitypilot.ie/documents?view=board&code=${LIVE_CODE}&state=${LIVE_STATE}`,
    ),
  );

  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/documents?view=board");

  const wire = everythingOnTheWire(response);
  assert.equal(
    wire.includes(LIVE_CODE),
    false,
    `no single-use secret may be nested inside next:\n${wire}`,
  );
  assert.equal(wire.includes(LIVE_STATE), false, wire);
});
