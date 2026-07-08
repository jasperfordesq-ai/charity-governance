const DEFAULT_DEVELOPMENT_API_URL = 'http://localhost:3002';
const CANONICAL_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';

type ApiEnv = {
  CHARITYPILOT_INTERNAL_API_URL?: string;
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

export function getServerApiBaseUrl(env: ApiEnv = process.env): string {
  const configuredInternalUrl = env.CHARITYPILOT_INTERNAL_API_URL?.trim();

  if (configuredInternalUrl) {
    const normalizedUrl = configuredInternalUrl.replace(/\/+$/, '');
    validateServerApiUrl(normalizedUrl, env);
    return normalizedUrl;
  }

  return getApiBaseUrl(env);
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

  if (url.origin !== CANONICAL_PRODUCTION_API_ORIGIN) {
    throw new Error(`NEXT_PUBLIC_API_URL must use the canonical production API origin ${CANONICAL_PRODUCTION_API_ORIGIN}`);
  }
}

function validateServerApiUrl(value: string, env: ApiEnv): void {
  if (env.NODE_ENV === 'production') {
    validateProductionApiUrl(value);
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CHARITYPILOT_INTERNAL_API_URL must be a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CHARITYPILOT_INTERNAL_API_URL must use http:// or https://');
  }

  if (url.origin !== value) {
    throw new Error('CHARITYPILOT_INTERNAL_API_URL must be an origin-only URL');
  }
}
