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
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_API_URL,
    'https://api.charitypilot.ie',
  ]);
}

function isSupabaseSignedStorageUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname.endsWith('.supabase.co') &&
    url.pathname.startsWith('/storage/v1/object/sign/')
  );
}

export function removeSensitiveSearchParams(rawUrl: string, paramNames: string[]): string {
  const isRelative = rawUrl.startsWith('/') && !rawUrl.startsWith('//');
  const url = new URL(rawUrl, 'https://charitypilot.local');

  for (const paramName of paramNames) {
    url.searchParams.delete(paramName);
  }

  if (isRelative) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return url.toString();
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
  if (!url || url.protocol !== 'https:') return null;

  const allowedOrigins = options.allowedOrigins
    ? normaliseHttpsOrigins(options.allowedOrigins)
    : defaultDocumentDownloadOrigins();

  if (allowedOrigins.has(url.origin) || isSupabaseSignedStorageUrl(url)) {
    return url.toString();
  }

  return null;
}
