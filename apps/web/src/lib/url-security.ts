import {
  ISOLATED_E2E_BROWSER_API_ORIGIN,
  isIsolatedE2eProduction,
  isPersonalServerProduction,
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
  const configuredPersonalOrigin = parseUrl(process.env.NEXT_PUBLIC_API_URL);
  const isExactPersonalServerOrigin =
    isPersonalServerProduction({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
        process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
    }) &&
    configuredPersonalOrigin !== null &&
    configuredPersonalOrigin.origin === process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') &&
    !configuredPersonalOrigin.username &&
    !configuredPersonalOrigin.password &&
    (
      configuredPersonalOrigin.protocol === 'https:' ||
      (configuredPersonalOrigin.protocol === 'http:' && isLoopbackHostname(configuredPersonalOrigin.hostname))
    ) &&
    url.origin === configuredPersonalOrigin.origin;

  return (
    (isDevelopmentLoopback || isExactIsolatedProductionOrigin || isExactPersonalServerOrigin) &&
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

/**
 * The parameters that must never be carried inside a `next` value.
 *
 * `code` and `state` are the OAuth callback's single-use secrets. `token` is
 * already handled by the middleware's `redirectSensitiveQueryToken` for the
 * sensitive auth paths, and is listed here so that a protected path which ever
 * grows one cannot leak it through this door instead.
 */
export const SENSITIVE_NEXT_PARAMS = ['code', 'state', 'token'];

/**
 * Build the `next` value for a login redirect, with every single-use secret
 * removed first.
 *
 * There are two places that send a signed-out visitor to `/login?next=…`: the
 * middleware (`proxy.ts`, server-side) and the dashboard layout (client-side,
 * after the auth context resolves to no user). Both call this, so neither can
 * drift from the other — a second scrubber written beside one of them is how
 * this leak came back the first time.
 *
 * It matters because a query string nested inside a parameter is invisible to
 * the reverse proxy's own log filter, which deletes only TOP-LEVEL `code` and
 * `state` (see `caddy/Caddyfile*` and `docs/bluegreen-runbook.md`).
 */
export function safeNextValue(pathname: string, search: string): string {
  return removeSensitiveSearchParams(`${pathname}${search}`, SENSITIVE_NEXT_PARAMS);
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

  if (isPersonalServerProduction({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE:
      process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE,
  })) {
    return null;
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
