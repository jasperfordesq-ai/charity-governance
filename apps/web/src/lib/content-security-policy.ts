type CreateContentSecurityPolicyOptions = {
  nonce: string;
  isDevelopment: boolean;
  isIsolatedE2e?: boolean;
  apiUrl?: string;
  webUrl?: string;
};

const DEFAULT_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';
const DEFAULT_DEVELOPMENT_API_ORIGIN = 'http://localhost:3002';
const DEFAULT_DEVELOPMENT_WEB_ORIGIN = 'http://localhost:3003';
const ISOLATED_E2E_BROWSER_API_ORIGIN = 'http://127.0.0.1:3302';
const DEVELOPMENT_API_HOSTS = new Set(['localhost', '127.0.0.1']);

function developmentApiConnectSource(apiUrl?: string): string | undefined {
  const configuredUrl = apiUrl?.trim();
  if (!configuredUrl) return DEFAULT_DEVELOPMENT_API_ORIGIN;

  try {
    const url = new URL(configuredUrl);
    const normalizedConfiguredUrl = configuredUrl.replace(/\/+$/, '');
    if (
      url.protocol === 'http:' &&
      url.origin === normalizedConfiguredUrl &&
      DEVELOPMENT_API_HOSTS.has(url.hostname)
    ) {
      return url.origin;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function developmentWebConnectSources(webUrl?: string): string[] {
  const configuredUrl = webUrl?.trim() || DEFAULT_DEVELOPMENT_WEB_ORIGIN;

  try {
    const url = new URL(configuredUrl);
    const normalizedConfiguredUrl = configuredUrl.replace(/\/+$/, '');
    if (
      url.protocol === 'http:' &&
      url.origin === normalizedConfiguredUrl &&
      DEVELOPMENT_API_HOSTS.has(url.hostname)
    ) {
      const websocketUrl = new URL(url.origin);
      websocketUrl.protocol = 'ws:';
      return [url.origin, websocketUrl.origin];
    }
  } catch {
    return [];
  }

  return [];
}

function productionApiConnectSource(apiUrl?: string): string {
  const configuredUrl = apiUrl?.trim();
  if (!configuredUrl) return DEFAULT_PRODUCTION_API_ORIGIN;

  try {
    const url = new URL(configuredUrl);
    const normalizedConfiguredUrl = configuredUrl.replace(/\/+$/, '');
    if (
      url.protocol === 'https:' &&
      url.origin === normalizedConfiguredUrl &&
      url.origin === DEFAULT_PRODUCTION_API_ORIGIN
    ) {
      return url.origin;
    }
  } catch {
    return DEFAULT_PRODUCTION_API_ORIGIN;
  }

  return DEFAULT_PRODUCTION_API_ORIGIN;
}

function isolatedE2eApiConnectSource(apiUrl?: string): string | undefined {
  const configuredUrl = apiUrl?.trim();
  if (!configuredUrl) return undefined;

  const normalizedConfiguredUrl = configuredUrl.replace(/\/+$/, '');
  return normalizedConfiguredUrl === ISOLATED_E2E_BROWSER_API_ORIGIN
    ? ISOLATED_E2E_BROWSER_API_ORIGIN
    : undefined;
}

export function createContentSecurityPolicy({
  nonce,
  isDevelopment,
  isIsolatedE2e = false,
  apiUrl,
  webUrl,
}: CreateContentSecurityPolicyOptions): string {
  const connectSrc = (
    isDevelopment
      ? [
          "'self'",
          developmentApiConnectSource(apiUrl),
          ...developmentWebConnectSources(webUrl),
        ]
      : isIsolatedE2e
        ? ["'self'", isolatedE2eApiConnectSource(apiUrl)]
        : ["'self'", productionApiConnectSource(apiUrl)]
  )
    .filter((source): source is string => Boolean(source))
    .join(' ');

  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDevelopment) {
    scriptSrc.push("'unsafe-eval'");
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "form-action 'self'",
    ...(isDevelopment || isIsolatedE2e ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
