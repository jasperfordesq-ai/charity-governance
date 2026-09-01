const DEFAULT_DEVELOPMENT_API_URL = 'http://localhost:3002';
const CANONICAL_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';
export const ISOLATED_E2E_MODE = 'local-disposable';
export const ISOLATED_E2E_BROWSER_API_ORIGIN = 'http://127.0.0.1:3302';
const ISOLATED_E2E_INTERNAL_API_ORIGIN = 'http://api:3302';
export const PERSONAL_SERVER_MODE = 'personal-server';
export const PERSONAL_SERVER_INTERNAL_API_ORIGIN = 'http://api:3002';

export type ApiEnv = {
  CHARITYPILOT_INTERNAL_API_URL?: string;
  NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE?: string;
  NEXT_PUBLIC_API_URL?: string;
  NEXT_PUBLIC_CHARITYPILOT_E2E_MODE?: string;
  NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN?: string;
  NODE_ENV?: string;
};

export function isIsolatedE2eProduction(env: ApiEnv): boolean {
  return (
    env.NODE_ENV === 'production' &&
    env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE === ISOLATED_E2E_MODE
  );
}

export function isPersonalServerProduction(env: ApiEnv): boolean {
  return (
    env.NODE_ENV === 'production' &&
    env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_MODE
  );
}

export function getApiBaseUrl(env: ApiEnv = process.env): string {
  const configuredUrl = env.NEXT_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    const normalizedUrl = configuredUrl.replace(/\/+$/, '');

    if (env.NODE_ENV === 'production') {
      if (isIsolatedE2eProduction(env)) {
        validateIsolatedE2eBrowserApiUrl(normalizedUrl);
      } else if (isPersonalServerProduction(env)) {
        validatePersonalServerBrowserApiUrl(normalizedUrl);
      } else {
        validateProductionApiUrl(normalizedUrl, env);
      }
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

  if (isIsolatedE2eProduction(env)) {
    throw new Error('CHARITYPILOT_INTERNAL_API_URL must be set for isolated production E2E');
  }

  if (isPersonalServerProduction(env)) {
    throw new Error('CHARITYPILOT_INTERNAL_API_URL must be set for personal-server production');
  }

  return getApiBaseUrl(env);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
}

function validatePersonalServerBrowserApiUrl(value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be a valid origin in personal-server production');
  }

  if (url.origin !== value || url.username || url.password) {
    throw new Error('NEXT_PUBLIC_API_URL must be an origin-only URL in personal-server production');
  }

  const secureOrigin = url.protocol === 'https:';
  const exactLoopbackHttpOrigin = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!secureOrigin && !exactLoopbackHttpOrigin) {
    throw new Error(
      'NEXT_PUBLIC_API_URL must use https:// or exact loopback http:// in personal-server production',
    );
  }
}

function validateIsolatedE2eBrowserApiUrl(value: string): void {
  if (value !== ISOLATED_E2E_BROWSER_API_ORIGIN) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must use the exact isolated E2E browser origin ${ISOLATED_E2E_BROWSER_API_ORIGIN}`,
    );
  }
}

// Mirrors apps/web/Dockerfile's build-time RUN check (the already-reviewed
// semantics) exactly: an empty-or-unset NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN
// (P1 convention: '' counts as unset, since Docker ARG/ENV pairs can only
// express "unset" as an empty string) keeps every hosted-SaaS install pinned
// byte-for-byte to the hardcoded canonical origin below. A validly-shaped
// override widens the check for a non-hosted target (blue-green single-origin
// topology, a private-VM Tailscale hostname) whose own NEXT_PUBLIC_API_URL
// must then equal that override's origin exactly.
function validateProductionApiUrl(value: string, env: ApiEnv): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be a valid URL in production');
  }

  const canonicalOverride = env.NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN?.trim();

  if (canonicalOverride) {
    let overrideUrl: URL;

    try {
      overrideUrl = new URL(canonicalOverride);
    } catch {
      throw new Error('NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN must be a valid origin');
    }

    if (overrideUrl.origin !== canonicalOverride || overrideUrl.username || overrideUrl.password) {
      throw new Error(
        'NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN must be an origin-only URL (no path, no trailing slash, no credentials)',
      );
    }

    const secureOverride = overrideUrl.protocol === 'https:';
    const exactLoopbackHttpOverride =
      overrideUrl.protocol === 'http:' && isLoopbackHostname(overrideUrl.hostname);
    if (!secureOverride && !exactLoopbackHttpOverride) {
      throw new Error(
        'NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN must use https:// or exact loopback http://',
      );
    }

    if (value !== overrideUrl.origin) {
      throw new Error(
        `NEXT_PUBLIC_API_URL must equal the configured canonical API origin ${overrideUrl.origin} (set via NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN)`,
      );
    }

    return;
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
    if (isIsolatedE2eProduction(env)) {
      if (value !== ISOLATED_E2E_INTERNAL_API_ORIGIN) {
        throw new Error(
          `CHARITYPILOT_INTERNAL_API_URL must use the exact isolated E2E internal origin ${ISOLATED_E2E_INTERNAL_API_ORIGIN}`,
        );
      }
      return;
    }

    if (isPersonalServerProduction(env)) {
      if (value !== PERSONAL_SERVER_INTERNAL_API_ORIGIN) {
        throw new Error(
          `CHARITYPILOT_INTERNAL_API_URL must use the exact personal-server internal origin ${PERSONAL_SERVER_INTERNAL_API_ORIGIN}`,
        );
      }
      return;
    }

    validateProductionApiUrl(value, env);
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
