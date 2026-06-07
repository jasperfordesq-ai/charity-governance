import { NextResponse, type NextRequest } from 'next/server';
import { createContentSecurityPolicy } from './lib/content-security-policy';
import { isProtectedAppPath } from './lib/protected-routes';

const AUTH_COOKIE_NAMES = ['charitypilot_access', 'charitypilot_refresh'] as const;
const PROTECTED_RESPONSE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';

function hasAuthSessionCookie(request: NextRequest): boolean {
  return AUTH_COOKIE_NAMES.some((cookieName) => Boolean(request.cookies.get(cookieName)?.value));
}

function addProtectedNoCacheHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PROTECTED_RESPONSE_CACHE_CONTROL);
  response.headers.set('Pragma', 'no-cache');
  return response;
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

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const nonce = createNonce();
  const csp = createRequestContentSecurityPolicy(nonce);

  if (!isProtectedAppPath(pathname)) {
    const requestHeaders = createCspRequestHeaders(request, nonce, csp);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    return addContentSecurityPolicy(response, csp);
  }

  if (!hasAuthSessionCookie(request)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('next', `${pathname}${search}`);

    const response = NextResponse.redirect(loginUrl);
    return addContentSecurityPolicy(addProtectedNoCacheHeaders(response), csp);
  }

  const requestHeaders = createCspRequestHeaders(request, nonce, csp);
  return addContentSecurityPolicy(
    addProtectedNoCacheHeaders(NextResponse.next({ request: { headers: requestHeaders } })),
    csp,
  );
}

export const config = {
  matcher: [
    '/((?!api|_next|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
