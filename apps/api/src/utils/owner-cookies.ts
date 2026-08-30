import type { FastifyReply, FastifyRequest } from 'fastify';
import { operatorRefreshMaxAgeSeconds } from '../services/operator-session.service.js';
import { personalServerAllowsInsecureCookies } from './personal-server.js';

export const OWNER_ACCESS_TOKEN_COOKIE = 'charitypilot_owner_access';
export const OWNER_REFRESH_TOKEN_COOKIE = 'charitypilot_owner_refresh';

// Scoped to the owner API path so the cookie is never transmitted on ordinary
// tenant requests.
const OWNER_COOKIE_PATH = '/api/v1/owner';

function ownerCookieOptions(maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' && !personalServerAllowsInsecureCookies();
  return {
    path: OWNER_COOKIE_PATH,
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    maxAge,
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  };
}

export function setOwnerCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
): void {
  reply.setCookie(OWNER_ACCESS_TOKEN_COOKIE, tokens.accessToken, ownerCookieOptions(30 * 60));
  reply.setCookie(OWNER_REFRESH_TOKEN_COOKIE, tokens.refreshToken, ownerCookieOptions(operatorRefreshMaxAgeSeconds()));
}

export function clearOwnerCookies(reply: FastifyReply): void {
  const options = ownerCookieOptions(0);
  reply.clearCookie(OWNER_ACCESS_TOKEN_COOKIE, options);
  reply.clearCookie(OWNER_REFRESH_TOKEN_COOKIE, options);
}

export function getOwnerRefreshTokenFromRequest(request: FastifyRequest): string | undefined {
  return request.cookies?.[OWNER_REFRESH_TOKEN_COOKIE];
}

export function getOwnerAccessTokenFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return request.cookies?.[OWNER_ACCESS_TOKEN_COOKIE];
}
