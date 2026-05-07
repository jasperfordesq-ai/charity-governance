import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, type TokenPayload } from '../utils/jwt.js';
import { getAccessTokenFromRequest } from '../utils/auth-cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: TokenPayload;
  }
}

export async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = bearerToken ?? getAccessTokenFromRequest(request);

  if (!token) {
    reply.status(401).send({ error: 'Missing or invalid authentication token', code: 'UNAUTHORIZED' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    request.user = payload;
  } catch {
    reply.status(401).send({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }
}
