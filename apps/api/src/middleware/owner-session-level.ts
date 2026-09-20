import type { FastifyRequest, FastifyReply } from 'fastify';
import type { OperatorSessionAccessLevel } from '@prisma/client';

/**
 * The access floor for one operator route.
 *
 * Ordinal, like the tenant realm's: READ allows safe methods only, WRITE adds
 * ordinary changes, ADMIN adds the ones that cannot be walked back. Nothing
 * here grants authority; it only withholds it.
 *
 * Applied beside the approval guard, and they answer different questions. This
 * one asks whether the session was ever connected with the authority to do
 * this. The approval guard asks whether a person agreed to this particular
 * action, just now.
 */
const RANK: Record<OperatorSessionAccessLevel, number> = { READ: 0, WRITE: 1, ADMIN: 2 };

export function requireOperatorSessionLevel(minimum: OperatorSessionAccessLevel) {
  return async function operatorSessionLevelGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> {
    // Console sessions are ADMIN by column default, so this changes nothing
    // for the browser until the console asks for a narrower session of its own.
    const level = request.operatorSession?.accessLevel ?? 'ADMIN';

    if (RANK[level] < RANK[minimum]) {
      // Returned, not merely sent. Fastify only stops a request when an
      // asynchronous hook RETURNS the reply it sent; a guard that sends and
      // falls out of the bottom is advisory, and the handler runs anyway. Every
      // guard in this API was written the wrong way until 2026-09-20, and the
      // only reason it worked was that exactly one onSend hook was registered.
      return reply.status(403).send({
        error:
          minimum === 'ADMIN'
            ? 'This action needs an operator session with administrator access. '
              + 'Re-connect with --access-level admin to perform it.'
            : 'This operator session does not have permission for that action.',
        code: 'OPERATOR_SESSION_LEVEL_TOO_LOW',
      });
    }
  };
}
