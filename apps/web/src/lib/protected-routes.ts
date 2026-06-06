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

export function isProtectedAppPath(pathnameOrUrl: string): boolean {
  const pathname = pathnameOrUrl.split(/[?#]/, 1)[0] || '/';

  return PROTECTED_APP_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}
