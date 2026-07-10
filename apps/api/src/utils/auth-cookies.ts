import type { FastifyReply, FastifyRequest } from "fastify";
import { refreshTokenMaxAgeSeconds } from "../services/session-tokens.js";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from "./auth-cookie-names.js";

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
export { getAccessTokenFromRequest } from "./auth-request-credential.js";

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

function commonCookieOptions(maxAge: number) {
  const secure = process.env.NODE_ENV === "production";
  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge,
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  };
}

export function setAuthCookies(reply: FastifyReply, tokens: AuthTokens): void {
  reply.setCookie(
    ACCESS_TOKEN_COOKIE,
    tokens.accessToken,
    commonCookieOptions(15 * 60),
  );
  reply.setCookie(
    REFRESH_TOKEN_COOKIE,
    tokens.refreshToken,
    commonCookieOptions(refreshTokenMaxAgeSeconds()),
  );
}

export function clearAuthCookies(reply: FastifyReply): void {
  const options = commonCookieOptions(0);
  reply.clearCookie(ACCESS_TOKEN_COOKIE, options);
  reply.clearCookie(REFRESH_TOKEN_COOKIE, options);
}

export function getRefreshTokenFromRequest(
  request: FastifyRequest,
): string | undefined {
  return request.cookies?.[REFRESH_TOKEN_COOKIE];
}
