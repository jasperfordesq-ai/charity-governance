import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { AuthService } from "../../services/auth.service.js";
import { authGuard } from "../../middleware/auth.js";
import { AppError, handleError } from "../../utils/errors.js";
import { publicUser } from "../../utils/public-dtos.js";
import { assertNonBrowserClient } from "../../utils/non-browser-client.js";
import {
  bodyIdentifierRateLimit,
  refreshTokenRateLimit,
} from "../../utils/identifier-rate-limit.js";

/**
 * Sign-in for the MCP connector, which is not a browser and must not be
 * treated as one.
 *
 * Three things differ from the browser routes beside them, and each is load
 * bearing:
 *
 *   1. Tokens are returned in the response body. The connector has no cookie
 *      jar; it holds a refresh token in the operating system credential store.
 *   2. No cookie is ever set. A response that sets no cookie cannot be the
 *      target of login cross-site request forgery, which is the whole reason
 *      these routes may waive the origin requirement the browser ones enforce.
 *   3. The caller must prove it is not a browser, twice over, before any
 *      credential is looked at. See non-browser-client.ts.
 *
 * The session posture is decided here rather than taken on trust. clientKind
 * comes from the route, so a browser cannot mint a connector session and the
 * connector cannot mint a web one whatever either sends. accessLevel does come
 * from the body, which is safe only because the password gates it: the person
 * choosing how much authority the session carries is the person who just
 * proved they hold the account.
 */
const ACCESS_LEVELS = ["READ", "WRITE", "ADMIN"] as const;

const connectorLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  accessLevel: z.enum(ACCESS_LEVELS),
  deviceLabel: z.string().trim().min(1).max(120).optional(),
});

const connectorRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

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

export async function connectorAuthRoutes(app: FastifyInstance) {
  const authService = new AuthService(app.prisma);

  // Runs before every route here, and before any credential is read. A browser
  // is turned away without learning whether an account exists.
  app.addHook("onRequest", async (request, reply) => {
    const verdict = assertNonBrowserClient(request);
    if (!verdict.ok) {
      return reply.status(verdict.statusCode).send(verdict.payload);
    }
  });

  app.post(
    "/login",
    { config: { rateLimit: bodyIdentifierRateLimit(["email"]) } },
    async (request, reply) => {
      try {
        const body = connectorLoginSchema.parse(request.body);
        const result = await authService.login(
          { email: body.email, password: body.password },
          {
            // Never from the body: the route decides what kind of client this is.
            clientKind: "MCP_CONNECTOR",
            accessLevel: body.accessLevel,
          },
        );

        // Deliberately no setAuthCookies. A test asserts no set-cookie header
        // leaves these routes.
        reply.send({
          user: publicUser(result.user),
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          session: {
            clientKind: "MCP_CONNECTOR",
            accessLevel: body.accessLevel,
            deviceLabel: body.deviceLabel ?? null,
          },
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.post(
    "/refresh",
    { config: { rateLimit: refreshTokenRateLimit(5) } },
    async (request, reply) => {
      try {
        const body = connectorRefreshSchema.parse(request.body ?? {});
        // Passing the expected client kind makes a stolen connector credential
        // useless in a browser and a browser credential useless here. The
        // refusal is the same opaque one an unknown token gets.
        const result = await authService.refresh(
          body.refreshToken,
          "MCP_CONNECTOR",
        );

        reply.send({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.post(
    "/logout",
    { config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = connectorRefreshSchema.partial().parse(request.body ?? {});
        if (body.refreshToken) {
          await authService.logout(body.refreshToken);
        }
        reply.send({ ok: true });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.get(
    "/session",
    { preHandler: [authGuard] },
    async (request, reply) => {
      try {
        if (!request.authSession) {
          throw new AppError(401, "UNAUTHORIZED", "No session");
        }
        reply.send({
          clientKind: request.authSession.clientKind,
          accessLevel: request.authSession.accessLevel,
          role: request.user.role,
          organisationId: request.user.organisationId,
        });
      } catch (err) {
        handleError(reply, err);
      }
    },
  );
}
