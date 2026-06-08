const DEFAULT_DEVELOPMENT_API_URL = 'http://localhost:3002';
const APPROVED_PRODUCTION_HOST = 'charitypilot.ie';

type ApiEnv = {
  NEXT_PUBLIC_API_URL?: string;
  NODE_ENV?: string;
};

export function getApiBaseUrl(env: ApiEnv = process.env): string {
  const configuredUrl = env.NEXT_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    const normalizedUrl = configuredUrl.replace(/\/+$/, '');

    if (env.NODE_ENV === 'production') {
      validateProductionApiUrl(normalizedUrl);
    }

    return normalizedUrl;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_API_URL must be set in production');
  }

  return DEFAULT_DEVELOPMENT_API_URL;
}

function validateProductionApiUrl(value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be a valid URL in production');
  }

  if (url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_API_URL must use https:// in production');
  }

  if (url.origin !== value) {
    throw new Error('NEXT_PUBLIC_API_URL must be an origin-only URL in production');
  }

  const host = url.hostname.toLowerCase();
  if (host !== APPROVED_PRODUCTION_HOST && !host.endsWith(`.${APPROVED_PRODUCTION_HOST}`)) {
    throw new Error('NEXT_PUBLIC_API_URL must use an approved CharityPilot production hostname');
  }
}
