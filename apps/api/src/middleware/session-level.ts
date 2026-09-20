import type { FastifyRequest, FastifyReply } from "fastify";
import type { RequestAuthSession } from "./auth.js";

type AccessLevel = RequestAuthSession["accessLevel"];

/**
 * The levels are ordinal: READ allows safe methods only, WRITE adds ordinary
 * changes, ADMIN adds the destructive ones.
 *
 * A level can only ever narrow. The role checks in roles.ts still apply on top,
 * so an ADMIN-level session belonging to a MEMBER account is still refused
 * everything a MEMBER may not do. Nothing here grants authority; it only
 * withholds it.
 */
const RANK: Record<AccessLevel, number> = { READ: 0, WRITE: 1, ADMIN: 2 };

export function requireSessionLevel(minimum: AccessLevel) {
  return async function sessionLevelGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Web sessions are always ADMIN, enforced by a database constraint, so
    // this guard changes nothing for the web application until it starts
    // asking for a narrower session of its own.
    const level = request.authSession?.accessLevel ?? "ADMIN";

    if (RANK[level] < RANK[minimum]) {
      return reply.status(403).send({
        error:
          minimum === "ADMIN"
            ? "This action needs a session with administrator access. Re-connect at that level to perform it."
            : "This session does not have permission for that action.",
        code: "SESSION_LEVEL_TOO_LOW",
      });
    }
  };
}
