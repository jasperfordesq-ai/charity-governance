import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { parsePort } from './port.js';
import { isConfiguredSecret } from './secrets.js';

export { isConfiguredSecret } from './secrets.js';

const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const APPROVED_PUBLIC_HOST_ROOT = 'charitypilot.ie';
const CANONICAL_PRODUCTION_WEB_ORIGIN = 'https://app.charitypilot.ie';
const CANONICAL_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';
const MAX_ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60;
const MAX_REFRESH_TOKEN_TTL_DAYS = 30;

function isCiProductionSmokeLocalDatabaseAllowed(): boolean {
  return (
    process.env.CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE === 'true' &&
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true'
  );
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
  options: {
    requireHttps?: boolean;
    requireOrigin?: boolean;
    requireApprovedPublicHost?: boolean;
    requirePublicHost?: boolean;
    canonicalOriginRole?: 'web' | 'api';
  },
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
    if (options.canonicalOriginRole) {
      const expected = options.canonicalOriginRole === 'web'
        ? CANONICAL_PRODUCTION_WEB_ORIGIN
        : CANONICAL_PRODUCTION_API_ORIGIN;
      const label = options.canonicalOriginRole === 'api' ? 'API' : 'web';
      if (url.origin !== expected) {
        issues.push(`${name} must use the canonical production ${label} origin ${expected}`);
      }
    }
    if (options.requirePublicHost && !isPublicHost(url.hostname) && !isLocalHost(url.hostname)) {
      issues.push(`${name} must use a public, non-local URL in production`);
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
    requirePublicHost?: boolean;
    canonicalOriginRole?: 'web' | 'api';
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
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal'].includes(normalizedHostname);
}

function normaliseHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;

  return labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function isReservedDocumentationHostname(hostname: string): boolean {
  const normalizedHostname = normaliseHostname(hostname);
  return (
    normalizedHostname === 'example.com' ||
    normalizedHostname === 'example.net' ||
    normalizedHostname === 'example.org' ||
    normalizedHostname.endsWith('.example') ||
    normalizedHostname.endsWith('.example.com') ||
    normalizedHostname.endsWith('.example.net') ||
    normalizedHostname.endsWith('.example.org') ||
    normalizedHostname.endsWith('.test') ||
    normalizedHostname.endsWith('.invalid')
  );
}

function isPublicHost(hostname: string): boolean {
  const normalizedHostname = normaliseHostname(hostname);
  if (
    !normalizedHostname ||
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname.endsWith('.local') ||
    normalizedHostname.endsWith('.internal') ||
    normalizedHostname.endsWith('.lan') ||
    normalizedHostname.endsWith('.home') ||
    isReservedDocumentationHostname(normalizedHostname)
  ) {
    return false;
  }

  if (isIP(normalizedHostname)) return false;

  return isDnsHostname(normalizedHostname);
}

function isApprovedPublicHostname(hostname: string): boolean {
  const normalizedHostname = normaliseHostname(hostname);
  return (
    normalizedHostname === APPROVED_PUBLIC_HOST_ROOT ||
    normalizedHostname.endsWith(`.${APPROVED_PUBLIC_HOST_ROOT}`)
  );
}

function senderEmailHostname(value: string): string | null {
  const trimmed = value.trim();
  const angleMatch = trimmed.match(/^[^<>]*<([^<>]+)>$/);
  const address = (angleMatch?.[1] ?? trimmed).trim();
  const parts = address.split('@');

  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    /[\s<>]/.test(address) ||
    !isDnsHostname(normaliseHostname(parts[1]))
  ) {
    return null;
  }

  return parts[1];
}

function requireApprovedEmailSender(name: string, issues: string[]): void {
  const value = requireConfiguredEnv(name, issues);
  if (!value) return;

  const hostname = senderEmailHostname(value);
  if (!hostname) {
    issues.push(`${name} must be a valid email sender address in production`);
    return;
  }

  if (!isApprovedPublicHostname(hostname)) {
    issues.push(`${name} must use an approved CharityPilot sender domain in production`);
  }
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
    const allowCiSmokeLocalDatabase = isCiProductionSmokeLocalDatabaseAllowed();
    const localDatabaseHost = isLocalHost(url.hostname);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push(`${name} must use a PostgreSQL connection URL`);
    }
    if (localDatabaseHost && !allowCiSmokeLocalDatabase) {
      issues.push(`${name} must not point at localhost in production`);
    }
    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    if ((!sslMode || !REQUIRED_DATABASE_SSL_MODES.has(sslMode)) && !(allowCiSmokeLocalDatabase && localDatabaseHost)) {
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

function requireAccessTokenExpiry(issues: string[]) {
  const value = process.env.JWT_EXPIRY?.trim();
  if (!value) return;

  const match = value.match(/^([1-9]\d*)([smh])$/i);
  if (!match) {
    issues.push('JWT_EXPIRY must be a duration like 15m, 1h, or 3600s');
    return;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  if (amount * multiplier > MAX_ACCESS_TOKEN_EXPIRY_SECONDS) {
    issues.push('JWT_EXPIRY must not exceed 1h in production');
  }
}

function requireRefreshTokenTtlDays(issues: string[]) {
  const value = process.env.REFRESH_TOKEN_TTL_DAYS?.trim();
  if (!value) return;

  if (!/^[1-9]\d*$/.test(value)) {
    issues.push('REFRESH_TOKEN_TTL_DAYS must be an integer from 1 to 30');
    return;
  }

  const ttlDays = Number(value);
  if (ttlDays > MAX_REFRESH_TOKEN_TTL_DAYS) {
    issues.push('REFRESH_TOKEN_TTL_DAYS must be an integer from 1 to 30');
  }
}

function isValidProxyAddress(entry: string): boolean {
  if (['true', 'false', '*', 'all', '0.0.0.0/0', '::/0'].includes(entry.toLowerCase())) {
    return false;
  }

  const parts = entry.split('/');
  if (parts.length > 2) return false;

  const address = parts[0].replace(/^\[|\]$/g, '');
  const version = isIP(address);
  if (!version) return false;

  if (parts.length === 1) return true;

  const prefix = parts[1];
  if (!/^\d+$/.test(prefix)) return false;

  const prefixLength = Number(prefix);
  const maxPrefixLength = version === 4 ? 32 : 128;
  return prefixLength >= 0 && prefixLength <= maxPrefixLength;
}

function requireTrustedProxyAddresses(issues: string[]) {
  const value = process.env.TRUSTED_PROXY_ADDRESSES;
  if (!isConfiguredSecret(value)) {
    issues.push('TRUSTED_PROXY_ADDRESSES must list the reverse proxy address or CIDR for production rate limits');
    return;
  }

  const addresses = envList(value);
  if (!addresses.length || addresses.some((address) => !isValidProxyAddress(address))) {
    issues.push('TRUSTED_PROXY_ADDRESSES must contain only explicit proxy IP addresses or CIDR ranges');
  }
}

function requireProductionDocumentStorageDriver(issues: string[]) {
  if (process.env.DOCUMENT_STORAGE_DRIVER?.trim().toLowerCase() === 'local') {
    issues.push('DOCUMENT_STORAGE_DRIVER must not be local in production; use Supabase document storage');
  }
}

function hostMatchesCookieDomain(hostname: string, cookieDomain: string): boolean {
  const normalizedHost = normaliseHostname(hostname);
  const normalizedDomain = cookieDomain.toLowerCase().replace(/^\./, '');

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function requireAuthCookieDomain(issues: string[]) {
  const frontendUrls = configuredUrls('FRONTEND_URL', { allowCommaSeparated: true });
  const apiUrls = configuredUrls('NEXT_PUBLIC_API_URL');
  if (!frontendUrls.length || !apiUrls.length) return;

  const apiHostname = normaliseHostname(apiUrls[0].hostname);
  const splitHostnames = frontendUrls.some((url) => normaliseHostname(url.hostname) !== apiHostname);
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() ?? '';
  if (!isConfiguredSecret(cookieDomain)) {
    if (!splitHostnames) return;
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

function throwIfProductionIssues(code: string, message: string, issues: string[]): void {
  if (issues.length) {
    throw new AppError(
      500,
      code,
      message,
      issues,
    );
  }
}

export function validateDocumentStorageCleanupEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const issues: string[] = [];

  requireDatabaseUrl('DATABASE_URL', issues);
  requireUrl('SUPABASE_URL', issues, { requireHttps: true, requirePublicHost: true });
  requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
  requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);
  requireProductionDocumentStorageDriver(issues);
  requireUrl('ERROR_ALERT_WEBHOOK_URL', issues, { requireHttps: true, requirePublicHost: true });

  throwIfProductionIssues(
    'DOCUMENT_STORAGE_CLEANUP_ENV_INVALID',
    'Document storage cleanup environment is not ready',
    issues,
  );
}

export function validateDeadlineRemindersEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const issues: string[] = [];

  requireDatabaseUrl('DATABASE_URL', issues);
  requireUrl('FRONTEND_URL', issues, {
    requireHttps: true,
    allowCommaSeparated: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
    canonicalOriginRole: 'web',
  });
  requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
  requireApprovedEmailSender('EMAIL_FROM', issues);
  requireUrl('ERROR_ALERT_WEBHOOK_URL', issues, { requireHttps: true, requirePublicHost: true });

  throwIfProductionIssues(
    'DEADLINE_REMINDERS_ENV_INVALID',
    'Deadline reminders environment is not ready',
    issues,
  );
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

  requireTrustedProxyAddresses(issues);
  requireMinLength('READINESS_API_KEY', 32, issues);
  requireDatabaseUrl('DATABASE_URL', issues);
  requireMinLength('JWT_SECRET', 32, issues);
  requireAccessTokenExpiry(issues);
  requireRefreshTokenTtlDays(issues);
  requireUrl('FRONTEND_URL', issues, {
    requireHttps: true,
    allowCommaSeparated: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
    canonicalOriginRole: 'web',
  });
  requireUrl('NEXT_PUBLIC_API_URL', issues, {
    requireHttps: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
    canonicalOriginRole: 'api',
  });
  requireAuthCookieDomain(issues);

  requirePrefix('STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
  requirePrefix('STRIPE_WEBHOOK_SECRET', 'whsec_', 'Stripe webhook signing secret', issues);
  requirePrefix('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
  requirePrefix('STRIPE_ESSENTIALS_YEARLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
  requirePrefix('STRIPE_COMPLETE_MONTHLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
  requirePrefix('STRIPE_COMPLETE_YEARLY_PRICE_ID', 'price_', 'Stripe price ID', issues);

  requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
  requireApprovedEmailSender('EMAIL_FROM', issues);

  requireUrl('SUPABASE_URL', issues, { requireHttps: true, requirePublicHost: true });
  requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
  requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);
  requireProductionDocumentStorageDriver(issues);
  requireUrl('ERROR_ALERT_WEBHOOK_URL', issues, { requireHttps: true, requirePublicHost: true });

  throwIfProductionIssues('PRODUCTION_ENV_INVALID', 'Production environment is not ready', issues);
}
