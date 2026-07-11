import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken, type TokenPayload } from "../utils/jwt.js";
import { getAccessTokenFromRequest } from "../utils/auth-request-credential.js";

declare module "fastify" {
  interface FastifyRequest {
    user: TokenPayload;
  }
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { allowUnverified: boolean },
): Promise<void> {
  const token = getAccessTokenFromRequest(request);

  if (!token) {
    reply
      .status(401)
      .send({
        error: "Missing or invalid authentication token",
        code: "UNAUTHORIZED",
      });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    reply
      .status(401)
      .send({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
    return;
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
      select: { id: true },
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
    reply
      .status(401)
      .send({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
    return;
  }

  if (!user.emailVerified && !options.allowUnverified) {
    reply.status(403).send({
      error: "Please verify your email before continuing",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }

  request.user = {
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    sessionId: session.id,
  };
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
