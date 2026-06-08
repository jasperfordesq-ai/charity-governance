import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

export const securityHeadersPlugin = fp(async (app: FastifyInstance) => {
  const isProduction = process.env.NODE_ENV === 'production';

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (reply.getHeader('Cache-Control') === undefined) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }
    if (reply.getHeader('Content-Security-Policy') === undefined) {
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
    if (isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    return payload;
  });
});
