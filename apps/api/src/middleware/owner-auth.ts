import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyOperatorAccessToken } from '../utils/owner-jwt.js';
import { getOwnerAccessTokenFromRequest } from '../utils/owner-cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator: { id: string; email: string };
  }
}

function unauthorized(reply: FastifyReply): void {
  reply.status(401).send({ error: 'Owner authentication required', code: 'OWNER_UNAUTHORIZED' });
}

export async function requirePlatformOperator(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = getOwnerAccessTokenFromRequest(request);
  if (!token) {
    unauthorized(reply);
    return;
  }

  let payload: { operatorId: string; sessionId: string };
  try {
    payload = verifyOperatorAccessToken(token);
  } catch {
    unauthorized(reply);
    return;
  }

  // The signature alone is not enough: the session must still be live and the
  // operator still active, re-read on every request as middleware/auth.ts does.
  const [session, operator] = await Promise.all([
    request.server.prisma.platformOperatorSession.findFirst({
      where: {
        id: payload.sessionId,
        operatorId: payload.operatorId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
    request.server.prisma.platformOperator.findUnique({
      where: { id: payload.operatorId },
      select: { id: true, email: true, lifecycleStatus: true },
    }),
  ]);

  if (!session || !operator || operator.lifecycleStatus !== 'ACTIVE') {
    unauthorized(reply);
    return;
  }

  request.operator = { id: operator.id, email: operator.email };
}
