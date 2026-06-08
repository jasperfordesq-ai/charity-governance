import { NextResponse, type NextRequest } from 'next/server';
import { createContentSecurityPolicy } from './lib/content-security-policy';
import { isProtectedAppPath } from './lib/protected-routes';

const AUTH_COOKIE_NAMES = ['charitypilot_access', 'charitypilot_refresh'] as const;
const REFRESH_COOKIE_NAME = 'charitypilot_refresh';
const PROTECTED_RESPONSE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
const SENSITIVE_AUTH_PATHS = new Set(['/reset-password', '/verify-email', '/accept-invite']);

function hasAuthSessionCookie(request: NextRequest): boolean {
  return AUTH_COOKIE_NAMES.some((cookieName) => Boolean(request.cookies.get(cookieName)?.value));
}

function protectedAuthCookieHeader(request: NextRequest): string {
  return AUTH_COOKIE_NAMES
    .map((cookieName) => {
      const cookie = request.cookies.get(cookieName);
      return cookie?.value ? `${cookieName}=${cookie.value}` : null;
    })
    .filter((cookie): cookie is string => Boolean(cookie))
    .join('; ');
}

function createApiAuthUrl(pathname: string): URL | null {
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim() ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3002');

  if (!configuredApiUrl) return null;

  try {
    return new URL(pathname, configuredApiUrl.replace(/\/+$/, ''));
  } catch {
    return null;
  }
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') return getSetCookie.call(headers);

  const setCookie = headers.get('set-cookie');
  return setCookie ? [setCookie] : [];
}

async function validateProtectedAuthSession(request: NextRequest): Promise<{
  authenticated: boolean;
  setCookieHeaders: string[];
}> {
  const cookieHeader = protectedAuthCookieHeader(request);
  if (!cookieHeader) return { authenticated: false, setCookieHeaders: [] };

  const authUrl = createApiAuthUrl('/api/v1/auth/me');
  if (!authUrl) return { authenticated: false, setCookieHeaders: [] };

  try {
    const response = await fetch(authUrl, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      redirect: 'manual',
    });

    if (response.ok) return { authenticated: true, setCookieHeaders: [] };
  } catch {
    return { authenticated: false, setCookieHeaders: [] };
  }

  if (!request.cookies.get(REFRESH_COOKIE_NAME)?.value) {
    return { authenticated: false, setCookieHeaders: [] };
  }

  const refreshUrl = createApiAuthUrl('/api/v1/auth/refresh');
  if (!refreshUrl) return { authenticated: false, setCookieHeaders: [] };

  try {
    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: '{}',
      cache: 'no-store',
      redirect: 'manual',
    });

    return {
      authenticated: response.ok,
      setCookieHeaders: response.ok ? setCookieHeaders(response.headers) : [],
    };
  } catch {
    return { authenticated: false, setCookieHeaders: [] };
  }
}

function addProtectedNoCacheHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PROTECTED_RESPONSE_CACHE_CONTROL);
  response.headers.set('Pragma', 'no-cache');
  return response;
}

function addSensitiveAuthHeaders(response: NextResponse): NextResponse {
  addProtectedNoCacheHeaders(response);
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function isSensitiveAuthPath(pathname: string): boolean {
  let normalisedPathname = pathname;
  try {
    normalisedPathname = decodeURIComponent(pathname);
  } catch {
    normalisedPathname = pathname;
  }
  normalisedPathname = normalisedPathname.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return SENSITIVE_AUTH_PATHS.has(normalisedPathname);
}

function createNonce(): string {
  return btoa(crypto.randomUUID());
}

function createRequestContentSecurityPolicy(nonce: string): string {
  return createContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV !== 'production',
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
  });
}

function createCspRequestHeaders(request: NextRequest, nonce: string, csp: string): Headers {
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  return requestHeaders;
}

function addContentSecurityPolicy(response: NextResponse, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function addSetCookieHeaders(response: NextResponse, headers: string[]): NextResponse {
  for (const header of headers) {
    response.headers.append('Set-Cookie', header);
  }
  return response;
}

function redirectSensitiveQueryToken(request: NextRequest, csp: string): NextResponse | null {
  if (!isSensitiveAuthPath(request.nextUrl.pathname)) return null;

  const token = request.nextUrl.searchParams.get('token');
  if (!token) return null;

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.searchParams.delete('token');

  const fragmentParams = new URLSearchParams(
    redirectUrl.hash.startsWith('#') ? redirectUrl.hash.slice(1) : redirectUrl.hash,
  );
  fragmentParams.set('token', token);
  redirectUrl.hash = fragmentParams.toString();

  return addContentSecurityPolicy(addSensitiveAuthHeaders(NextResponse.redirect(redirectUrl)), csp);
}

function redirectToLogin(request: NextRequest, csp: string): NextResponse {
  const { pathname, search } = request.nextUrl;
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  loginUrl.searchParams.set('next', `${pathname}${search}`);

  const response = NextResponse.redirect(loginUrl);
  return addContentSecurityPolicy(addProtectedNoCacheHeaders(response), csp);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = createNonce();
  const csp = createRequestContentSecurityPolicy(nonce);
  const sensitiveTokenRedirect = redirectSensitiveQueryToken(request, csp);
  if (sensitiveTokenRedirect) return sensitiveTokenRedirect;

  if (!isProtectedAppPath(pathname)) {
    const requestHeaders = createCspRequestHeaders(request, nonce, csp);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    const responseWithCsp = addContentSecurityPolicy(response, csp);
    return isSensitiveAuthPath(pathname) ? addSensitiveAuthHeaders(responseWithCsp) : responseWithCsp;
  }

  if (!hasAuthSessionCookie(request)) {
    return redirectToLogin(request, csp);
  }

  const authSession = await validateProtectedAuthSession(request);
  if (!authSession.authenticated) {
    return redirectToLogin(request, csp);
  }

  const requestHeaders = createCspRequestHeaders(request, nonce, csp);
  const response = addContentSecurityPolicy(
    addProtectedNoCacheHeaders(NextResponse.next({ request: { headers: requestHeaders } })),
    csp,
  );
  return addSetCookieHeaders(response, authSession.setCookieHeaders);
}

export const config = {
  matcher: [
    '/((?!api|_next|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
