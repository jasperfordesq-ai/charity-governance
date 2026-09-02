import { isIP } from 'node:net';
import { posix, win32 } from 'node:path';
import { AppError } from './errors.js';
import { parsePort } from './port.js';
import { isConfiguredSecret } from './secrets.js';
import { billingMode, emailDeliveryMode, isMultiTenant } from './deployment-profile.js';

export { isConfiguredSecret } from './secrets.js';

const APPROVED_PUBLIC_HOST_ROOT = 'charitypilot.ie';
// Defaults only. CHARITYPILOT_CANONICAL_WEB_ORIGIN / CHARITYPILOT_CANONICAL_API_ORIGIN
// (see canonicalOrigin below) let a non-charitypilot.ie deployment (e.g. the
// private VM, reached over a Tailscale/VPN hostname) override these; with
// both vars unset or empty, every hosted-SaaS install keeps today's exact
// hardcoded origins byte-for-byte.
const DEFAULT_CANONICAL_WEB_ORIGIN = 'https://app.charitypilot.ie';
const DEFAULT_CANONICAL_API_ORIGIN = 'https://api.charitypilot.ie';
const MAX_ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60;
const MAX_REFRESH_TOKEN_TTL_DAYS = 30;
const MIN_AUTH_RECOVERY_SECRET_LENGTH = 43;
const LOCAL_STORAGE_DRIVER = 'local';
// Mirrors personal-server-env.ts's CONTROL_CHARACTERS exactly, so both
// validators demand the same shape from a local storage path. Duplicated
// rather than imported: personal-server-env.ts imports validateProductionEnv
// from this module, so importing back would be circular.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function isCiProductionSmokeLocalDatabaseAllowed(): boolean {
  return (
    process.env.CHARITYPILOT_ALLOW_LOCAL_DATABASE_FOR_CI_SMOKE === 'true' &&
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true'
  );
}

function canonicalOriginEnvName(role: 'web' | 'api'): string {
  return role === 'web' ? 'CHARITYPILOT_CANONICAL_WEB_ORIGIN' : 'CHARITYPILOT_CANONICAL_API_ORIGIN';
}

function canonicalOriginDefault(role: 'web' | 'api'): string {
  return role === 'web' ? DEFAULT_CANONICAL_WEB_ORIGIN : DEFAULT_CANONICAL_API_ORIGIN;
}

type CanonicalOriginOverride =
  | { kind: 'unset' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; origin: string; hostname: string };

// Empty string counts as unset (P1 fix-wave convention: Docker ARG/ENV pairs
// and similar templating can only express "unset" as ''), not as an error.
// Pure parse, no side effects — callers decide whether/how to surface an
// invalid override as an issue (resolveCanonicalOrigin does; the auth-cookie
// -domain check below reads only the valid case and stays silent, since a
// sibling requireUrl(..., { canonicalOriginRole }) call already reports the
// same invalid override once).
function parseCanonicalOriginOverride(role: 'web' | 'api'): CanonicalOriginOverride {
  const name = canonicalOriginEnvName(role);
  const raw = process.env[name];
  if (raw === undefined || raw === '') return { kind: 'unset' };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== raw) {
      return { kind: 'invalid', message: `${name} must be an exact https origin (no path, no trailing slash)` };
    }
    return { kind: 'valid', origin: url.origin, hostname: normaliseHostname(url.hostname) };
  } catch {
    return { kind: 'invalid', message: `${name} must be a valid https origin` };
  }
}

function resolveCanonicalOrigin(role: 'web' | 'api', issues: string[]): { origin: string; overridden: boolean } {
  const parsed = parseCanonicalOriginOverride(role);
  if (parsed.kind === 'valid') return { origin: parsed.origin, overridden: true };
  if (parsed.kind === 'invalid') issues.push(parsed.message);
  return { origin: canonicalOriginDefault(role), overridden: false };
}

// Silent variant for requireAuthCookieDomain: it needs the configured
// override's hostname (when validly overridden) without re-pushing the
// invalid-override issue a sibling requireUrl(..., { canonicalOriginRole })
// call already reported for the same variable.
function canonicalOriginHostnameIfValid(role: 'web' | 'api'): string | undefined {
  const parsed = parseCanonicalOriginOverride(role);
  return parsed.kind === 'valid' ? parsed.hostname : undefined;
}

function errorAlertsMode(issues: string[]): 'webhook' | 'none' {
  const raw = process.env.CHARITYPILOT_ERROR_ALERTS;
  if (raw === undefined || raw === '') return 'webhook';
  if (raw !== 'webhook' && raw !== 'none') {
    issues.push(`CHARITYPILOT_ERROR_ALERTS must be webhook | none (got ${JSON.stringify(raw)})`);
    return 'webhook';
  }
  return raw;
}

// The runtime already degrades gracefully when the webhook is unconfigured:
// shouldSendErrorAlert (error-alerts.service.ts) returns false whenever
// ERROR_ALERT_WEBHOOK_URL isn't a configured secret, so sendErrorAlert is
// already a no-op in that case. No runtime/service change is needed to
// support CHARITYPILOT_ERROR_ALERTS=none — this only relaxes BOOT-TIME
// validation (this function, called from all four validators below) to stop
// demanding a webhook that the deployment has deliberately opted out of. If
// the var IS set under alerts=none anyway, its shape is still validated
// (an operator who bothered to set it gets real feedback on typos).
function requireErrorAlertWebhook(issues: string[]): void {
  const mode = errorAlertsMode(issues);
  if (mode === 'none' && !isConfiguredSecret(process.env.ERROR_ALERT_WEBHOOK_URL)) {
    return;
  }
  requireUrl('ERROR_ALERT_WEBHOOK_URL', issues, { requireHttps: true, requirePublicHost: true });
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
  // Resolved once per requireUrl call (see below), not once per
  // comma-separated value: canonicalOrigin resolution can push an issue for
  // a malformed override, and re-resolving per value would duplicate that
  // issue once per entry in a multi-value FRONTEND_URL.
  resolvedCanonical?: { origin: string; overridden: boolean },
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
    // A canonical-origin override (CHARITYPILOT_CANONICAL_WEB_ORIGIN /
    // _API_ORIGIN) is deliberately allowed to sit outside the
    // charitypilot.ie zone (e.g. a Tailscale hostname for the private VM).
    // When one is configured, the exact-origin match below is a strictly
    // narrower check than "hostname is under the approved public host root"
    // — so it fully replaces that gate for this field, rather than stacking
    // an incompatible extra restriction on top of it. With no override (the
    // default), resolvedCanonical.overridden is false and
    // requireApprovedPublicHost behaves exactly as before.
    if (options.canonicalOriginRole && resolvedCanonical) {
      const label = options.canonicalOriginRole === 'api' ? 'API' : 'web';
      if (url.origin !== resolvedCanonical.origin) {
        issues.push(`${name} must use the canonical production ${label} origin ${resolvedCanonical.origin}`);
      }
    }
    if (
      options.requireApprovedPublicHost &&
      !resolvedCanonical?.overridden &&
      !isApprovedPublicHostname(url.hostname)
    ) {
      issues.push(`${name} must use an approved CharityPilot production hostname`);
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

  const resolvedCanonical = options.canonicalOriginRole
    ? resolveCanonicalOrigin(options.canonicalOriginRole, issues)
    : undefined;

  for (const urlValue of values) {
    validateUrlValue(name, urlValue, issues, options, resolvedCanonical);
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
    if (!(allowCiSmokeLocalDatabase && localDatabaseHost)) {
      const sslModes = url.searchParams.getAll('sslmode');
      if (sslModes.length !== 1 || sslModes[0] !== 'verify-full') {
        issues.push(`${name} must use exact lowercase sslmode=verify-full in production`);
      }

      const targetSessionAttrs = url.searchParams.getAll('target_session_attrs');
      if (targetSessionAttrs.length !== 1 || targetSessionAttrs[0] !== 'read-write') {
        issues.push(`${name} must explicitly set target_session_attrs=read-write in production`);
      }
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

function requireOptionalCanonicalIntegerRange(
  name: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}`);
    return undefined;
  }
  return value;
}

function requireAuthRecoverySecret(issues: string[]): void {
  const secret = requireConfiguredEnv('AUTH_RECOVERY_SECRET', issues);
  if (!secret) return;
  if (secret.length < MIN_AUTH_RECOVERY_SECRET_LENGTH) {
    issues.push(
      `AUTH_RECOVERY_SECRET must be at least ${MIN_AUTH_RECOVERY_SECRET_LENGTH} characters`,
    );
  }
  if (secret === process.env.JWT_SECRET || secret === process.env.READINESS_API_KEY) {
    issues.push('AUTH_RECOVERY_SECRET must be distinct from JWT_SECRET and READINESS_API_KEY');
  }
  let decoded: Buffer;
  if (/^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0) {
    decoded = Buffer.from(secret, 'hex');
  } else if (/^[A-Za-z0-9_-]+$/.test(secret)) {
    decoded = Buffer.from(secret, 'base64url');
  } else {
    issues.push('AUTH_RECOVERY_SECRET must be canonical hex or base64url');
    return;
  }
  if (
    decoded.length < 32 ||
    decoded.length > 64 ||
    (secret.toLowerCase() !== decoded.toString('hex') &&
      secret !== decoded.toString('base64url'))
  ) {
    issues.push('AUTH_RECOVERY_SECRET must canonically encode 32 to 64 high-entropy bytes');
  }
}

function validateAuthDeliveryNumericEnv(issues: string[]): void {
  const providerTimeout = requireOptionalCanonicalIntegerRange(
    'SECURITY_EMAIL_PROVIDER_TIMEOUT_MS',
    1_000,
    15_000,
    issues,
  );
  requireOptionalCanonicalIntegerRange('AUTH_DELIVERY_INTERVAL_MS', 1_000, 60_000, issues);
  requireOptionalCanonicalIntegerRange('AUTH_DELIVERY_BATCH_SIZE', 1, 100, issues);
  requireOptionalCanonicalIntegerRange('AUTH_DELIVERY_CLEANUP_BATCH_SIZE', 3, 1_000, issues);
  const staleSendingMs = requireOptionalCanonicalIntegerRange(
    'AUTH_DELIVERY_STALE_SENDING_MS',
    16_000,
    300_000,
    issues,
  );
  if (
    providerTimeout !== undefined &&
    staleSendingMs !== undefined &&
    staleSendingMs <= providerTimeout
  ) {
    issues.push('AUTH_DELIVERY_STALE_SENDING_MS must exceed SECURITY_EMAIL_PROVIDER_TIMEOUT_MS');
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

// Mirrors validatePersonalServerEnv's requireAbsoluteLocalStoragePath path
// check (personal-server-env.ts) so a self-contained multi-tenant deployment
// demands the same local storage path shape as the single-tenant appliance.
// The driver-equals-local check itself isn't repeated here: this is only
// reached from a DOCUMENT_STORAGE_DRIVER === local branch (validateProductionEnv's
// and validateDocumentStorageCleanupEnv's), so it's already established.
function requireLocalStoragePath(issues: string[]): void {
  const value = process.env.LOCAL_FILE_STORAGE_DIR;
  if (
    !value ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value) ||
    (!posix.isAbsolute(value) && !win32.isAbsolute(value)) ||
    value === posix.parse(value).root ||
    value === win32.parse(value).root
  ) {
    issues.push('LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path');
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
  // A canonical-origin override doesn't just relax FRONTEND_URL/
  // NEXT_PUBLIC_API_URL's own approved-host gate (see validateUrlValue) — it
  // must also let AUTH_COOKIE_DOMAIN cover the CONFIGURED origins'
  // hostnames, or a split-hostname override could never construct a
  // passing AUTH_COOKIE_DOMAIN at all. With no override (the default), both
  // canonicalOriginHostnameIfValid calls return undefined and this is
  // exactly isApprovedPublicHostname as before.
  const webOverrideHostname = canonicalOriginHostnameIfValid('web');
  const apiOverrideHostname = canonicalOriginHostnameIfValid('api');
  // M3 fix: hostMatchesCookieDomain alone accepts ANY suffix relationship,
  // including a registrable parent as shallow as a bare TLD-like single
  // label (AUTH_COOKIE_DOMAIN=example would otherwise cover
  // vm.tailnet.example). Tightened: an exact match to the override
  // hostname is always fine; a suffix match is only fine when the cookie
  // domain itself contains at least one dot (so it can never be a bare
  // top-level label) — the override hostname then necessarily has at
  // least one additional label beyond it, which is exactly what
  // `endsWith('.' + cookieDomain)` already proves.
  const coversOverride = (hostname: string | undefined) => {
    if (hostname === undefined) return false;
    if (hostname === normalizedCookieDomain) return true;
    return normalizedCookieDomain.includes('.') && hostname.endsWith(`.${normalizedCookieDomain}`);
  };
  if (
    !isApprovedPublicHostname(normalizedCookieDomain) &&
    !coversOverride(webOverrideHostname) &&
    !coversOverride(apiOverrideHostname)
  ) {
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
  // Mirrors validateProductionEnv's storage branch exactly (same condition,
  // same two arms). The cleanup job deletes through StorageService.deleteFile,
  // which itself branches on DOCUMENT_STORAGE_DRIVER and unlinks from
  // LOCAL_FILE_STORAGE_DIR under the local driver (storage.service.ts:270-279)
  // — so demanding Supabase credentials here only blocked a self-contained
  // deployment (the private VM) from starting the scheduler at all, since
  // production-scheduler.ts's main() calls this validator at startup.
  if (process.env.DOCUMENT_STORAGE_DRIVER === LOCAL_STORAGE_DRIVER) {
    requireLocalStoragePath(issues);
  } else {
    requireUrl('SUPABASE_URL', issues, { requireHttps: true, requirePublicHost: true });
    requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
    requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);
    requireProductionDocumentStorageDriver(issues);
  }
  requireErrorAlertWebhook(issues);

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
  // Deadline reminders/auth-delivery emails have no manual-link fallback
  // at the point of sending (unlike password-recovery/team-invite flows,
  // which show a link in the UI instead of emailing) — but a manual-link
  // deployment never even attempts to send through this path (see
  // DeadlineRemindersService.sendDueReminders and password-recovery
  // .service.ts's PASSWORD_RESET_COMPLETED_NOTICE enqueue, both keyed on
  // this same axis), so requiring provider credentials here regardless of
  // mode would only block a deployment that will never use them. Mirrors
  // validateProductionEnv's identical gate exactly.
  if (emailDeliveryMode() === 'provider') {
    requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
    requireApprovedEmailSender('EMAIL_FROM', issues);
  }
  requireErrorAlertWebhook(issues);

  throwIfProductionIssues(
    'DEADLINE_REMINDERS_ENV_INVALID',
    'Deadline reminders environment is not ready',
    issues,
  );
}

export function validateAuthDeliveryEnv(): void {
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
  // Deadline reminders/auth-delivery emails have no manual-link fallback
  // at the point of sending (unlike password-recovery/team-invite flows,
  // which show a link in the UI instead of emailing) — but a manual-link
  // deployment never even attempts to send through this path (see
  // DeadlineRemindersService.sendDueReminders and password-recovery
  // .service.ts's PASSWORD_RESET_COMPLETED_NOTICE enqueue, both keyed on
  // this same axis), so requiring provider credentials here regardless of
  // mode would only block a deployment that will never use them. Mirrors
  // validateProductionEnv's identical gate exactly.
  if (emailDeliveryMode() === 'provider') {
    requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
    requireApprovedEmailSender('EMAIL_FROM', issues);
  }
  requireErrorAlertWebhook(issues);
  requireAuthRecoverySecret(issues);
  validateAuthDeliveryNumericEnv(issues);

  throwIfProductionIssues(
    'AUTH_DELIVERY_ENV_INVALID',
    'Authentication email delivery environment is not ready',
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
  if (isMultiTenant()) {
    requireMinLength('OWNER_JWT_SECRET', 32, issues);
    if (
      process.env.OWNER_JWT_SECRET &&
      process.env.JWT_SECRET &&
      process.env.OWNER_JWT_SECRET === process.env.JWT_SECRET
    ) {
      issues.push('OWNER_JWT_SECRET must be distinct from JWT_SECRET');
    }
  }
  requireAuthRecoverySecret(issues);
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

  if (billingMode() === 'stripe') {
    requirePrefix('STRIPE_SECRET_KEY', 'sk_live_', 'live Stripe secret key', issues);
    requirePrefix('STRIPE_WEBHOOK_SECRET', 'whsec_', 'Stripe webhook signing secret', issues);
    requirePrefix('STRIPE_ESSENTIALS_MONTHLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
    requirePrefix('STRIPE_ESSENTIALS_YEARLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
    requirePrefix('STRIPE_COMPLETE_MONTHLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
    requirePrefix('STRIPE_COMPLETE_YEARLY_PRICE_ID', 'price_', 'Stripe price ID', issues);
    requirePrefix(
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
      'bpc_',
      'Stripe billing portal configuration ID',
      issues,
    );

    const stripePriceIds = [
      process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID,
      process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID,
      process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID,
      process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID,
    ].filter((value): value is string => Boolean(value));
    if (new Set(stripePriceIds).size !== stripePriceIds.length) {
      issues.push('Stripe price IDs must be distinct for each plan and billing interval');
    }
  }

  if (emailDeliveryMode() === 'provider') {
    requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
    requireApprovedEmailSender('EMAIL_FROM', issues);
  }
  validateAuthDeliveryNumericEnv(issues);

  if (process.env.DOCUMENT_STORAGE_DRIVER === LOCAL_STORAGE_DRIVER) {
    requireLocalStoragePath(issues);
  } else {
    requireUrl('SUPABASE_URL', issues, { requireHttps: true, requirePublicHost: true });
    requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
    requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);
    requireProductionDocumentStorageDriver(issues);
  }
  requireErrorAlertWebhook(issues);

  throwIfProductionIssues('PRODUCTION_ENV_INVALID', 'Production environment is not ready', issues);
}
