import { NextResponse, type NextRequest } from 'next/server';
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

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isProtectedAppPath(pathname)) {
    return NextResponse.next();
  }

  if (!hasAuthSessionCookie(request)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('next', `${pathname}${search}`);

    return addProtectedNoCacheHeaders(NextResponse.redirect(loginUrl));
  }

  return addProtectedNoCacheHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/compliance/:path*',
    '/regulator/:path*',
    '/documents/:path*',
    '/board/:path*',
    '/registers/:path*',
    '/deadlines/:path*',
    '/organisation/:path*',
    '/team/:path*',
    '/billing/:path*',
    '/export/:path*',
  ],
};
