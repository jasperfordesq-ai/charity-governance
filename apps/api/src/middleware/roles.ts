import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TokenPayload } from '../utils/jwt.js';

type Role = TokenPayload['role'];

export function requireRole(...roles: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!roles.includes(request.user.role)) {
      reply.status(403).send({
        error: 'You do not have permission to perform this action.',
        code: 'FORBIDDEN',
      });
    }
  };
}

export const requireAdmin = requireRole('OWNER', 'ADMIN');
export const requireOwner = requireRole('OWNER');
