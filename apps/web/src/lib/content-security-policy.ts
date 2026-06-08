type CreateContentSecurityPolicyOptions = {
  nonce: string;
  isDevelopment: boolean;
  apiUrl?: string;
};

const DEFAULT_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';
const APPROVED_PRODUCTION_HOST = 'charitypilot.ie';

function isApprovedProductionHost(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
  return normalizedHost === APPROVED_PRODUCTION_HOST || normalizedHost.endsWith(`.${APPROVED_PRODUCTION_HOST}`);
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
      isApprovedProductionHost(url.hostname)
    ) {
      return url.origin;
    }
  } catch {
    return DEFAULT_PRODUCTION_API_ORIGIN;
  }

  return DEFAULT_PRODUCTION_API_ORIGIN;
}

export function createContentSecurityPolicy({
  nonce,
  isDevelopment,
  apiUrl,
}: CreateContentSecurityPolicyOptions): string {
  const connectSrc = isDevelopment
    ? "'self' http://localhost:3002 http://localhost:3003 ws://localhost:3003"
    : `'self' ${productionApiConnectSource(apiUrl)}`;

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
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
