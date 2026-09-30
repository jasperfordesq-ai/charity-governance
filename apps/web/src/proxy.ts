import { NextResponse, type NextRequest } from "next/server";
import { createContentSecurityPolicy } from "./lib/content-security-policy";
import {
  getApiBaseUrl,
  getServerApiBaseUrl,
  isPersonalServerProduction,
} from "./lib/api-config";
import {
  webBillingMode,
  webEmailDelivery,
  webRegistrationIsOpen,
} from "./lib/deployment-profile";
import {
  isProtectedAppPath,
  renewsItsOwnSession,
} from "./lib/protected-routes";
import { safeNextValue } from "./lib/url-security";

const AUTH_COOKIE_NAMES = [
  "charitypilot_access",
  "charitypilot_refresh",
] as const;
const REFRESH_COOKIE_NAME = "charitypilot_refresh";
const PROTECTED_RESPONSE_CACHE_CONTROL = "no-store, no-cache, must-revalidate";
const AUTH_VALIDATION_TIMEOUT_MS = 5_000;
const inFlightProtectedAuthValidations = new Map<string, Promise<Response | null>>();
const DEFAULT_AUTH_RETRY_AFTER = "5";
const MAX_AUTH_RETRY_AFTER_SECONDS = 300;
const SENSITIVE_AUTH_PATHS = new Set([
  "/session-renew",
  "/reset-password",
  "/verify-email",
  "/accept-invite",
  "/owner/set-password",
]);
const ISOLATED_E2E_MODE = "local-disposable";

type ProtectedAuthSession =
  | { state: "authenticated" }
  | { state: "unauthenticated" }
  | { state: "unavailable"; retryAfter: string };

function unavailableAuthSession(response?: Response): ProtectedAuthSession {
  const rawRetryAfter = response?.headers.get("retry-after")?.trim() ?? "";
  const retryAfterSeconds = /^\d+$/.test(rawRetryAfter)
    ? Number(rawRetryAfter)
    : Number.NaN;
  const retryAfter =
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 0 &&
    retryAfterSeconds <= MAX_AUTH_RETRY_AFTER_SECONDS
      ? String(retryAfterSeconds)
      : DEFAULT_AUTH_RETRY_AFTER;

  return { state: "unavailable", retryAfter };
}

function hasAuthSessionCookie(request: NextRequest): boolean {
  return AUTH_COOKIE_NAMES.some((cookieName) =>
    Boolean(request.cookies.get(cookieName)?.value),
  );
}

function protectedAuthCookieHeader(request: NextRequest): string {
  return AUTH_COOKIE_NAMES.map((cookieName) => {
    const cookie = request.cookies.get(cookieName);
    return cookie?.value ? `${cookieName}=${cookie.value}` : null;
  })
    .filter((cookie): cookie is string => Boolean(cookie))
    .join("; ");
}

function createApiAuthUrl(pathname: string): URL | null {
  try {
    return new URL(pathname, getServerApiBaseUrl());
  } catch {
    return null;
  }
}

function isPersonalServerRuntime(): boolean {
  return isPersonalServerProduction({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
      process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
  });
}

function personalServerPublicOrigin(): string | null {
  if (!isPersonalServerRuntime()) return null;

  try {
    // Personal-server mode deliberately uses one public origin for both the web
    // application and browser API. Use that fail-closed configuration instead
    // of the internal HTTP hop seen after Tailscale/Cloudflare terminates TLS.
    return getApiBaseUrl();
  } catch {
    return null;
  }
}

function externalRequestUrl(request: NextRequest): URL {
  const configuredOrigin = personalServerPublicOrigin();
  if (!configuredOrigin) return request.nextUrl.clone();

  const externalUrl = new URL(configuredOrigin);
  externalUrl.pathname = request.nextUrl.pathname;
  externalUrl.search = request.nextUrl.search;
  externalUrl.hash = request.nextUrl.hash;
  return externalUrl;
}

async function validateProtectedAuthSession(
  request: NextRequest,
): Promise<ProtectedAuthSession> {
  const cookieHeader = protectedAuthCookieHeader(request);
  if (!cookieHeader) return { state: "unauthenticated" };

  const authUrl = createApiAuthUrl("/api/v1/auth/me");
  if (!authUrl) return unavailableAuthSession();

  let validationKey: string;
  try {
    const keyBytes = new TextEncoder().encode(
      `${authUrl.href}\n${request.nextUrl.origin}\n${cookieHeader}`,
    );
    const digest = await crypto.subtle.digest("SHA-256", keyBytes);
    validationKey = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return unavailableAuthSession();
  }

  let validation = inFlightProtectedAuthValidations.get(validationKey);
  if (!validation) {
    validation = fetch(authUrl, {
      headers: { Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTH_VALIDATION_TIMEOUT_MS),
    }).catch(() => null);
    inFlightProtectedAuthValidations.set(validationKey, validation);
    const pending = validation;
    void pending.then(() => {
      if (inFlightProtectedAuthValidations.get(validationKey) === pending) {
        inFlightProtectedAuthValidations.delete(validationKey);
      }
    });
  }

  const response = await validation;
  if (!response) return unavailableAuthSession();
  if (response.status === 200) {
    return { state: "authenticated" };
  }
  if (response.status !== 401) return unavailableAuthSession(response);

  // Only a definitive 401 may enter browser renewal or login. Throttling,
  // outage and deployment mismatch remain fail-closed 503 outcomes.
  return { state: "unauthenticated" };
}

function addProtectedNoCacheHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", PROTECTED_RESPONSE_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  return response;
}

function addSensitiveAuthHeaders(response: NextResponse): NextResponse {
  addProtectedNoCacheHeaders(response);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function isSensitiveAuthPath(pathname: string): boolean {
  let normalisedPathname = pathname;
  try {
    normalisedPathname = decodeURIComponent(pathname);
  } catch {
    normalisedPathname = pathname;
  }
  normalisedPathname =
    normalisedPathname.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return SENSITIVE_AUTH_PATHS.has(normalisedPathname);
}

function createNonce(): string {
  return btoa(crypto.randomUUID());
}

function requestWebOrigin(request: NextRequest): string | undefined {
  const configuredOrigin = personalServerPublicOrigin();
  if (configuredOrigin) return configuredOrigin;

  const host = request.headers.get("host")?.trim();
  if (!host) return undefined;

  try {
    return `${new URL(request.url).protocol}//${host}`;
  } catch {
    return undefined;
  }
}

function createRequestContentSecurityPolicy(
  request: NextRequest,
  nonce: string,
): string {
  return createContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV !== "production",
    isIsolatedE2e:
      process.env.NODE_ENV === "production" &&
      process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE === ISOLATED_E2E_MODE,
    isPersonalServer: isPersonalServerProduction({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
        process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
    }),
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    webUrl: requestWebOrigin(request),
  });
}

function createCspRequestHeaders(
  request: NextRequest,
  nonce: string,
  csp: string,
): Headers {
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return requestHeaders;
}

function addContentSecurityPolicy(
  response: NextResponse,
  csp: string,
): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

function redirectSensitiveQueryToken(
  request: NextRequest,
  csp: string,
): NextResponse | null {
  if (!isSensitiveAuthPath(request.nextUrl.pathname)) return null;

  const token = request.nextUrl.searchParams.get("token");
  if (!token) return null;

  const redirectUrl = externalRequestUrl(request);
  redirectUrl.searchParams.delete("token");

  const fragmentParams = new URLSearchParams(
    redirectUrl.hash.startsWith("#")
      ? redirectUrl.hash.slice(1)
      : redirectUrl.hash,
  );
  fragmentParams.set("token", token);
  redirectUrl.hash = fragmentParams.toString();

  return addContentSecurityPolicy(
    addSensitiveAuthHeaders(NextResponse.redirect(redirectUrl)),
    csp,
  );
}

function redirectToLogin(
  request: NextRequest,
  csp: string,
): NextResponse {
  const { pathname, search } = request.nextUrl;
  const loginUrl = externalRequestUrl(request);
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  // Depth behind SELF_RENEWING_PROTECTED_PATHS (lib/protected-routes.ts), for
  // every other protected path: whatever the caller arrived with, no
  // single-use secret is carried into `next`.
  // A query string nested inside a parameter is invisible to the
  // proxy's own `delete code` / `delete state` log filter, so it has to be
  // removed here, at the point the URL is built. `safeNextValue` is shared
  // with the dashboard layout, which builds the same redirect client-side.
  loginUrl.searchParams.set("next", safeNextValue(pathname, search));

  const response = NextResponse.redirect(loginUrl);
  return addContentSecurityPolicy(addProtectedNoCacheHeaders(response), csp);
}

function redirectToSessionRenew(request: NextRequest, csp: string): NextResponse {
  const { pathname, search } = request.nextUrl;
  const renewalUrl = externalRequestUrl(request);
  renewalUrl.pathname = "/session-renew";
  renewalUrl.search = "";
  renewalUrl.searchParams.set("next", safeNextValue(pathname, search));
  return addContentSecurityPolicy(
    addSensitiveAuthHeaders(NextResponse.redirect(renewalUrl)),
    csp,
  );
}

/**
 * Render a protected route: the CSP request headers, the protected no-store
 * headers. Session rotation happens only in the browser renewal flow.
 *
 * Reached on the ordinary authenticated path and — see
 * SELF_RENEWING_PROTECTED_PATHS in lib/protected-routes.ts — instead of a
 * login redirect for a path that renews its own session. The dashboard layout
 * makes the same exclusion client-side, from the same list.
 */
function protectedPassThrough(
  request: NextRequest,
  nonce: string,
  csp: string,
): NextResponse {
  const requestHeaders = createCspRequestHeaders(request, nonce, csp);
  const response = addContentSecurityPolicy(
    addProtectedNoCacheHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
    ),
    csp,
  );
  return response;
}

function authenticationUnavailable(
  csp: string,
  retryAfter: string,
): NextResponse {
  const response = new NextResponse(
    "Authentication service temporarily unavailable",
    {
      status: 503,
      headers: { "Retry-After": retryAfter },
    },
  );
  return addContentSecurityPolicy(addProtectedNoCacheHeaders(response), csp);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = createNonce();
  const csp = createRequestContentSecurityPolicy(request, nonce);

  // Root: there is exactly one org on a personal server, so a public
  // marketing home page never applies — this is the appliance's shape, not a
  // capability axis, so it stays keyed on the deployment mode.
  if (
    pathname === "/" &&
    isPersonalServerProduction({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
        process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
    })
  ) {
    const redirectUrl = externalRequestUrl(request);
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    return addContentSecurityPolicy(NextResponse.redirect(redirectUrl), csp);
  }

  // These three routes each gate on the capability they actually depend on,
  // not the deployment mode: a multi-tenant install with registration closed
  // (or billing disabled, or no provider email) must hide the same routes an
  // appliance does, for the same reason. Only meaningful in production, where
  // the built bundle's NEXT_PUBLIC_* axis values are fixed and real.
  if (process.env.NODE_ENV === "production") {
    const destination =
      pathname === "/register" && !webRegistrationIsOpen()
        ? "/login"
        : pathname === "/forgot-password" && webEmailDelivery() !== "provider"
          ? "/login"
          : pathname === "/billing" && webBillingMode() !== "stripe"
            ? "/dashboard"
            : null;
    if (destination) {
      const redirectUrl = externalRequestUrl(request);
      redirectUrl.pathname = destination;
      redirectUrl.search = "";
      return addContentSecurityPolicy(NextResponse.redirect(redirectUrl), csp);
    }
  }

  const sensitiveTokenRedirect = redirectSensitiveQueryToken(request, csp);
  if (sensitiveTokenRedirect) return sensitiveTokenRedirect;

  if (!isProtectedAppPath(pathname)) {
    const requestHeaders = createCspRequestHeaders(request, nonce, csp);
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    const responseWithCsp = addContentSecurityPolicy(response, csp);
    return isSensitiveAuthPath(pathname)
      ? addSensitiveAuthHeaders(responseWithCsp)
      : responseWithCsp;
  }

  if (!hasAuthSessionCookie(request)) {
    // See SELF_RENEWING_PROTECTED_PATHS (lib/protected-routes.ts): this page
    // renews the session itself, and its URL carries a live authorization code
    // that must not be put into a `Location` header.
    if (renewsItsOwnSession(pathname)) {
      return protectedPassThrough(request, nonce, csp);
    }
    return redirectToLogin(request, csp);
  }

  const authSession = await validateProtectedAuthSession(request);
  if (authSession.state === "unavailable") {
    return authenticationUnavailable(csp, authSession.retryAfter);
  }
  if (authSession.state === "unauthenticated") {
    // The callback handles its own browser renewal and may carry a live
    // one-use code. Never put that code into a redirect URL.
    if (renewsItsOwnSession(pathname)) {
      return protectedPassThrough(request, nonce, csp);
    }
    // A page request may run in any web worker. Never rotate the browser's
    // single-use token here: the browser renewal route uses a cross-tab lock.
    return request.cookies.get(REFRESH_COOKIE_NAME)?.value
      ? redirectToSessionRenew(request, csp)
      : redirectToLogin(request, csp);
  }

  return protectedPassThrough(request, nonce, csp);
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|robots.txt|sitemap.xml).*)"],
};
