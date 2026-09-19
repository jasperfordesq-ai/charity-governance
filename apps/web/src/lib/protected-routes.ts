export const PROTECTED_APP_PREFIXES = [
  '/dashboard',
  '/compliance',
  '/regulator',
  '/documents',
  '/board',
  '/minute-book',
  '/registers',
  '/deadlines',
  '/organisation',
  '/team',
  '/billing',
  '/export',
  '/integrations',
] as const;

function normalisePathname(pathnameOrUrl: string): string {
  const rawPathname = pathnameOrUrl.split(/[?#]/, 1)[0] || '/';

  try {
    return decodeURIComponent(rawPathname).replace(/\\/g, '/');
  } catch {
    return rawPathname.replace(/\\/g, '/');
  }
}

export function isProtectedAppPath(pathnameOrUrl: string): boolean {
  const pathname = normalisePathname(pathnameOrUrl);

  return PROTECTED_APP_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

/**
 * Protected paths that renew the session themselves, and must therefore never
 * be redirected away from on a dead session — not by the middleware, and not
 * by the dashboard layout either.
 *
 * The Confluence callback page is the only one. Atlassian appends
 * `?code=<single-use authorization code>&state=<CSRF state>` to it, and
 * renewing the session before spending that code is the page's entire purpose
 * (`lib/confluence-callback.ts`). Any redirect away from it both abandons the
 * connection and risks carrying the live code into the redirect target.
 *
 * This lives here, beside `PROTECTED_APP_PREFIXES`, rather than in `proxy.ts`,
 * for two reasons. It is a fact about a route, like its neighbours. And
 * `proxy.ts` imports `next/server`, so a client component cannot import from
 * it — the dashboard layout needs this same answer, and two copies of the path
 * string in two files that must agree is exactly the drift worth avoiding.
 */
export const SELF_RENEWING_PROTECTED_PATHS = [
  '/integrations/confluence/callback',
] as const;

export function renewsItsOwnSession(pathnameOrUrl: string): boolean {
  const pathname = normalisePathname(pathnameOrUrl);

  return SELF_RENEWING_PROTECTED_PATHS.some((path) => pathname === path);
}
