#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, normalize, sep } from 'node:path';
import process from 'node:process';
import { domainToASCII, pathToFileURL } from 'node:url';
import {
  APPROVED_PUBLIC_HOST_ROOT,
  canonicalOriginIssue,
  isApprovedCharityPilotHostname,
  normaliseHostname,
} from './production-hostnames.mjs';

const PLACEHOLDERS = [
  'REPLACE_ME',
  'change-me',
  'your_',
  'your-',
  'project_ref',
  'sk_test_...',
  'pk_test_...',
  'whsec_...',
  'price_...',
  'bpc_...',
  're_...',
  'eyJ...',
  'https://your-project.supabase.co',
];
const COPIED_PLACEHOLDER_PATTERN = /secret[-_]?store/i;

const REQUIRED = [
  'NODE_ENV',
  'PORT',
  'TRUSTED_PROXY_ADDRESSES',
  'READINESS_API_KEY',
  'DATABASE_URL',
  'DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST',
  'JWT_SECRET',
  'AUTH_RECOVERY_SECRET',
  'FRONTEND_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
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
const USAGE_TEXT = 'Usage: node scripts/check-production.mjs [--production-env-file=<path>]';
const COMPOSE_RUNTIME_WEB_API_URL = 'CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL';
const ALLOWED_LIBPQ_QUERY_OPTIONS = new Set([
  'application_name', 'channel_binding', 'connect_timeout',
  'keepalives', 'keepalives_count', 'keepalives_idle', 'keepalives_interval',
  'sslmode', 'sslrootcert', 'target_session_attrs', 'tcp_user_timeout',
]);
const MAX_ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60;
const MAX_REFRESH_TOKEN_TTL_DAYS = 30;
const SAMPLE_SUPABASE_PROJECT_REF_PATTERN = /^(?:configured-project|example|ci-project|test-project|demo-project|sample-project)$/i;
const RECOVERY_DATABASE_RESERVED_SUFFIXES = ['.alt', '.arpa', '.onion', '.private', '.localdomain'];

export function parseProductionEnvContent(content) {
  return Object.fromEntries(
    String(content ?? '')
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

function parseEnvFile(path) {
  return parseProductionEnvContent(readFileSync(path, 'utf8'));
}

function envValue(env, key) {
  return env[key] ?? '';
}

function isConfigured(value) {
  const normalizedValue = value.toLowerCase();
  return (
    Boolean(value.trim()) &&
    !PLACEHOLDERS.some((placeholder) => normalizedValue.includes(placeholder.toLowerCase())) &&
    !COPIED_PLACEHOLDER_PATTERN.test(value)
  );
}

function isLocalHost(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal'].includes(normalizedHostname);
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

function isReservedDocumentationHostname(hostname) {
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

function isPublicHost(hostname) {
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

function canonicalAsciiDnsHostname(hostname) {
  const normalizedHostname = normaliseHostname(hostname);
  const asciiHostname = domainToASCII(normalizedHostname);
  return asciiHostname && asciiHostname === normalizedHostname ? asciiHostname : null;
}

function isSyntacticallyPublicCanonicalDnsHostname(hostname) {
  const asciiHostname = canonicalAsciiDnsHostname(hostname);
  if (!asciiHostname) return false;
  const topLevelLabel = asciiHostname.split('.').at(-1) ?? '';
  return (
    isDnsHostname(asciiHostname) &&
    isPublicHost(asciiHostname) &&
    /[a-z]/.test(topLevelLabel) &&
    !RECOVERY_DATABASE_RESERVED_SUFFIXES.some((suffix) => asciiHostname.endsWith(suffix))
  );
}

function isSafeRecoveryCaCertificatePath(value) {
  const normalizedCertificatePath = normalize(value);
  return (
    value !== 'system' &&
    value.length <= 1024 &&
    isAbsolute(value) &&
    normalizedCertificatePath === value &&
    !value.split(/[\\/]/).includes('..') &&
    /\.(?:crt|pem)$/i.test(value) &&
    (sep !== '\\' || /^[A-Za-z]:\\/.test(value))
  );
}

function isApprovedPublicHostname(hostname) {
  return isApprovedCharityPilotHostname(hostname);
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

function requireProductionDocumentStorageDriver(env, issues) {
  if (envValue(env, 'DOCUMENT_STORAGE_DRIVER').toLowerCase() === 'local') {
    issues.push('DOCUMENT_STORAGE_DRIVER must not be local for production; use Supabase document storage');
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
    const hostname = normaliseHostname(url.hostname);
    if (url.protocol !== 'https:') {
      issues.push(`${key} must use https:// for production`);
    }
    if (isLocalHost(hostname)) {
      issues.push(`${key} must not point at localhost for production`);
    }
    if (options.requireOrigin && (url.pathname !== '/' || url.search || url.hash)) {
      issues.push(`${key} must be an origin-only URL for production`);
    }
    if (options.requireApprovedPublicHost && !isApprovedPublicHostname(hostname)) {
      issues.push(`${key} must use an approved CharityPilot production hostname`);
    }
    if (options.canonicalOriginRole) {
      const issue = canonicalOriginIssue(key, url.origin, options.canonicalOriginRole);
      if (issue) issues.push(issue);
    }
    if (options.rejectSampleSupabaseProjectRef && hostname.endsWith('.supabase.co')) {
      const projectRef = hostname.slice(0, -'.supabase.co'.length);
      if (SAMPLE_SUPABASE_PROJECT_REF_PATTERN.test(projectRef)) {
        issues.push(`${key} must not use a sample Supabase project ref`);
      }
    }
    if (options.requirePublicHost && !isPublicHost(hostname) && !isLocalHost(hostname)) {
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
    if (isReservedDocumentationHostname(url.hostname)) {
      issues.push(`${key} must not use a reserved documentation hostname`);
    }
    if (
      url.hostname.includes(',') ||
      url.hostname !== normaliseHostname(url.hostname) ||
      !isSyntacticallyPublicCanonicalDnsHostname(url.hostname)
    ) {
      issues.push(`${key} hostname must be a syntactically public canonical ASCII DNS name`);
    }
    let databaseName = '';
    try {
      databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      // The authority-completeness issue below covers malformed path encoding.
    }
    if (!url.username || !databaseName || databaseName.includes('/')) {
      issues.push(`${key} must include a username and exactly one non-root database path segment`);
    }
    if (url.hash) {
      issues.push(`${key} must not contain a URL fragment`);
    }
    const seenOptions = new Set();
    for (const [rawName, optionValue] of url.searchParams) {
      const name = rawName.toLowerCase();
      if (rawName !== name || seenOptions.has(name)) {
        issues.push(`${key} must not repeat or ambiguously case connection option ${name}`);
      }
      seenOptions.add(name);
      if (!ALLOWED_LIBPQ_QUERY_OPTIONS.has(name)) {
        issues.push(`${key} contains unsupported or routing-sensitive connection option ${name}`);
      }
      if (name === 'channel_binding' && optionValue !== 'require') {
        issues.push(`${key} connection option channel_binding must equal require`);
      }
      if (name === 'sslrootcert' && !isSafeRecoveryCaCertificatePath(optionValue)) {
        issues.push(`${key} connection option sslrootcert must be a safe absolute .crt or .pem CA certificate path, never system`);
      }
      if (name === 'target_session_attrs' && optionValue !== 'read-write') {
        issues.push(`${key} connection option target_session_attrs must equal read-write`);
      }
      if (name === 'keepalives' && optionValue !== '0' && optionValue !== '1') {
        issues.push(`${key} connection option keepalives must equal 0 or 1`);
      }
      if (
        ['connect_timeout', 'keepalives_count', 'keepalives_idle', 'keepalives_interval', 'tcp_user_timeout'].includes(name) &&
        !/^(?:0|[1-9][0-9]{0,5})$/.test(optionValue)
      ) {
        issues.push(`${key} connection option ${name} must be a canonical integer from 0 to 999999`);
      }
      if (name === 'application_name' && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(optionValue)) {
        issues.push(`${key} connection option application_name must be a canonical 1 to 64 character identifier`);
      }
    }
    if (url.searchParams.get('sslmode') !== 'verify-full') {
      issues.push(`${key} must use exact lowercase sslmode=verify-full for production`);
    }
    if (url.searchParams.get('target_session_attrs') !== 'read-write') {
      issues.push(`${key} must explicitly set target_session_attrs=read-write for production`);
    }
  } catch {
    issues.push(`${key} must be a valid PostgreSQL connection URL`);
  }
}

function requireDocumentStorageRecoveryDatabaseHostAllowlist(env, issues) {
  const key = 'DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST';
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry)) {
    issues.push(`${key} must contain one or more nonempty comma-separated hostnames`);
    return;
  }

  const normalizedEntries = entries.map((entry) => normaliseHostname(entry));
  let hasNoncanonicalEntry = false;
  let hasUnsafeEntry = false;
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizedEntries[index];
    const asciiHostname = domainToASCII(normalized);
    if (entry !== entry.toLowerCase() || entry !== normalized || asciiHostname !== normalized) {
      hasNoncanonicalEntry = true;
    }
    if (
      entry.includes('*') ||
      isIP(normalized) !== 0 ||
      !isSyntacticallyPublicCanonicalDnsHostname(normalized)
    ) {
      hasUnsafeEntry = true;
    }
  }
  if (hasNoncanonicalEntry) {
    issues.push(`${key} entries must be canonical lowercase hostnames without a trailing dot`);
  }
  if (hasUnsafeEntry) {
    issues.push(`${key} entries must be public DNS hostnames in canonical ASCII form with valid IDNA, never wildcard, IP, local, private, or reserved names`);
  }

  if (new Set(normalizedEntries).size !== normalizedEntries.length) {
    issues.push(`${key} must not contain duplicate or trailing-dot-equivalent hostnames`);
  }

  try {
    const databaseHostname = normaliseHostname(new URL(envValue(env, 'DATABASE_URL')).hostname);
    if (databaseHostname && !normalizedEntries.includes(databaseHostname)) {
      issues.push(`${key} must include the exact DATABASE_URL hostname`);
    }
  } catch {
    // DATABASE_URL validity is reported by requireDatabaseUrl.
  }
}

function requireOptionalCanonicalIntegerRange(env, key, minimum, maximum, issues) {
  const value = envValue(env, key);
  if (!value) return;

  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    issues.push(`${key} must be a canonical integer from ${minimum} to ${maximum}`);
    return;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${key} must be a canonical integer from ${minimum} to ${maximum}`);
  }
}

function requirePrefix(env, key, prefix, label, issues) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;

  if (!value.startsWith(prefix)) {
    issues.push(`${key} must use a ${label}`);
  }
}

function requireAccessTokenExpiry(env, issues) {
  const value = envValue(env, 'JWT_EXPIRY').trim();
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

function requireRefreshTokenTtlDays(env, issues) {
  const value = envValue(env, 'REFRESH_TOKEN_TTL_DAYS').trim();
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

function looksLikeLowEntropyProductionSecret(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (!compact) return true;
  if (new Set(compact).size === 1) return true;
  return /(?:configured|example|sample|dummy|placeholder|change[-_]?me|already[-_]?generated|jwt[-_]?secret|readiness[-_]?key[-_]?32[-_]?chars)/i.test(normalized);
}

function requireProductionSecretStrength(env, key, issues, minimumLength = 32) {
  const value = envValue(env, key);
  if (!isConfigured(value)) return;
  if (value.length < minimumLength) {
    issues.push(`${key} must be at least ${minimumLength} characters`);
    return;
  }
  if (looksLikeLowEntropyProductionSecret(value)) {
    issues.push(`${key} must not be a repeated-character or sample value`);
  }
}

function requireCanonicalAuthRecoverySecret(env, issues) {
  const value = envValue(env, 'AUTH_RECOVERY_SECRET');
  if (!isConfigured(value)) return;
  let decoded;
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    decoded = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9_-]+$/.test(value)) {
    decoded = Buffer.from(value, 'base64url');
  } else {
    issues.push('AUTH_RECOVERY_SECRET must be canonical hex or base64url');
    return;
  }
  if (
    decoded.length < 32 ||
    decoded.length > 64 ||
    (value.toLowerCase() !== decoded.toString('hex') && value !== decoded.toString('base64url'))
  ) {
    issues.push('AUTH_RECOVERY_SECRET must canonically encode 32 to 64 high-entropy bytes');
  }
}

function hostMatchesCookieDomain(hostname, cookieDomain) {
  const normalizedHost = normaliseHostname(hostname);
  const normalizedDomain = cookieDomain.toLowerCase().replace(/^\./, '');

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function requireAuthCookieDomain(env, issues) {
  const frontendUrls = configuredUrls(env, 'FRONTEND_URL', { allowCommaSeparated: true });
  const apiUrls = configuredUrls(env, 'NEXT_PUBLIC_API_URL');
  if (!frontendUrls.length || !apiUrls.length) return;

  const apiHostname = normaliseHostname(apiUrls[0].hostname);
  const splitHostnames = frontendUrls.some((url) => normaliseHostname(url.hostname) !== apiHostname);
  const cookieDomain = envValue(env, 'AUTH_COOKIE_DOMAIN').trim();
  if (!isConfigured(cookieDomain)) {
    if (!splitHostnames) return;
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
    canonicalOriginRole: 'api',
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

function result(status, stdout = '', stderr = '', issues = []) {
  return { status, stdout, stderr, issues };
}

function redactPreflightTranscript(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'")]+/gi, '[redacted-database-url]')
    .replace(
      /\b((?:DATABASE_URL|JWT_SECRET|AUTH_RECOVERY_SECRET|READINESS_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_BILLING_PORTAL_CONFIGURATION_ID|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY|ERROR_ALERT_WEBHOOK_URL|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)=)[^\s'")]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]+/g, '[redacted-stripe-key]')
    .replace(/\bwhsec_[A-Za-z0-9_=-]+/g, '[redacted-stripe-webhook-secret]')
    .replace(/\bre_[A-Za-z0-9_=-]+/g, '[redacted-resend-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/apikey[=:]\s*[A-Za-z0-9._~+/=-]+/gi, 'apikey=[redacted]')
    .replace(/([?&](?:token|signature|key|apikey|access_token|refresh_token)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9._%+-]+:[^@\s'")]+@/g, '[redacted-credentials]@');
}

export function runProductionPreflight({ envFile = '.env.production', processEnv = process.env } = {}) {
  if (!existsSync(envFile)) {
    return result(1, '', `Production preflight failed: environment file not found: ${redactPreflightTranscript(envFile)}\n`);
  }

  const env = parseEnvFile(envFile);
  const issues = validateProductionEnvironment(env, processEnv);

  if (issues.length) {
    const stderr = [
      `Production preflight failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
      ...issues.map((issue) => `- ${issue}`),
      '',
    ].join('\n');
    return result(1, '', stderr, issues);
  }

  return result(0, `Production preflight passed using ${envFile}\n`);
}

export function validateProductionEnvContent(envContent, processEnv = process.env) {
  return validateProductionEnvironment(parseProductionEnvContent(envContent), processEnv);
}

export function validateProductionEnvironment(env, processEnv = process.env) {
  const runtimeWebApiUrlFromProcess = processEnv[COMPOSE_RUNTIME_WEB_API_URL] ?? '';
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
  requireDocumentStorageRecoveryDatabaseHostAllowlist(env, issues);
  requireOptionalCanonicalIntegerRange(env, 'STORAGE_DELETE_TIMEOUT_MS', 100, 8000, issues);
  requireOptionalCanonicalIntegerRange(env, 'SECURITY_EMAIL_PROVIDER_TIMEOUT_MS', 1000, 15000, issues);
  requireOptionalCanonicalIntegerRange(env, 'AUTH_DELIVERY_INTERVAL_MS', 1000, 60000, issues);
  requireOptionalCanonicalIntegerRange(env, 'AUTH_DELIVERY_BATCH_SIZE', 1, 100, issues);
  requireOptionalCanonicalIntegerRange(env, 'AUTH_DELIVERY_CLEANUP_BATCH_SIZE', 3, 1000, issues);
  requireOptionalCanonicalIntegerRange(env, 'AUTH_DELIVERY_STALE_SENDING_MS', 16000, 300000, issues);
  requirePrefix(env, 'STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
  requirePrefix(env, 'STRIPE_WEBHOOK_SECRET', 'whsec_', 'Stripe webhook signing secret', issues);
  for (const key of [
    'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
    'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
    'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
    'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  ]) {
    requirePrefix(env, key, 'price_', 'Stripe price ID', issues);
  }
  const stripePriceIds = [
    envValue(env, 'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID'),
    envValue(env, 'STRIPE_ESSENTIALS_YEARLY_PRICE_ID'),
    envValue(env, 'STRIPE_COMPLETE_MONTHLY_PRICE_ID'),
    envValue(env, 'STRIPE_COMPLETE_YEARLY_PRICE_ID'),
  ].filter(Boolean);
  if (new Set(stripePriceIds).size !== stripePriceIds.length) {
    issues.push('Stripe price IDs must be distinct for each plan and billing interval');
  }
  requirePrefix(
    env,
    'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
    'bpc_',
    'Stripe billing portal configuration ID',
    issues,
  );
  requirePrefix(env, 'RESEND_API_KEY', 're_', 'Resend API key', issues);
  requirePrefix(env, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_', 'live Stripe publishable key', issues);
  requireApprovedEmailSender(env, 'EMAIL_FROM', issues);
  requireAccessTokenExpiry(env, issues);
  requireRefreshTokenTtlDays(env, issues);

  requireProductionSecretStrength(env, 'JWT_SECRET', issues);
  requireProductionSecretStrength(env, 'READINESS_API_KEY', issues);
  requireProductionSecretStrength(env, 'AUTH_RECOVERY_SECRET', issues, 43);
  requireCanonicalAuthRecoverySecret(env, issues);
  const authRecoverySecret = envValue(env, 'AUTH_RECOVERY_SECRET');
  if (
    authRecoverySecret &&
    [envValue(env, 'JWT_SECRET'), envValue(env, 'READINESS_API_KEY')].includes(authRecoverySecret)
  ) {
    issues.push('AUTH_RECOVERY_SECRET must be distinct from JWT_SECRET and READINESS_API_KEY');
  }
  const securityEmailTimeoutRaw = envValue(env, 'SECURITY_EMAIL_PROVIDER_TIMEOUT_MS');
  const staleAuthDeliveryRaw = envValue(env, 'AUTH_DELIVERY_STALE_SENDING_MS');
  const securityEmailTimeout = Number(securityEmailTimeoutRaw);
  const staleAuthDelivery = Number(staleAuthDeliveryRaw);
  if (
    securityEmailTimeoutRaw !== '' &&
    staleAuthDeliveryRaw !== '' &&
    Number.isFinite(securityEmailTimeout) &&
    Number.isFinite(staleAuthDelivery) &&
    staleAuthDelivery <= securityEmailTimeout
  ) {
    issues.push('AUTH_DELIVERY_STALE_SENDING_MS must exceed SECURITY_EMAIL_PROVIDER_TIMEOUT_MS');
  }

  requireUrl(env, 'FRONTEND_URL', issues, {
    allowCommaSeparated: true,
    requireOrigin: true,
    requireApprovedPublicHost: true,
    canonicalOriginRole: 'web',
  });
  requireUrl(env, 'SUPABASE_URL', issues, { requirePublicHost: true, rejectSampleSupabaseProjectRef: true });
  requireProductionDocumentStorageDriver(env, issues);
  requireUrl(env, 'ERROR_ALERT_WEBHOOK_URL', issues, { requirePublicHost: true });
  requireUrl(env, 'NEXT_PUBLIC_API_URL', issues, {
    requireOrigin: true,
    requireApprovedPublicHost: true,
    canonicalOriginRole: 'api',
  });
  requireComposeRuntimeWebApiUrl(env, runtimeEnv, issues);
  requireAuthCookieDomain(env, issues);

  return issues;
}

export function runProductionPreflightFromArgs(args = process.argv.slice(2), processEnv = process.env) {
  for (const arg of args) {
    if (!arg.startsWith(ENV_FILE_FLAG)) {
      return result(2, '', `Unknown option: ${arg}\n${USAGE_TEXT}\n`);
    }
    if (arg.slice(ENV_FILE_FLAG.length).trim().length === 0) {
      return result(2, '', `${ENV_FILE_FLAG.slice(0, -1)} requires a value\n${USAGE_TEXT}\n`);
    }
  }

  const envFileArg = args.find((arg) => arg.startsWith(ENV_FILE_FLAG));
  const envFile = envFileArg ? envFileArg.slice(ENV_FILE_FLAG.length) : '.env.production';
  return runProductionPreflight({ envFile, processEnv });
}

function main() {
  const preflightResult = runProductionPreflightFromArgs();
  if (preflightResult.stdout) process.stdout.write(preflightResult.stdout);
  if (preflightResult.stderr) process.stderr.write(preflightResult.stderr);
  process.exit(preflightResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
