#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import process from 'node:process';

const PLACEHOLDERS = [
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
];

const REQUIRED = [
  'NODE_ENV',
  'PORT',
  'TRUSTED_PROXY_ADDRESSES',
  'READINESS_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
  'FRONTEND_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'ERROR_ALERT_WEBHOOK_URL',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

const ENV_FILE_FLAG = '--production-env-file=';
const COMPOSE_RUNTIME_WEB_API_URL = 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL';
const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const APPROVED_PUBLIC_HOST_ROOT = 'charitypilot.ie';

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
        return [key, value];
      }),
  );
}

function envValue(env, key) {
  return env[key] ?? '';
}

function isConfigured(value) {
  return Boolean(value.trim()) && !PLACEHOLDERS.some((placeholder) => value.includes(placeholder));
}

function isLocalHost(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal'].includes(normalizedHostname);
}

function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isDnsHostname(hostname) {
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;

  return labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function isPublicHost(hostname) {
  const normalizedHostname = normaliseHostname(hostname);
  if (
    !normalizedHostname ||
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname.endsWith('.local') ||
    normalizedHostname.endsWith('.internal') ||
    normalizedHostname.endsWith('.lan') ||
    normalizedHostname.endsWith('.home')
  ) {
    return false;
  }

  if (isIP(normalizedHostname)) return false;

  return isDnsHostname(normalizedHostname);
}

function isApprovedPublicHostname(hostname) {
  const normalizedHostname = normaliseHostname(hostname);
  return normalizedHostname === APPROVED_PUBLIC_HOST_ROOT || normalizedHostname.endsWith(`.${APPROVED_PUBLIC_HOST_ROOT}`);
}

function senderEmailHostname(value) {
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

function requireApprovedEmailSender(env, key, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  const hostname = senderEmailHostname(value);
  if (!hostname) {
    issues.push(`${key} must be a valid email sender address for production`);
    return;
  }

  if (!isApprovedPublicHostname(hostname)) {
    issues.push(`${key} must use an approved CharityPilot sender domain for production`);
  }
}

function requireExactValue(env, key, expected, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  if (value !== expected) {
    issues.push(`${key} must be ${expected}`);
  }
}

function isValidProxyAddress(entry) {
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

function requireTrustedProxyAddresses(env, issues) {
  const value = envValue(env, 'TRUSTED_PROXY_ADDRESSES');
  if (!isConfigured(value)) return;

  const addresses = envList(value);
  if (!addresses.length || addresses.some((address) => !isValidProxyAddress(address))) {
    issues.push('TRUSTED_PROXY_ADDRESSES must contain only explicit proxy IP addresses or CIDR ranges');
  }
}

function requireIntegerPort(env, key, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be an integer from 1 to 65535`);
    return;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`${key} must be an integer from 1 to 65535`);
  }
}

function envList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateUrlValue(key, value, issues, options = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      issues.push(`${key} must use https:// for production`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${key} must not point at localhost for production`);
    }
    if (options.requireOrigin && (url.pathname !== '/' || url.search || url.hash)) {
      issues.push(`${key} must be an origin-only URL for production`);
    }
    if (options.requireApprovedPublicHost && !isApprovedPublicHostname(url.hostname)) {
      issues.push(`${key} must use an approved CharityPilot production hostname`);
    }
    if (options.requirePublicHost && !isPublicHost(url.hostname) && !isLocalHost(url.hostname)) {
      issues.push(`${key} must use a public, non-local URL for production`);
    }
  } catch {
    issues.push(`${key} must be a valid URL`);
  }
}

function requireUrl(env, key, issues, options = {}) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  const values = options.allowCommaSeparated ? envList(value) : [value];
  if (values.length === 0) {
    issues.push(`${key} is missing or still contains a placeholder value`);
    return;
  }

  for (const urlValue of values) {
    validateUrlValue(key, urlValue, issues, options);
  }
}

function configuredUrls(env, key, options = {}) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return [];

  const values = options.allowCommaSeparated ? envList(value) : [value];
  const urls = [];

  for (const urlValue of values) {
    try {
      urls.push(new URL(urlValue));
    } catch {
      // URL validity is reported by requireUrl.
    }
  }

  return urls;
}

function requireDatabaseUrl(env, key, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  try {
    const url = new URL(value);
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
      issues.push(`${key} must use a PostgreSQL connection URL`);
    }
    if (isLocalHost(url.hostname)) {
      issues.push(`${key} must not point at localhost for production`);
    }
    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    if (!sslMode || !REQUIRED_DATABASE_SSL_MODES.has(sslMode)) {
      issues.push(`${key} must require TLS with sslmode=require, verify-ca, or verify-full for production`);
    }
  } catch {
    issues.push(`${key} must be a valid PostgreSQL connection URL`);
  }
}

function requirePrefix(env, key, prefix, label, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  if (!value.startsWith(prefix)) {
    issues.push(`${key} must use a ${label}`);
  }
}

function hostMatchesCookieDomain(hostname, cookieDomain) {
  const normalizedHost = normaliseHostname(hostname);
  const normalizedDomain = cookieDomain.toLowerCase().replace(/^\./, '');

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function requireAuthCookieDomainForSplitHosts(env, issues) {
  const frontendUrls = configuredUrls(env, 'FRONTEND_URL', { allowCommaSeparated: true });
  const apiUrls = configuredUrls(env, 'NEXT_PUBLIC_API_URL');
  if (!frontendUrls.length || !apiUrls.length) return;

  const apiHostname = normaliseHostname(apiUrls[0].hostname);
  const splitHostnames = frontendUrls.some((url) => normaliseHostname(url.hostname) !== apiHostname);
  if (!splitHostnames) return;

  const cookieDomain = envValue(env, 'AUTH_COOKIE_DOMAIN').trim();
  if (!isConfigured(cookieDomain)) {
    issues.push('AUTH_COOKIE_DOMAIN must be set when FRONTEND_URL and NEXT_PUBLIC_API_URL use different hostnames');
    return;
  }

  if (cookieDomain.includes('/') || cookieDomain.includes(':')) {
    issues.push('AUTH_COOKIE_DOMAIN must be a cookie domain, not a URL');
    return;
  }

  if (!isApprovedPublicHostname(cookieDomain.toLowerCase().replace(/^\./, ''))) {
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

function requireComposeRuntimeWebApiUrl(env, runtimeEnv, issues) {
  const value = envValue(runtimeEnv, COMPOSE_RUNTIME_WEB_API_URL);
  if (!isConfigured(value)) {
    issues.push(`${COMPOSE_RUNTIME_WEB_API_URL} is missing or still contains a placeholder value`);
    return;
  }

  const issueCountBeforeUrlValidation = issues.length;
  requireUrl(runtimeEnv, COMPOSE_RUNTIME_WEB_API_URL, issues, {
    requireOrigin: true,
    requireApprovedPublicHost: true,
  });

  if (issues.length !== issueCountBeforeUrlValidation) return;

  const [envFileApiUrl] = configuredUrls(env, 'NEXT_PUBLIC_API_URL');
  const [runtimeApiUrl] = configuredUrls(runtimeEnv, COMPOSE_RUNTIME_WEB_API_URL);
  if (envFileApiUrl && runtimeApiUrl && runtimeApiUrl.origin !== envFileApiUrl.origin) {
    issues.push(
      `${COMPOSE_RUNTIME_WEB_API_URL} must match NEXT_PUBLIC_API_URL so the production web runtime, CSP, and client bundle use the same API origin`,
    );
  }
}

const envFileArg = process.argv.find((arg) => arg.startsWith(ENV_FILE_FLAG));
const envFile = envFileArg ? envFileArg.slice(ENV_FILE_FLAG.length) : '.env.production';

if (!existsSync(envFile)) {
  console.error(`Production preflight failed: environment file not found: ${envFile}`);
  process.exit(1);
}

const env = parseEnvFile(envFile);
const runtimeWebApiUrlFromProcess = process.env[COMPOSE_RUNTIME_WEB_API_URL] ?? '';
const runtimeEnv = {
  [COMPOSE_RUNTIME_WEB_API_URL]: runtimeWebApiUrlFromProcess.trim()
    ? runtimeWebApiUrlFromProcess
    : envValue(env, COMPOSE_RUNTIME_WEB_API_URL),
};
const issues = [];

for (const key of REQUIRED) {
  if (!isConfigured(envValue(env, key))) {
    issues.push(`${key} is missing or still contains a placeholder value`);
  }
}

requireExactValue(env, 'NODE_ENV', 'production', issues);
requireTrustedProxyAddresses(env, issues);
requireIntegerPort(env, 'PORT', issues);
requireDatabaseUrl(env, 'DATABASE_URL', issues);
requirePrefix(env, 'STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
requirePrefix(env, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_', 'live Stripe publishable key', issues);
requireApprovedEmailSender(env, 'EMAIL_FROM', issues);

for (const key of ['JWT_SECRET', 'READINESS_API_KEY']) {
  const value = envValue(env, key);
  if (isConfigured(value) && value.length < 32) {
    issues.push(`${key} must be at least 32 characters`);
  }
}

requireUrl(env, 'FRONTEND_URL', issues, {
  allowCommaSeparated: true,
  requireOrigin: true,
  requireApprovedPublicHost: true,
});
requireUrl(env, 'SUPABASE_URL', issues);
requireUrl(env, 'ERROR_ALERT_WEBHOOK_URL', issues, { requirePublicHost: true });
requireUrl(env, 'NEXT_PUBLIC_API_URL', issues, { requireOrigin: true, requireApprovedPublicHost: true });
requireComposeRuntimeWebApiUrl(env, runtimeEnv, issues);
requireAuthCookieDomainForSplitHosts(env, issues);

if (issues.length) {
  console.error(`Production preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`);
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Production preflight passed using ${envFile}`);
