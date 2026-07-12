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

function baseLoggerOptions() {
  return {
    redact: {
      paths: [...API_LOG_REDACT_PATHS],
      censor: LOG_REDACT_CENSOR,
    },
    serializers: {
      err: serializeErrorForLog,
      error: serializeErrorForLog,
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
