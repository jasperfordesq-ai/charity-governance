import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken, type TokenPayload } from "../utils/jwt.js";
import { getAccessTokenFromRequest } from "../utils/auth-request-credential.js";

/**
 * The posture of the session behind this request: which client it belongs to
 * and how much it may do.
 *
 * It is read from the session row on every request rather than carried in the
 * access token, for the same reason the role is: a token says what was true
 * when it was signed, and a session that has been narrowed or revoked since
 * must stop working immediately. The token payload is also reconstructed from
 * a four-claim allowlist on verify, so anything added to it would be dropped.
 */
export type RequestAuthSession = {
  id: string;
  /**
   * The family this session belongs to, stable across every rotation.
   *
   * `id` changes on each refresh, so anything that has to outlive fifteen
   * minutes — an approval waiting for a person to type a password, for one —
   * must key off this instead.
   */
  familyId: string;
  clientKind: "WEB" | "MCP_CONNECTOR";
  accessLevel: "READ" | "WRITE" | "ADMIN";
  /**
   * How much personal data this session may see.
   *
   * Read here rather than taken from a flag on the connector's command line,
   * which lived in the AI client's configuration file — a file the connector
   * otherwise treats as attacker-writable, which is why a stored credential
   * is bound to the host that issued it.
   */
  dataScope: "WITHHELD" | "FULL";
};

declare module "fastify" {
  interface FastifyRequest {
    user: TokenPayload;
    authSession: RequestAuthSession;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { allowUnverified: boolean },
): Promise<void> {
  const token = getAccessTokenFromRequest(request);

  if (!token) {
    return reply
      .status(401)
      .send({
        error: "Missing or invalid authentication token",
        code: "UNAUTHORIZED",
      });
  }

  let payload: TokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return reply
      .status(401)
      .send({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }

  const [session, user] = await Promise.all([
    request.server.prisma.authSession.findFirst({
      where: {
        id: payload.sessionId,
        userId: payload.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: {
          is: {
            lifecycleStatus: "ACTIVE",
            organisation: {
              is: { lifecycleStatus: "ACTIVE" },
            },
          },
        },
      },
      select: {
        id: true,
        familyId: true,
        clientKind: true,
        accessLevel: true,
        dataScope: true,
      },
    }),
    request.server.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        organisationId: true,
        role: true,
        emailVerified: true,
        lifecycleStatus: true,
        organisation: { select: { lifecycleStatus: true } },
      },
    }),
  ]);

  if (
    !session ||
    !user ||
    (user.lifecycleStatus !== undefined && user.lifecycleStatus !== "ACTIVE") ||
    (user.organisation?.lifecycleStatus !== undefined &&
      user.organisation.lifecycleStatus !== "ACTIVE")
  ) {
    return reply
      .status(401)
      .send({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }

  if (!user.emailVerified && !options.allowUnverified) {
    return reply.status(403).send({
      error: "Please verify your email before continuing",
      code: "EMAIL_NOT_VERIFIED",
    });
  }

  request.user = {
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    sessionId: session.id,
  };
  request.authSession = {
    id: session.id,
    familyId: session.familyId,
    // A session issued before this column existed reads as a full-authority
    // web session, which is what it was.
    clientKind: session.clientKind ?? "WEB",
    accessLevel: session.accessLevel ?? "ADMIN",
    // A session issued before this column existed saw everything, which is
    // what FULL means.
    dataScope: session.dataScope ?? "FULL",
  };

  // A read-only session may not change anything, whatever the account behind
  // it is allowed to do. This is checked here rather than per route so a
  // route added later is covered without anyone remembering.
  if (
    request.authSession.accessLevel === "READ" &&
    !SAFE_METHODS.has(request.method)
  ) {
    return reply.status(403).send({
      error: "This session is read-only",
      code: "SESSION_READ_ONLY",
    });
  }
}

export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticateRequest(request, reply, { allowUnverified: false });
}

export async function authIdentityGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticateRequest(request, reply, { allowUnverified: true });
}
