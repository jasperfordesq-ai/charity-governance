import type { FastifyRequest } from 'fastify';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie-names.js';

type OriginValidationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: 403;
      payload: {
        error: string;
        code: 'INVALID_ORIGIN' | 'MISSING_ORIGIN';
      };
    };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_COOKIE_SETTING_PATH_SUFFIXES = [
  '/auth/login',
  '/auth/refresh',
  '/team/accept-invite',
] as const;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, '');
  }
}

function hasBearerAuthorization(request: Pick<FastifyRequest, 'headers'>): boolean {
  const authorization = headerValue(request.headers.authorization);
  return authorization?.startsWith('Bearer ') === true;
}

function hasAuthCookie(request: Pick<FastifyRequest, 'cookies'>): boolean {
  return Boolean(request.cookies?.[ACCESS_TOKEN_COOKIE] || request.cookies?.[REFRESH_TOKEN_COOKIE]);
}

function requestPath(request: Pick<FastifyRequest, 'url'>): string {
  try {
    return new URL(request.url, 'http://charitypilot.local').pathname;
  } catch {
    return request.url.split('?')[0] ?? request.url;
  }
}

function isAuthCookieSettingPath(request: Pick<FastifyRequest, 'url'>): boolean {
  const path = requestPath(request).replace(/\/+$/, '');
  return AUTH_COOKIE_SETTING_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

export function validateUnsafeRequestOrigin(
  request: Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'cookies'>,
  allowedOrigins: ReadonlySet<string>,
): OriginValidationResult {
  if (SAFE_METHODS.has(request.method)) {
    return { ok: true };
  }

  const origin = headerValue(request.headers.origin);
  if (origin) {
    if (allowedOrigins.has(normaliseOrigin(origin))) {
      return { ok: true };
    }

    return {
      ok: false,
      statusCode: 403,
      payload: {
        error: 'Invalid request origin',
        code: 'INVALID_ORIGIN',
      },
    };
  }

  if (isAuthCookieSettingPath(request) || (hasAuthCookie(request) && !hasBearerAuthorization(request))) {
    return {
      ok: false,
      statusCode: 403,
      payload: {
        error: 'Missing request origin',
        code: 'MISSING_ORIGIN',
      },
    };
  }

  return { ok: true };
}
