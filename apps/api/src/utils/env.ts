import { AppError } from './errors.js';
import { parsePort } from './port.js';

const PLACEHOLDER_PATTERNS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'sk_test_...',
  'pk_test_...',
  'whsec_...',
  'price_...',
  're_...',
  'eyJ...',
  'https://your-project.supabase.co',
] as const;

const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const APPROVED_PUBLIC_HOST_ROOT = 'charitypilot.ie';

export function isConfiguredSecret(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  return !PLACEHOLDER_PATTERNS.some((placeholder) => value.includes(placeholder));
}

function requireConfiguredEnv(name: string, issues: string[]): string | undefined {
  const value = process.env[name];
  if (!isConfiguredSecret(value)) {
    issues.push(`${name} is missing or still contains a placeholder value`);
    return undefined;
  }
  return value;
}

function envList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateUrlValue(
  name: string,
  value: string,
  issues: string[],
  options: { requireHttps?: boolean; requireOrigin?: boolean; requireApprovedPublicHost?: boolean },
) {
  try {
    const url = new URL(value);
    if (options.requireHttps && url.protocol !== 'https:') {
      issues.push(`${name} must use https:// in production`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${name} must not point at localhost in production`);
    }
    if (options.requireOrigin && (url.pathname !== '/' || url.search || url.hash)) {
      issues.push(`${name} must be an origin-only URL in production`);
    }
    if (options.requireApprovedPublicHost && !isApprovedPublicHostname(url.hostname)) {
      issues.push(`${name} must use an approved CharityPilot production hostname`);
    }
  } catch {
    issues.push(`${name} must be a valid URL`);
  }
}

function requireUrl(
  name: string,
  issues: string[],
  options: {
    requireHttps?: boolean;
    allowCommaSeparated?: boolean;
    requireOrigin?: boolean;
    requireApprovedPublicHost?: boolean;
  } = {},
) {
  const value = requireConfiguredEnv(name, issues);
  if (!value) return;

  const values = options.allowCommaSeparated ? envList(value) : [value];
  if (values.length === 0) {
    issues.push(`${name} is missing or still contains a placeholder value`);
    return;
  }

  for (const urlValue of values) {
    validateUrlValue(name, urlValue, issues, options);
  }
}

function isLocalHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(normalizedHostname);
}

function normaliseHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isApprovedPublicHostname(hostname: string): boolean {
  const normalizedHostname = normaliseHostname(hostname);
  return (
    normalizedHostname === APPROVED_PUBLIC_HOST_ROOT ||
    normalizedHostname.endsWith(`.${APPROVED_PUBLIC_HOST_ROOT}`)
  );
}

function configuredUrls(name: string, options: { allowCommaSeparated?: boolean } = {}): URL[] {
  const value = process.env[name];
  if (!isConfiguredSecret(value)) return [];

  const values = options.allowCommaSeparated ? envList(value) : [value];
  const urls: URL[] = [];

  for (const urlValue of values) {
    try {
      urls.push(new URL(urlValue));
    } catch {
      // URL validity is reported by requireUrl.
    }
  }

  return urls;
}

function requireDatabaseUrl(name: string, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (!value) return;

  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push(`${name} must use a PostgreSQL connection URL`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${name} must not point at localhost in production`);
    }
    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    if (!sslMode || !REQUIRED_DATABASE_SSL_MODES.has(sslMode)) {
      issues.push(`${name} must require TLS with sslmode=require, verify-ca, or verify-full in production`);
    }
  } catch {
    issues.push(`${name} must be a valid PostgreSQL connection URL`);
  }
}

function requirePrefix(name: string, prefix: string, label: string, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (value && !value.startsWith(prefix)) {
    issues.push(`${name} must use a ${label} in production`);
  }
}

function requireMinLength(name: string, minLength: number, issues: string[]) {
  const value = requireConfiguredEnv(name, issues);
  if (value && value.length < minLength) {
    issues.push(`${name} must be at least ${minLength} characters`);
  }
}

function hostMatchesCookieDomain(hostname: string, cookieDomain: string): boolean {
  const normalizedHost = normaliseHostname(hostname);
  const normalizedDomain = cookieDomain.toLowerCase().replace(/^\./, '');

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function requireAuthCookieDomainForSplitHosts(issues: string[]) {
  const frontendUrls = configuredUrls('FRONTEND_URL', { allowCommaSeparated: true });
  const apiUrls = configuredUrls('NEXT_PUBLIC_API_URL');
  if (!frontendUrls.length || !apiUrls.length) return;

  const apiHostname = normaliseHostname(apiUrls[0].hostname);
  const splitHostnames = frontendUrls.some((url) => normaliseHostname(url.hostname) !== apiHostname);
  if (!splitHostnames) return;

  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() ?? '';
  if (!isConfiguredSecret(cookieDomain)) {
    issues.push('AUTH_COOKIE_DOMAIN must be set when FRONTEND_URL and NEXT_PUBLIC_API_URL use different hostnames');
    return;
  }

  if (cookieDomain.includes('/') || cookieDomain.includes(':')) {
    issues.push('AUTH_COOKIE_DOMAIN must be a cookie domain, not a URL');
    return;
  }

  const normalizedCookieDomain = cookieDomain.toLowerCase().replace(/^\./, '');
  if (!isApprovedPublicHostname(normalizedCookieDomain)) {
    issues.push('AUTH_COOKIE_DOMAIN must use an approved CharityPilot production hostname');
    return;
  }

  for (const url of [...frontendUrls, ...apiUrls]) {
    if (!hostMatchesCookieDomain(url.hostname, cookieDomain)) {
      issues.push('AUTH_COOKIE_DOMAIN must cover both FRONTEND_URL and NEXT_PUBLIC_API_URL hostnames');
      return;
    }
  }
}

export function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const issues: string[] = [];

  try {
    requireConfiguredEnv('PORT', issues);
    parsePort(process.env.PORT, 3002);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'PORT must be an integer from 1 to 65535');
  }

  requireDatabaseUrl('DATABASE_URL', issues);
  requireMinLength('JWT_SECRET', 32, issues);
  requireUrl('FRONTEND_URL', issues, {
    requireHttps: true,
    allowCommaSeparated: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
  });
  requireUrl('NEXT_PUBLIC_API_URL', issues, {
    requireHttps: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
  });
  requireAuthCookieDomainForSplitHosts(issues);

  requirePrefix('STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
  requireConfiguredEnv('STRIPE_WEBHOOK_SECRET', issues);
  requireConfiguredEnv('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_ESSENTIALS_YEARLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_COMPLETE_MONTHLY_PRICE_ID', issues);
  requireConfiguredEnv('STRIPE_COMPLETE_YEARLY_PRICE_ID', issues);

  requireConfiguredEnv('RESEND_API_KEY', issues);
  requireConfiguredEnv('EMAIL_FROM', issues);

  requireUrl('SUPABASE_URL', issues, { requireHttps: true });
  requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
  requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);

  if (issues.length) {
    throw new AppError(
      500,
      'PRODUCTION_ENV_INVALID',
      'Production environment is not ready',
      issues,
    );
  }
}
