import { NextResponse, type NextRequest } from "next/server";
import { createContentSecurityPolicy } from "./lib/content-security-policy";
import {
  getApiBaseUrl,
  getServerApiBaseUrl,
  isPersonalServerProduction,
} from "./lib/api-config";
import { isProtectedAppPath } from "./lib/protected-routes";

const AUTH_COOKIE_NAMES = [
  "charitypilot_access",
  "charitypilot_refresh",
] as const;
const REFRESH_COOKIE_NAME = "charitypilot_refresh";
const PROTECTED_RESPONSE_CACHE_CONTROL = "no-store, no-cache, must-revalidate";
const AUTH_VALIDATION_TIMEOUT_MS = 5_000;
const DEFAULT_AUTH_RETRY_AFTER = "5";
const MAX_AUTH_RETRY_AFTER_SECONDS = 300;
const SENSITIVE_AUTH_PATHS = new Set([
  "/reset-password",
  "/verify-email",
  "/accept-invite",
]);
const ISOLATED_E2E_MODE = "local-disposable";

type ProtectedAuthSession =
  | { state: "authenticated"; setCookieHeaders: string[] }
  | { state: "unauthenticated"; setCookieHeaders: string[] }
  | { state: "unavailable"; setCookieHeaders: []; retryAfter: string };

type ParsedSetCookie = {
  raw: string;
  name: string;
  value: string;
  attributes: Map<string, string | true>;
};

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const COOKIE_HEADER_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

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

  return { state: "unavailable", setCookieHeaders: [], retryAfter };
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

function isSetCookieBoundary(header: string, commaIndex: number): boolean {
  const remainder = header.slice(commaIndex + 1);
  return /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(remainder);
}

function splitCombinedSetCookieHeader(header: string): string[] | null {
  if (!header || COOKIE_HEADER_CONTROL_PATTERN.test(header)) return null;

  const cookies: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;

  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (inQuotes && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === '"' && !escaped) {
      inQuotes = !inQuotes;
    }
    escaped = false;

    if (character === "," && !inQuotes && isSetCookieBoundary(header, index)) {
      const cookie = header.slice(start, index).trim();
      if (!cookie) return null;
      cookies.push(cookie);
      start = index + 1;
    }
  }

  if (inQuotes) return null;
  const finalCookie = header.slice(start).trim();
  if (!finalCookie) return null;
  cookies.push(finalCookie);
  return cookies;
}

function setCookieHeaders(headers: Headers): string[] | null {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === "function") {
    // Each entry is already one Set-Cookie field. Re-splitting it would let a
    // quoted value containing `, charitypilot_refresh=` fabricate a second
    // authentication cookie.
    return getSetCookie.call(headers).map((header) => header.trim());
  }

  const setCookie = headers.get("set-cookie");
  return setCookie ? splitCombinedSetCookieHeader(setCookie) : [];
}

function parseSetCookieHeader(header: string): ParsedSetCookie | null {
  if (
    !header ||
    COOKIE_HEADER_CONTROL_PATTERN.test(header) ||
    header.includes('"') ||
    header.includes("\\")
  ) {
    return null;
  }

  const [nameValue, ...attributeParts] = header.split(";");
  const equalsIndex = nameValue?.indexOf("=") ?? -1;
  if (equalsIndex <= 0) return null;

  const rawName = nameValue.slice(0, equalsIndex);
  const rawValue = nameValue.slice(equalsIndex + 1);
  const name = rawName.trim();
  const value = rawValue.trim();
  if (
    rawName !== name ||
    rawValue !== value ||
    !COOKIE_NAME_PATTERN.test(name) ||
    !COOKIE_VALUE_PATTERN.test(value)
  ) {
    return null;
  }

  const attributes = new Map<string, string | true>();
  for (const rawAttribute of attributeParts) {
    const attribute = rawAttribute.trim();
    if (!attribute) continue;

    const attributeEqualsIndex = attribute.indexOf("=");
    const attributeName = (
      attributeEqualsIndex === -1
        ? attribute
        : attribute.slice(0, attributeEqualsIndex)
    )
      .trim()
      .toLowerCase();
    if (
      !COOKIE_NAME_PATTERN.test(attributeName) ||
      attributes.has(attributeName)
    ) {
      return null;
    }

    attributes.set(
      attributeName,
      attributeEqualsIndex === -1
        ? true
        : attribute.slice(attributeEqualsIndex + 1).trim(),
    );
  }

  return { raw: header, name, value, attributes };
}

function hasExpectedAuthCookieScope(cookie: ParsedSetCookie): boolean {
  const sameSite = cookie.attributes.get("samesite");
  const personalServer = isPersonalServerProduction({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
      process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
  });
  const secureRequired = process.env.NODE_ENV === "production" &&
    process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE !== ISOLATED_E2E_MODE &&
    (!personalServer || process.env.NEXT_PUBLIC_API_URL?.startsWith("https://"));

  return (
    cookie.attributes.get("path") === "/" &&
    cookie.attributes.get("httponly") === true &&
    typeof sameSite === "string" &&
    sameSite.toLowerCase() === "lax" &&
    (!secureRequired || cookie.attributes.get("secure") === true)
  );
}

function validatedAuthCookieHeaders(
  headers: Headers,
  mode: "rotation" | "deletion",
): string[] | null {
  const cookieHeaders = setCookieHeaders(headers);
  if (!cookieHeaders) return null;
  const parsedHeaders = cookieHeaders.map(parseSetCookieHeader);
  if (parsedHeaders.some((cookie) => cookie === null)) return null;
  const validParsedHeaders = parsedHeaders as ParsedSetCookie[];
  const selectedCookies = AUTH_COOKIE_NAMES.map((cookieName) =>
    validParsedHeaders.filter((cookie) => cookie.name === cookieName),
  );

  if (selectedCookies.some((cookies) => cookies.length !== 1)) return null;

  const authCookies: ParsedSetCookie[] = [];
  for (const [cookie] of selectedCookies) {
    if (!cookie || !hasExpectedAuthCookieScope(cookie)) return null;
    authCookies.push(cookie);
  }

  const valid = authCookies.every((cookie) => {
    const maxAge = cookie.attributes.get("max-age");
    if (typeof maxAge !== "string" || !/^\d+$/.test(maxAge)) return false;

    if (mode === "deletion") {
      return cookie.value === "" && maxAge === "0";
    }

    return cookie.value.length > 0 && Number(maxAge) > 0;
  });

  return valid ? authCookies.map((cookie) => cookie.raw) : null;
}

async function validateProtectedAuthSession(
  request: NextRequest,
): Promise<ProtectedAuthSession> {
  const cookieHeader = protectedAuthCookieHeader(request);
  if (!cookieHeader) return { state: "unauthenticated", setCookieHeaders: [] };

  const authUrl = createApiAuthUrl("/api/v1/auth/me");
  if (!authUrl) return unavailableAuthSession();

  try {
    const response = await fetch(authUrl, {
      headers: { Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTH_VALIDATION_TIMEOUT_MS),
    });

    if (response.status === 200) {
      return { state: "authenticated", setCookieHeaders: [] };
    }
    if (response.status !== 401) return unavailableAuthSession(response);
  } catch {
    return unavailableAuthSession();
  }

  // Only a definitive credential rejection may enter refresh or login. A
  // throttle, upstream outage, or deployment mismatch must fail closed without
  // misrepresenting a valid user as logged out.
  if (!request.cookies.get(REFRESH_COOKIE_NAME)?.value) {
    return { state: "unauthenticated", setCookieHeaders: [] };
  }

  const refreshUrl = createApiAuthUrl("/api/v1/auth/refresh");
  if (!refreshUrl) return unavailableAuthSession();

  const refreshOrigin = personalServerPublicOrigin() ?? request.nextUrl.origin;

  try {
    const response = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: refreshOrigin,
      },
      body: "{}",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTH_VALIDATION_TIMEOUT_MS),
    });

    if (response.status === 200) {
      const rotatedCookieHeaders = validatedAuthCookieHeaders(
        response.headers,
        "rotation",
      );
      if (!rotatedCookieHeaders) return unavailableAuthSession(response);

      return {
        state: "authenticated",
        setCookieHeaders: rotatedCookieHeaders,
      };
    }

    if (response.status === 401) {
      const deletedCookieHeaders = validatedAuthCookieHeaders(
        response.headers,
        "deletion",
      );
      return deletedCookieHeaders
        ? { state: "unauthenticated", setCookieHeaders: deletedCookieHeaders }
        : unavailableAuthSession(response);
    }

    return unavailableAuthSession(response);
  } catch {
    return unavailableAuthSession();
  }
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

function addSetCookieHeaders(
  response: NextResponse,
  headers: string[],
): NextResponse {
  for (const header of headers) {
    response.headers.append("Set-Cookie", header);
  }
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
  setCookieHeaders: string[] = [],
): NextResponse {
  const { pathname, search } = request.nextUrl;
  const loginUrl = externalRequestUrl(request);
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${search}`);

  const response = addSetCookieHeaders(
    NextResponse.redirect(loginUrl),
    setCookieHeaders,
  );
  return addContentSecurityPolicy(addProtectedNoCacheHeaders(response), csp);
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

  if (isPersonalServerProduction({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
      process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
  })) {
    const destination = pathname === "/" || pathname === "/register" || pathname === "/forgot-password"
      ? "/login"
      : pathname === "/billing"
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
    return redirectToLogin(request, csp);
  }

  const authSession = await validateProtectedAuthSession(request);
  if (authSession.state === "unavailable") {
    return authenticationUnavailable(csp, authSession.retryAfter);
  }
  if (authSession.state === "unauthenticated") {
    return redirectToLogin(request, csp, authSession.setCookieHeaders);
  }

  const requestHeaders = createCspRequestHeaders(request, nonce, csp);
  const response = addContentSecurityPolicy(
    addProtectedNoCacheHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
    ),
    csp,
  );
  return addSetCookieHeaders(response, authSession.setCookieHeaders);
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|robots.txt|sitemap.xml).*)"],
};
