import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AuthService } from "../../services/auth.service.js";
import { authGuard, authIdentityGuard } from "../../middleware/auth.js";
import {
  grantApproval,
  listPendingApprovals,
} from "../../services/action-approval.service.js";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@charitypilot/shared";
import { AppError, handleError } from "../../utils/errors.js";
import {
  clearAuthCookies,
  getRefreshTokenFromRequest,
  setAuthCookies,
} from "../../utils/auth-cookies.js";
import { publicUser } from "../../utils/public-dtos.js";
import {
  AUTH_ME_CREDENTIAL_MAX_PER_MINUTE,
  authCredentialRateLimit,
  authMeCoarseIpRateLimit,
  bodyIdentifierRateLimit,
  refreshTokenRateLimit,
} from "../../utils/identifier-rate-limit.js";
import { isRegistrationOpen, emailDeliveryMode } from "../../utils/deployment-profile.js";

/** Password attempts a minute on the approvals page, per credential. */
const APPROVAL_GRANT_MAX_PER_MINUTE = 10;

function formatZodError(error: ZodError) {
  return {
    error: "Validation failed",
    code: "VALIDATION_ERROR",
    details: error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })),
  };
}

// Email-axis gate: these endpoints exist to send provider email. Under
// manual-link delivery they are hidden entirely (404, not 403) — the
// appliance's long-standing behaviour, now keyed on the axis that means it.
async function providerEmailAuthGuard(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (emailDeliveryMode() === "provider") return;
  return reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
}

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app.prisma);
  const checkAuthMeCoarseIpRateLimit = app.hasDecorator("createRateLimit")
    ? app.createRateLimit(authMeCoarseIpRateLimit())
    : null;

  app.post(
    "/register",
    { config: { rateLimit: bodyIdentifierRateLimit(["email"]) } },
    async (request, reply) => {
      if (!isRegistrationOpen()) {
        return reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
      }

      try {
        const body = registerSchema.parse(request.body);
        const result = await authService.register(body);

        return reply.status(202).send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: bodyIdentifierRateLimit(["email"]) } },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const result = await authService.login(body);

        setAuthCookies(reply, result);
        return reply.send({ user: publicUser(result.user) });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/refresh",
    { config: { rateLimit: refreshTokenRateLimit(5) } },
    async (request, reply) => {
      try {
        const body = refreshSchema.parse(request.body ?? {});
        const refreshToken =
          body.refreshToken ?? getRefreshTokenFromRequest(request);

        if (!refreshToken) {
          throw new AppError(
            401,
            "INVALID_REFRESH_TOKEN",
            "Missing refresh token",
          );
        }

        // "WEB" is not decoration. This route sets cookies, so a connector
        // refresh token spent here would become a browser session carried by a
        // cookie the connector never had. The connector route refuses a web
        // token for the mirror-image reason; a credential stolen from one
        // channel must be useless in the other.
        const result = await authService.refresh(refreshToken, "WEB");
        setAuthCookies(reply, result);

        return reply.send({ ok: true });
      } catch (err) {
        clearAuthCookies(reply);
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/logout",
    { config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = refreshSchema.partial().parse(request.body ?? {});
        const refreshToken =
          body.refreshToken ?? getRefreshTokenFromRequest(request);

        if (refreshToken) {
          await authService.logout(refreshToken);
        }

        clearAuthCookies(reply);
        return reply.send({ ok: true });
      } catch (err) {
        clearAuthCookies(reply);
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.get(
    "/me",
    {
      onRequest: [
        async (request, reply) => {
          if (!checkAuthMeCoarseIpRateLimit) return;
          const limit = await checkAuthMeCoarseIpRateLimit(request);
          if (limit.isAllowed || !limit.isExceeded) return;

          return reply
            .header("X-RateLimit-Limit", limit.max)
            .header("X-RateLimit-Remaining", 0)
            .header("X-RateLimit-Reset", limit.ttlInSeconds)
            .header("Retry-After", limit.ttlInSeconds)
            .status(429)
            .send({
              statusCode: 429,
              error: "Too Many Requests",
              message: "Rate limit exceeded",
            });
        },
      ],
      preHandler: [authIdentityGuard],
      // Protected Next.js requests validate sessions server-side. Key this
      // read-only route by access credential so unrelated users do not share
      // the web server's single proxy-IP bucket. The independent coarse-IP
      // onRequest hook above still bounds attacker-controlled credential spray.
      config: {
        rateLimit: authCredentialRateLimit(AUTH_ME_CREDENTIAL_MAX_PER_MINUTE),
      },
    },
    async (request, reply) => {
      try {
        const user = await authService.getMe(request.user.userId);
        return reply.send(publicUser(user));
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/forgot-password",
    {
      preHandler: [providerEmailAuthGuard],
      config: { rateLimit: bodyIdentifierRateLimit(["email"]) },
    },
    async (request, reply) => {
      try {
        const body = forgotPasswordSchema.parse(request.body);
        const result = await authService.forgotPassword(body.email, {
          ipAddress: request.ip,
          requestId: request.id,
        });

        return reply.status(202).send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/resend-verification",
    {
      preHandler: [providerEmailAuthGuard, authIdentityGuard],
      config: { rateLimit: authCredentialRateLimit() },
    },
    async (request, reply) => {
      try {
        const result = await authService.resendEmailVerification(
          request.user.userId,
        );

        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/reset-password",
    { config: { rateLimit: bodyIdentifierRateLimit(["token"]) } },
    async (request, reply) => {
      try {
        const body = resetPasswordSchema.parse(request.body);
        const result = await authService.resetPassword(
          body.token,
          body.password,
          {
            ipAddress: request.ip,
            requestId: request.id,
          },
        );

        clearAuthCookies(reply);
        return reply.send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    "/verify-email",
    { config: { rateLimit: bodyIdentifierRateLimit(["token"]) } },
    async (request, reply) => {
      try {
        const body = verifyEmailSchema.parse(request.body);
        const result = await authService.verifyEmail(body.token);

        return reply.send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  /**
   * Approvals, for the person who has no terminal.
   *
   * A destructive action asked for by a connector is refused until somebody
   * approves it with their password. `charitypilot-mcp approve` does that at
   * a terminal, which is what keeps the agent that asked from also granting
   * it — an agent can write to a process's input but cannot type at a
   * terminal. A trustee running Claude Desktop has no terminal at all, and
   * could approve nothing.
   *
   * These two routes are that person's way in. They are deliberately NOT on
   * the connector prefix: that one refuses anything carrying evidence of a
   * browser, and weakening it for one route would undo the property that
   * lets those routes hand back tokens in the body. A page is a browser, so
   * it comes in through the browser realm, under the ordinary origin
   * protection, and re-asks for the password here exactly as the terminal
   * does. Both call one service, so the rule cannot drift between them.
   */
  app.get("/approvals", { preHandler: [authGuard] }, async (request, reply) => {
    try {
      const pending = await listPendingApprovals(app.prisma, {
        userId: request.user.userId,
        organisationId: request.user.organisationId,
      });
      return reply.send({ data: pending });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post(
    "/approvals/:id/grant",
    {
      preHandler: [authGuard],
      // Keyed on the caller's own credential: password attempts here must not
      // be spendable against somebody else, and must not share the bucket the
      // rest of their session uses.
      config: { rateLimit: authCredentialRateLimit(APPROVAL_GRANT_MAX_PER_MINUTE) },
    },
    async (request, reply) => {
      try {
        const params = z
          .object({ id: z.string().min(1).max(64) })
          .parse(request.params);
        const body = z.object({ password: z.string().min(1) }).parse(request.body);

        const granted = await grantApproval(app.prisma, {
          approvalId: params.id,
          password: body.password,
          userId: request.user.userId,
          organisationId: request.user.organisationId,
        });

        if (!granted) {
          // The same opaque refusal the terminal gets: nothing here says
          // whether the identifier existed, belonged to somebody else, or had
          // already been granted.
          throw new AppError(
            401,
            "APPROVAL_REFUSED",
            "That approval could not be granted. Check your password, and that the "
              + "action is still waiting.",
          );
        }

        return reply.send({ ok: true, summary: granted.summary, expiresAt: granted.expiresAt });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );
}
