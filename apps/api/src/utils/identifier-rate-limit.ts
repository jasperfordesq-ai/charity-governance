import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie-names.js';

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function normaliseIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 320) : null;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function requestCookieValue(request: FastifyRequest, name: string): string | undefined {
  const cookieHeader = typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
  return request.cookies?.[name]?.trim()
    ?? cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim();
}

function requestCredentialIdentifier(request: FastifyRequest): string {
  const authHeader = request.headers.authorization;
  const bearerMatch = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader.trim()) : null;
  const bearerToken = bearerMatch?.[1]?.trim();
  const accessCookie = requestCookieValue(request, ACCESS_TOKEN_COOKIE);
  const credential = bearerToken || accessCookie || 'missing-auth-credential';

  return digest(credential.slice(0, 4096));
}

function refreshTokenIdentifier(request: FastifyRequest): string {
  const body = bodyRecord(request);
  const bodyToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
  const cookieToken = requestCookieValue(request, REFRESH_TOKEN_COOKIE);
  const credential = bodyToken || cookieToken || 'missing-refresh-token';

  return digest(credential.slice(0, 4096));
}

export function bodyIdentifierRateLimit(fields: string[], max = 5) {
  return {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator(request: FastifyRequest) {
      const body = bodyRecord(request);
      const identifier = fields
        .map((field) => normaliseIdentifier(body[field]))
        .find((value): value is string => Boolean(value)) ?? 'missing-identifier';

      return `${request.ip}:${digest(identifier)}`;
    },
  };
}

export function authCredentialRateLimit(max = 5) {
  return {
    max,
    timeWindow: '1 minute',
    hook: 'onRequest' as const,
    keyGenerator(request: FastifyRequest) {
      return `${request.ip}:${requestCredentialIdentifier(request)}`;
    },
  };
}

export function refreshTokenRateLimit(max = 5) {
  return {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator(request: FastifyRequest) {
      return `${request.ip}:${refreshTokenIdentifier(request)}`;
    },
  };
}
