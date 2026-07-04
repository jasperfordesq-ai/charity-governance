export const PRODUCTION_WEB_ORIGIN = 'https://app.charitypilot.ie';

export function absoluteSiteUrl(path = ''): string {
  if (!path || path === '/') return PRODUCTION_WEB_ORIGIN;
  return `${PRODUCTION_WEB_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}
