#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
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
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

const ENV_FILE_FLAG = '--production-env-file=';
const REQUIRED_DATABASE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

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
  return env[key] ?? process.env[key] ?? '';
}

function isConfigured(value) {
  return Boolean(value.trim()) && !PLACEHOLDERS.some((placeholder) => value.includes(placeholder));
}

function isLocalHost(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(normalizedHostname);
}

function requireExactValue(env, key, expected, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  if (value !== expected) {
    issues.push(`${key} must be ${expected}`);
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
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const normalizedDomain = cookieDomain.toLowerCase().replace(/^\./, '');

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function requireAuthCookieDomainForSplitHosts(env, issues) {
  const frontendUrls = configuredUrls(env, 'FRONTEND_URL', { allowCommaSeparated: true });
  const apiUrls = configuredUrls(env, 'NEXT_PUBLIC_API_URL');
  if (!frontendUrls.length || !apiUrls.length) return;

  const apiHostname = apiUrls[0].hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const splitHostnames = frontendUrls.some((url) => url.hostname.toLowerCase().replace(/^\[|\]$/g, '') !== apiHostname);
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

  for (const url of [...frontendUrls, ...apiUrls]) {
    if (!hostMatchesCookieDomain(url.hostname, cookieDomain)) {
      issues.push('AUTH_COOKIE_DOMAIN must cover both FRONTEND_URL and NEXT_PUBLIC_API_URL hostnames');
      return;
    }
  }
}

const envFileArg = process.argv.find((arg) => arg.startsWith(ENV_FILE_FLAG));
const envFile = envFileArg ? envFileArg.slice(ENV_FILE_FLAG.length) : '.env.production';

if (!existsSync(envFile)) {
  console.error(`Production preflight failed: environment file not found: ${envFile}`);
  process.exit(1);
}

const env = parseEnvFile(envFile);
const issues = [];

for (const key of REQUIRED) {
  if (!isConfigured(envValue(env, key))) {
    issues.push(`${key} is missing or still contains a placeholder value`);
  }
}

requireExactValue(env, 'NODE_ENV', 'production', issues);
requireIntegerPort(env, 'PORT', issues);
requireDatabaseUrl(env, 'DATABASE_URL', issues);
requirePrefix(env, 'STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
requirePrefix(env, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_', 'live Stripe publishable key', issues);

for (const key of ['JWT_SECRET']) {
  const value = envValue(env, key);
  if (isConfigured(value) && value.length < 32) {
    issues.push(`${key} must be at least 32 characters`);
  }
}

requireUrl(env, 'FRONTEND_URL', issues, { allowCommaSeparated: true, requireOrigin: true });
requireUrl(env, 'SUPABASE_URL', issues);
requireUrl(env, 'NEXT_PUBLIC_API_URL', issues, { requireOrigin: true });
requireAuthCookieDomainForSplitHosts(env, issues);

if (issues.length) {
  console.error(`Production preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`);
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Production preflight passed using ${envFile}`);
