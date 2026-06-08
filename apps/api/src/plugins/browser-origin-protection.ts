import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { normaliseOrigin, validateUnsafeRequestOrigin } from '../utils/request-origin.js';

export async function registerBrowserOriginProtection(
  app: FastifyInstance,
  allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const originValidation = validateUnsafeRequestOrigin(request, allowedOrigins);
    if (!originValidation.ok) {
      return reply.status(originValidation.statusCode).send(originValidation.payload);
    }
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(normaliseOrigin(origin))) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
}
