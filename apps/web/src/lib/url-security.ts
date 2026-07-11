import {
  ISOLATED_E2E_BROWSER_API_ORIGIN,
  isIsolatedE2eProduction,
} from './api-config';

const STRIPE_REDIRECT_ORIGINS = new Set([
  'https://checkout.stripe.com',
  'https://billing.stripe.com',
]);

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hashSearchParams(url: URL): URLSearchParams | null {
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!hash || !hash.includes('=')) return null;

  return new URLSearchParams(hash);
}

function normaliseHttpsOrigins(origins: Array<string | undefined>): Set<string> {
  const normalised = new Set<string>();

  for (const origin of origins) {
    if (!origin) continue;

    for (const part of origin.split(',')) {
      const candidate = part.trim();
      if (!candidate) continue;

      const url = parseUrl(candidate);
      if (url?.protocol === 'https:') {
        normalised.add(url.origin);
      }
    }
  }

  return normalised;
}

function defaultDocumentDownloadOrigins(): Set<string> {
  return normaliseHttpsOrigins([
    process.env.NEXT_PUBLIC_API_URL,
    'https://api.charitypilot.ie',
  ]);
}

function isDocumentDownloadRoute(url: URL): boolean {
  return (
    /^\/api\/v1\/documents\/[^/]+\/download$/.test(url.pathname) &&
    url.search === '' &&
    url.hash === ''
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
}

function isLocalApiDocumentDownloadUrl(url: URL): boolean {
  const isDevelopmentLoopback =
    process.env.NODE_ENV !== 'production' &&
    url.protocol === 'http:' &&
    isLoopbackHostname(url.hostname);
  const isExactIsolatedProductionOrigin =
    isIsolatedE2eProduction({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE,
    }) &&
    url.origin === ISOLATED_E2E_BROWSER_API_ORIGIN;

  return (
    (isDevelopmentLoopback || isExactIsolatedProductionOrigin) &&
    isDocumentDownloadRoute(url)
  );
}

export function removeSensitiveSearchParams(rawUrl: string, paramNames: string[]): string {
  const isRelative = rawUrl.startsWith('/') && !rawUrl.startsWith('//');
  const url = new URL(rawUrl, 'https://charitypilot.local');

  for (const paramName of paramNames) {
    url.searchParams.delete(paramName);
  }

  const fragmentParams = hashSearchParams(url);
  if (fragmentParams) {
    for (const paramName of paramNames) {
      fragmentParams.delete(paramName);
    }

    url.hash = fragmentParams.size ? fragmentParams.toString() : '';
  }

  if (isRelative) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return url.toString();
}

export function getSensitiveUrlToken(rawUrl: string, paramName: string): string {
  const url = new URL(rawUrl, 'https://charitypilot.local');
  const fragmentToken = hashSearchParams(url)?.get(paramName);
  if (fragmentToken) return fragmentToken;

  const queryToken = url.searchParams.get(paramName);
  if (queryToken) return queryToken;

  return '';
}

export function getTrustedStripeRedirectUrl(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || !STRIPE_REDIRECT_ORIGINS.has(url.origin)) {
    return null;
  }

  return url.toString();
}

export function getTrustedDocumentDownloadUrl(
  value: unknown,
): string | null {
  const url = parseUrl(value);
  if (!url) return null;

  if (isLocalApiDocumentDownloadUrl(url)) {
    return url.toString();
  }

  if (
    url.protocol === 'https:' &&
    isDocumentDownloadRoute(url) &&
    defaultDocumentDownloadOrigins().has(url.origin)
  ) {
    return url.toString();
  }

  return null;
}
