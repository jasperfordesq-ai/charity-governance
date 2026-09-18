import type { FastifyServerOptions } from 'fastify';
import { formatProviderError, sanitizeProviderDiagnosticText } from './provider-errors.js';

export const LOG_REDACT_CENSOR = '[redacted]';

export const API_LOG_REDACT_PATHS = [
  'authorization',
  'cookie',
  'cookies',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["stripe-signature"]',
  'headers["x-charitypilot-readiness-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["stripe-signature"]',
  'req.headers["x-charitypilot-readiness-key"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["set-cookie"]',
  'request.headers["stripe-signature"]',
  'request.headers["x-charitypilot-readiness-key"]',
  'body.password',
  'body.passwordHash',
  'body.token',
  'body.accessToken',
  'body.refreshToken',
  'body.resetToken',
  'body.verifyToken',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'resetToken',
  'verifyToken',
  'stripeSignature',
  'env.DATABASE_URL',
  'env.JWT_SECRET',
  'env.AUTH_RECOVERY_SECRET',
  'env.STRIPE_SECRET_KEY',
  'env.STRIPE_WEBHOOK_SECRET',
  'env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
  'env.RESEND_API_KEY',
  'env.SUPABASE_SERVICE_ROLE_KEY',
  'env.ERROR_ALERT_WEBHOOK_URL',
  'env.ATLASSIAN_CLIENT_SECRET',
] as const;

function errorField(error: unknown, field: string): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === 'number') return value;
  return typeof value === 'string' ? sanitizeProviderDiagnosticText(value) : undefined;
}

function errorCause(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'cause')) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? undefined : cause;
}

export function serializeErrorForLog(error: unknown): Record<string, unknown> & {
  type: string;
  message: string;
  stack: string;
} {
  const name = error instanceof Error && error.name ? error.name : 'Error';
  const code = errorField(error, 'code');
  const statusCode = errorField(error, 'statusCode') ?? errorField(error, 'status');
  const providerError = formatProviderError(error);
  const cause = errorCause(error);

  return {
    type: name,
    name,
    message: providerError,
    stack: LOG_REDACT_CENSOR,
    ...(code ? { code } : {}),
    ...(statusCode ? { statusCode } : {}),
    providerError,
    ...(cause !== undefined ? { cause: formatProviderError(cause) } : {}),
  };
}

/**
 * Query parameters whose VALUE is a credential.
 *
 * Fastify's request logger writes `req.url` verbatim on every request, query
 * string included, and pino's `redact` can only censor a whole field — so
 * without this the OAuth callback's single-use `code` (and the signed `state`
 * that authorises it) would be written to the application log on every
 * Confluence connection. `buildErrorAlertPayload` already strips the query
 * string for the same reason; this closes the same hole on the request log.
 *
 * Matched case-insensitively against the decoded parameter name.
 */
const LOG_SENSITIVE_QUERY_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'assertion',
]);

/**
 * Censor the values of sensitive query parameters in a URL, leaving every
 * other byte of it exactly as it was.
 *
 * Deliberately string surgery rather than a `URL`/`URLSearchParams`
 * round-trip: a round-trip re-encodes the whole query string, which would
 * silently change how every *existing* logged URL appears. Only the value of
 * a matching key is replaced.
 */
export function redactSensitiveQueryParams(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const prefix = url.slice(0, queryStart);
  const [query, ...fragment] = url.slice(queryStart + 1).split('#');

  const censored = (query ?? '')
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator === -1) return pair;
      const rawKey = pair.slice(0, separator);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        key = rawKey;
      }
      return LOG_SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())
        ? `${rawKey}=${LOG_REDACT_CENSOR}`
        : pair;
    })
    .join('&');

  return `${prefix}?${censored}${fragment.length > 0 ? `#${fragment.join('#')}` : ''}`;
}

/**
 * Mirrors Fastify's own `req` serializer field for field (see
 * `fastify/lib/logger-pino.js`), changing only the URL.
 */
function serializeRequestForLog(request: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}): Record<string, unknown> {
  return {
    method: request.method,
    url: typeof request.url === 'string' ? redactSensitiveQueryParams(request.url) : request.url,
    version: request.headers?.['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket ? request.socket.remotePort : undefined,
  };
}

function baseLoggerOptions() {
  return {
    redact: {
      paths: [...API_LOG_REDACT_PATHS],
      censor: LOG_REDACT_CENSOR,
    },
    serializers: {
      err: serializeErrorForLog,
      error: serializeErrorForLog,
      req: serializeRequestForLog,
    },
  };
}

export function apiLoggerOptionsForEnvironment(
  environment = process.env.NODE_ENV ?? 'development',
): FastifyServerOptions['logger'] {
  if (environment === 'test') return false;

  if (environment === 'development') {
    return {
      ...baseLoggerOptions(),
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    };
  }

  return baseLoggerOptions();
}
