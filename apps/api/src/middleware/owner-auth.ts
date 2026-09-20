import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OperatorSessionAccessLevel, OperatorSessionClientKind } from '@prisma/client';
import { verifyOperatorAccessToken } from '../utils/owner-jwt.js';
import { getOwnerAccessTokenFromRequest } from '../utils/owner-cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator: { id: string; email: string };
    operatorSession?: {
      id: string;
      clientKind: OperatorSessionClientKind;
      accessLevel: OperatorSessionAccessLevel;
      familyId: string;
    };
  }
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({ error: 'Owner authentication required', code: 'OWNER_UNAUTHORIZED' });
}

export async function requirePlatformOperator(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  const token = getOwnerAccessTokenFromRequest(request);
  if (!token) return unauthorized(reply);

  let payload: { operatorId: string; sessionId: string };
  try {
    payload = verifyOperatorAccessToken(token);
  } catch {
    return unauthorized(reply);
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
      select: {
        id: true,
        clientKind: true,
        accessLevel: true,
        familyId: true,
      },
    }),
    request.server.prisma.platformOperator.findUnique({
      where: { id: payload.operatorId },
      select: { id: true, email: true, lifecycleStatus: true },
    }),
  ]);

  if (!session || !operator || operator.lifecycleStatus !== 'ACTIVE') {
    return unauthorized(reply);
  }

  request.operator = { id: operator.id, email: operator.email };
  // The posture travels with the request, so the guards after this one do not
  // each re-read the session. `familyId` rather than the session id, because
  // that is what an approval is bound to: rotation replaces the row roughly
  // every half hour, and an approval bound to the row would be dead before
  // anyone could type a password.
  request.operatorSession = {
    id: session.id,
    clientKind: session.clientKind,
    accessLevel: session.accessLevel,
    familyId: session.familyId,
  };
}
