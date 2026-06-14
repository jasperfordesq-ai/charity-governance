const STRIPE_REDIRECT_ORIGINS = new Set([
  'https://checkout.stripe.com',
  'https://billing.stripe.com',
]);

type DownloadUrlOptions = {
  allowedOrigins?: string[];
};

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
    process.env.NEXT_PUBLIC_DOCUMENT_DOWNLOAD_ORIGINS,
    process.env.NEXT_PUBLIC_API_URL,
    'https://api.charitypilot.ie',
  ]);
}

function configuredSupabaseStorageOrigin(): string | null {
  const origins = normaliseHttpsOrigins([process.env.NEXT_PUBLIC_SUPABASE_URL]);
  return origins.values().next().value ?? null;
}

function isSupabaseSignedStorageUrl(url: URL): boolean {
  const configuredOrigin = configuredSupabaseStorageOrigin();
  if (!configuredOrigin || url.origin !== configuredOrigin) return false;

  return (
    url.protocol === 'https:' &&
    url.pathname.startsWith('/storage/v1/object/sign/')
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
}

function isLocalApiDocumentDownloadUrl(url: URL): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    url.protocol === 'http:' &&
    isLoopbackHostname(url.hostname) &&
    url.pathname === '/api/v1/documents/_local-download'
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
  options: DownloadUrlOptions = {},
): string | null {
  const url = parseUrl(value);
  if (!url) return null;

  if (isLocalApiDocumentDownloadUrl(url)) {
    return url.toString();
  }

  if (url.protocol !== 'https:') return null;

  const allowedOrigins = options.allowedOrigins
    ? normaliseHttpsOrigins(options.allowedOrigins)
    : defaultDocumentDownloadOrigins();

  if (allowedOrigins.has(url.origin) || isSupabaseSignedStorageUrl(url)) {
    return url.toString();
  }

  return null;
}
