import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getRefreshTokenFromRequest } from '../utils/auth-cookies.js';
import { networkPrefix, presentedTokenFingerprint, sessionTraceRetentionDays,
  userAgentDigest } from '../services/session-security-trace.js';

/**
 * Writes one SessionSecurityTrace row per sign-in, refresh and sign-out
 * request, from an onResponse hook so the status code is known and every
 * outcome, including a refusal, is recorded. See
 * services/session-security-trace.ts for what is and is not kept.
 *
 * Registered only when a retention period is configured: with tracing off,
 * there is no hook at all.
 */
const TRACED_ROUTES = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/connector/login',
  '/api/v1/auth/connector/refresh',
  '/api/v1/auth/connector/logout',
]);

function presentedToken(request: FastifyRequest): string | undefined {
  const body = request.body as { refreshToken?: unknown } | undefined;
  if (typeof body?.refreshToken === 'string' && body.refreshToken.length > 0) return body.refreshToken;
  // Only the browser routes read the cookie; the connector scope has none.
  return request.routeOptions?.url?.startsWith('/api/v1/auth/connector/')
    ? undefined : getRefreshTokenFromRequest(request);
}

// Wrapped with fastify-plugin so the hook is not trapped in its own scope and
// silently sees no route at all.
export const sessionSecurityTracePlugin = fp(async (app: FastifyInstance) => {
  if (sessionTraceRetentionDays() === null) return;
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url;
    if (request.method !== 'POST' || !route || !TRACED_ROUTES.has(route)) return;
    try {
      const token = route.endsWith('/login') ? undefined : presentedToken(request);
      await request.server.prisma.sessionSecurityTrace.create({ data: {
        routePattern: route,
        statusCode: reply.statusCode,
        requestId: String(request.id).slice(0, 128),
        presentedTokenFingerprint: token ? presentedTokenFingerprint(token) : null,
        networkPrefix: networkPrefix(request.ip),
        userAgentDigest: userAgentDigest(request.headers['user-agent']),
      } });
    } catch (error) {
      // The response has already been sent. A lost trace row is logged, but it
      // must never turn a completed sign-in or refresh into an error.
      request.log.error({ err: error, routePattern: route }, 'Failed to record session security trace');
    }
  });
});
