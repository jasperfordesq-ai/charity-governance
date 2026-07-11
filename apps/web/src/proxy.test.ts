import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function rotatedAuthCookieHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    "charitypilot_access=rotated; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  headers.append(
    "Set-Cookie",
    "charitypilot_refresh=rotated-refresh; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  return headers;
}

function deletedAuthCookieHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    "charitypilot_access=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  headers.append(
    "Set-Cookie",
    "charitypilot_refresh=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  return headers;
}

function forceCombinedSetCookieFallback(response: Response): Response {
  Object.defineProperty(response.headers, "getSetCookie", {
    configurable: true,
    value: undefined,
  });
  return response;
}

function forgedQuotedAuthCookieHeaders(mode: "rotation" | "deletion"): Headers {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    mode === "rotation"
      ? "charitypilot_access=rotated; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax"
      : "charitypilot_access=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  const refreshValue = mode === "rotation" ? "forged-refresh" : "";
  const refreshMaxAge = mode === "rotation" ? "604800" : "0";
  headers.append(
    "Set-Cookie",
    `unrelated_cookie="quoted, charitypilot_refresh=${refreshValue}; Max-Age=${refreshMaxAge}; Path=/; HttpOnly; Secure; SameSite=Lax; X="`,
  );
  return headers;
}

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

test("server-side protected route refresh sends the deployed web Origin required by the API origin guard", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: input.toString(), init });

    if (input.toString().endsWith("/api/v1/auth/me")) {
      return new Response(null, { status: 401 });
    }

    if (input.toString().endsWith("/api/v1/auth/refresh")) {
      return new Response(null, {
        status: 200,
        headers: rotatedAuthCookieHeaders(),
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("https://app.charitypilot.ie/dashboard", {
      headers: {
        cookie:
          "charitypilot_access=expired-access; charitypilot_refresh=valid-refresh",
      },
    }),
  );

  const refreshCall = fetchCalls.find((call) =>
    call.url.endsWith("/api/v1/auth/refresh"),
  );
  assert.ok(refreshCall, "expected proxy to call the refresh endpoint");
  assert.equal(
    new Headers(refreshCall.init?.headers).get("Origin"),
    "https://app.charitypilot.ie",
  );
  assert.ok(refreshCall.init?.signal instanceof AbortSignal);
  assert.ok(
    fetchCalls.find((call) => call.url.endsWith("/api/v1/auth/me"))?.init
      ?.signal instanceof AbortSignal,
  );
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /charitypilot_access=rotated/,
  );
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /charitypilot_refresh=rotated-refresh/,
  );
  assert.equal(response.headers.getSetCookie().length, 2);
});

test("non-401 auth validation failures fail closed without a false login redirect or refresh storm", async () => {
  process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = "production";
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

test("only the exact refresh 200 contract can rotate a protected session", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  let refreshStatus = 201;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    new Response(null, {
      status: input.toString().endsWith("/api/v1/auth/me")
        ? 401
        : refreshStatus,
      headers: input.toString().endsWith("/api/v1/auth/refresh")
        ? rotatedAuthCookieHeaders()
        : undefined,
    })) as typeof fetch;

  const request = () =>
    new NextRequest("https://app.charitypilot.ie/dashboard", {
      headers: {
        cookie:
          "charitypilot_access=expired; charitypilot_refresh=refresh-token",
      },
    });

  for (const upstreamStatus of [201, 202, 204, 206, 299]) {
    refreshStatus = upstreamStatus;
    const response = await proxy(request());
    assert.equal(response.status, 503, String(upstreamStatus));
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("transient or unexpected refresh failures fail closed while a 401 redirects to login", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  let refreshFailure: number | "network" | "abort" = 503;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (input.toString().endsWith("/api/v1/auth/me"))
      return new Response(null, { status: 401 });
    if (refreshFailure === "network")
      throw new TypeError("network unavailable");
    if (refreshFailure === "abort")
      throw new DOMException("request timed out", "AbortError");
    return new Response(null, {
      status: refreshFailure,
      headers: refreshFailure === 401 ? deletedAuthCookieHeaders() : undefined,
    });
  }) as typeof fetch;

  const request = () =>
    new NextRequest("https://app.charitypilot.ie/compliance", {
      headers: {
        cookie:
          "charitypilot_access=expired-access; charitypilot_refresh=refresh-token",
      },
    });

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
    refreshFailure = failure;
    const unavailable = await proxy(request());
    assert.equal(unavailable.status, 503, String(failure));
    assert.equal(unavailable.headers.get("location"), null, String(failure));
    assert.equal(
      unavailable.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate",
    );
    assert.equal(unavailable.headers.get("pragma"), "no-cache");
    assert.equal(unavailable.headers.get("set-cookie"), null);
  }

  refreshFailure = 401;
  const rejected = await proxy(request());
  assert.equal(rejected.status, 307);
  assert.equal(
    rejected.headers.get("location"),
    "https://app.charitypilot.ie/login?next=%2Fcompliance",
  );
  const deletedCookies = rejected.headers.getSetCookie();
  assert.equal(deletedCookies.length, 2);
  assert.ok(
    deletedCookies.every((cookie) =>
      /charitypilot_(?:access|refresh)=; Max-Age=0/.test(cookie),
    ),
  );
});

test("a definitive refresh 401 forwards only validated auth-cookie deletions", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const deletionHeaders = deletedAuthCookieHeaders();
  deletionHeaders.append(
    "Set-Cookie",
    "unrelated_cookie=must-not-cross-the-proxy; Max-Age=60; Path=/",
  );
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    new Response(null, {
      status: 401,
      headers: input.toString().endsWith("/api/v1/auth/refresh")
        ? deletionHeaders
        : undefined,
    })) as typeof fetch;

  const response = await proxy(
    new NextRequest("https://app.charitypilot.ie/compliance", {
      headers: {
        cookie: "charitypilot_access=expired; charitypilot_refresh=revoked",
      },
    }),
  );

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://app.charitypilot.ie/login?next=%2Fcompliance",
  );
  const forwardedCookies = response.headers.getSetCookie();
  assert.equal(forwardedCookies.length, 2);
  assert.ok(
    forwardedCookies.some((cookie) =>
      cookie.startsWith("charitypilot_access="),
    ),
  );
  assert.ok(
    forwardedCookies.some((cookie) =>
      cookie.startsWith("charitypilot_refresh="),
    ),
  );
  assert.ok(forwardedCookies.every((cookie) => /Max-Age=0/.test(cookie)));
  assert.doesNotMatch(forwardedCookies.join("\n"), /unrelated_cookie/);
});

test("malformed deletion cookies and transient responses never cross the web boundary", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const malformedCases: Array<{ status: number; headers: Headers }> = [
    {
      status: 401,
      headers: new Headers({
        "Set-Cookie":
          "charitypilot_access=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      }),
    },
    { status: 401, headers: rotatedAuthCookieHeaders() },
    {
      status: 401,
      headers: new Headers({
        "Set-Cookie": [
          "charitypilot_access=; Path=/; HttpOnly; Secure; SameSite=Lax",
          "charitypilot_refresh=; Path=/; HttpOnly; Secure; SameSite=Lax",
        ].join(", "),
      }),
    },
    { status: 500, headers: deletedAuthCookieHeaders() },
    { status: 429, headers: deletedAuthCookieHeaders() },
  ];

  for (const malformedCase of malformedCases) {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new Response(null, {
        status: input.toString().endsWith("/api/v1/auth/me")
          ? 401
          : malformedCase.status,
        headers: input.toString().endsWith("/api/v1/auth/refresh")
          ? malformedCase.headers
          : undefined,
      })) as typeof fetch;

    const response = await proxy(
      new NextRequest("https://app.charitypilot.ie/compliance", {
        headers: {
          cookie:
            "charitypilot_access=expired; charitypilot_refresh=refresh-token",
        },
      }),
    );

    assert.equal(response.status, 503, String(malformedCase.status));
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("a 401 without a refresh cookie redirects without calling refresh", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(input.toString());
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const response = await proxy(
    new NextRequest("https://app.charitypilot.ie/compliance", {
      headers: { cookie: "charitypilot_access=expired-access" },
    }),
  );

  assert.equal(response.status, 307);
  assert.deepEqual(fetchCalls, ["https://api.charitypilot.ie/api/v1/auth/me"]);
});

test("a successful refresh requires both valid nonempty rotated auth cookies", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  for (const setCookie of [
    null,
    "charitypilot_access=rotated; Path=/; HttpOnly",
    "charitypilot_refresh=rotated; Path=/; HttpOnly",
    "unrelated_cookie=value; Path=/; HttpOnly",
    [
      "charitypilot_access=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      "charitypilot_refresh=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ].join(", "),
    [
      "charitypilot_access=rotated; Path=/; HttpOnly; Secure; SameSite=Lax",
      "charitypilot_refresh=rotated; Path=/; HttpOnly; Secure; SameSite=Lax",
    ].join(", "),
    [
      "charitypilot_access=rotated; Max-Age=900; Path=/; HttpOnly; SameSite=Lax",
      "charitypilot_refresh=rotated; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
    ].join(", "),
  ]) {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new Response(null, {
        status: input.toString().endsWith("/api/v1/auth/me") ? 401 : 200,
        headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
      })) as typeof fetch;

    const response = await proxy(
      new NextRequest("https://app.charitypilot.ie/compliance", {
        headers: {
          cookie:
            "charitypilot_access=expired-access; charitypilot_refresh=refresh-token",
        },
      }),
    );

    assert.equal(response.status, 503, setCookie ?? "no cookie");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("quoted unrelated cookies cannot fabricate auth rotation or deletion boundaries", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  for (const mode of ["rotation", "deletion"] as const) {
    for (const useFallback of [false, true]) {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/api/v1/auth/me")) {
          return new Response(null, { status: 401 });
        }

        const response = new Response(null, {
          status: mode === "rotation" ? 200 : 401,
          headers: forgedQuotedAuthCookieHeaders(mode),
        });
        return useFallback
          ? forceCombinedSetCookieFallback(response)
          : response;
      }) as typeof fetch;

      const response = await proxy(
        new NextRequest("https://app.charitypilot.ie/compliance", {
          headers: {
            cookie:
              "charitypilot_access=expired; charitypilot_refresh=refresh-token",
          },
        }),
      );

      assert.equal(response.status, 503, `${mode}/${useFallback}`);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
});

test("combined Set-Cookie fallback accepts only the unambiguous auth contract", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_API_URL = "https://api.charitypilot.ie";

  for (const mode of ["rotation", "deletion"] as const) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/api/v1/auth/me")) {
        return new Response(null, { status: 401 });
      }

      return forceCombinedSetCookieFallback(
        new Response(null, {
          status: mode === "rotation" ? 200 : 401,
          headers:
            mode === "rotation"
              ? rotatedAuthCookieHeaders()
              : deletedAuthCookieHeaders(),
        }),
      );
    }) as typeof fetch;

    const response = await proxy(
      new NextRequest("https://app.charitypilot.ie/compliance", {
        headers: {
          cookie:
            "charitypilot_access=expired; charitypilot_refresh=refresh-token",
        },
      }),
    );

    assert.equal(response.status, mode === "rotation" ? 200 : 307, mode);
    assert.equal(response.headers.getSetCookie().length, 2);
  }
});

test("invalid or excessive auth Retry-After values fall back to a bounded delay", async () => {
  process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = "development";
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
  process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = "production";
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

test("personal-server HTTPS uses the configured public origin across an internal HTTP proxy hop", async () => {
  process.env.NODE_ENV = "production";
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
    return new Response(null, {
      status: 401,
      headers: deletedAuthCookieHeaders(),
    });
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
    {
      url: "http://api:3002/api/v1/auth/refresh",
      origin: "https://charitypilot-board.example-tailnet.ts.net",
    },
  ]);
  const redirect = new URL(response.headers.get("location") ?? "");
  assert.equal(redirect.origin, "https://charitypilot-board.example-tailnet.ts.net");
  assert.equal(redirect.pathname, "/login");
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
  process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = "production";
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
