export const PROTECTED_APP_PREFIXES = [
  '/dashboard',
  '/compliance',
  '/regulator',
  '/documents',
  '/board',
  '/registers',
  '/deadlines',
  '/organisation',
  '/team',
  '/billing',
  '/export',
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
