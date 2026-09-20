import type { FastifyRequest } from "fastify";
import { parseBearerAuthorizationHeader } from "./auth-request-credential.js";
import { verifyAccessToken } from "./jwt.js";

/**
 * What the shared limiter counts against.
 *
 * The connector runs on the owner's machine, behind the owner's address, so
 * every read it makes used to spend the same hundred-a-minute allowance as the
 * browser tab beside it. An agent in a read loop could therefore lock the
 * owner out of their own web session. `connector-write-budget.ts` closed that
 * for writes and said so; this closes it for reads, which is the limitation
 * that plugin's comment names.
 *
 * A request carrying a bearer token that **verifies** is counted against its
 * own session instead of its address. Verification matters: keying on the
 * token as presented would let anyone evade the address bucket entirely by
 * sending a different invented bearer value on every request. A signature
 * cannot be invented, so an unauthenticated caller always falls back to the
 * address, and the limiter it faces is unchanged.
 *
 * Only the signature is checked, never the session row. That is the whole
 * point: this runs before any database work, so a flood is turned away without
 * one. A revoked session therefore keeps its own bucket until its access token
 * expires, which costs nothing — the auth guard refuses every one of those
 * requests a moment later.
 *
 * The web application is unaffected. It authenticates with a cookie, so its
 * requests carry no Authorization header and stay on the address bucket they
 * have always been on.
 *
 * The bucket resets when the session rotates, every fifteen minutes. That is
 * the same trade the write budget makes, for the same reason: a limiter that
 * outlived the thing it limits would be new persistent state to reason about,
 * and forgiving a loop its last few reads costs nothing.
 */
export function sessionOrAddressRateLimitKey(request: FastifyRequest): string {
  const token = parseBearerAuthorizationHeader(request.headers.authorization);
  if (token === undefined) return request.ip;

  try {
    // Prefixed so a session identifier can never collide with an address.
    return `session:${verifyAccessToken(token).sessionId}`;
  } catch {
    return request.ip;
  }
}
