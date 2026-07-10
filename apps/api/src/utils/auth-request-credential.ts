import type { FastifyRequest } from "fastify";
import { ACCESS_TOKEN_COOKIE } from "./auth-cookie-names.js";

export function parseBearerAuthorizationHeader(
  value: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") return undefined;

  const bearerMatch = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return bearerMatch?.[1];
}

export function getAccessTokenFromRequest(
  request: FastifyRequest,
): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader !== undefined) {
    // Authentication schemes are case-insensitive. When an Authorization
    // header is present it is authoritative: a malformed or unsupported value
    // must not silently fall back to a valid cookie, otherwise the auth guard
    // and any credential-keyed rate limiter can be made to inspect different
    // credentials.
    return parseBearerAuthorizationHeader(authHeader);
  }

  const accessCookie = request.cookies?.[ACCESS_TOKEN_COOKIE]?.trim();
  return accessCookie || undefined;
}
