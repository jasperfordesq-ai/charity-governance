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

  let payload: TokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    reply.status(401).send({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  const [session, user] = await Promise.all([
    request.server.prisma.authSession.findFirst({
      where: {
        id: payload.sessionId,
        userId: payload.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
    request.server.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        organisationId: true,
        role: true,
      },
    }),
  ]);

  if (!session || !user) {
    reply.status(401).send({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    return;
  }

  request.user = {
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    sessionId: session.id,
  };
}
