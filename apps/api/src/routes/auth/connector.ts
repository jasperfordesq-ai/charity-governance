import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { AuthService } from "../../services/auth.service.js";
import { authGuard } from "../../middleware/auth.js";
import { AppError, handleError } from "../../utils/errors.js";
import { publicUser } from "../../utils/public-dtos.js";
import { assertNonBrowserClient } from "../../utils/non-browser-client.js";
import { grantApproval } from "../../services/action-approval.service.js";
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

const DATA_SCOPES = ["WITHHELD", "FULL"] as const;

/**
 * The roles that may hold a session which sees personal data.
 *
 * The connector's gate used to be a flag on its command line, so any role
 * could open it — a member could read a trustee's date of birth and home
 * address by editing a configuration file. Releasing that data is a
 * data-protection decision for the charity, so it is now refused below this
 * floor by the API, at the moment the password is checked.
 *
 * Reading it in the web application is unchanged: this is about what a
 * session may hand to a model.
 */
const DATA_SCOPE_ROLE_FLOOR = new Set(["OWNER", "ADMIN"]);

const connectorLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  accessLevel: z.enum(ACCESS_LEVELS),
  // Absent means WITHHELD: the connector's long-standing default, now a
  // property of the session rather than of the process that started it.
  dataScope: z.enum(DATA_SCOPES).optional(),
  deviceLabel: z.string().trim().min(1).max(120).optional(),
});

const connectorApproveSchema = z.object({
  approvalId: z.string().min(1).max(64),
  password: z.string().min(1),
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
        const dataScope = body.dataScope ?? "WITHHELD";
        const result = await authService.login(
          { email: body.email, password: body.password },
          {
            // Never from the body: the route decides what kind of client this is.
            clientKind: "MCP_CONNECTOR",
            accessLevel: body.accessLevel,
            dataScope,
          },
        );

        // Checked after the password, not before: refusing earlier would say
        // which addresses have which role to anyone who asked. The session has
        // already been issued at this point, so it is revoked rather than left
        // behind — a session nobody can use is still a session somebody holds.
        if (dataScope === "FULL" && !DATA_SCOPE_ROLE_FLOOR.has(result.user.role)) {
          await authService.logout(result.refreshToken);
          throw new AppError(
            403,
            "DATA_SCOPE_FORBIDDEN",
            "This account's role may not hold a connector session that sees personal "
              + "data. Connect without asking for full data, or ask an owner or "
              + "administrator to do it.",
          );
        }

        // Deliberately no setAuthCookies. A test asserts no set-cookie header
        // leaves these routes.
        reply.send({
          user: publicUser(result.user),
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          session: {
            clientKind: "MCP_CONNECTOR",
            accessLevel: body.accessLevel,
            dataScope,
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

  /**
   * Grants one pending approval, after checking the password.
   *
   * The password is typed by a human in their own terminal, by
   * `charitypilot-mcp approve <id>`, which refuses to run when standard input
   * is not a terminal. The agent that provoked the approval never sees it and
   * cannot call this route usefully without it.
   *
   * Nothing here says whether the identifier existed, belonged to someone
   * else, or had already been granted. The refusals are identical, and a
   * wrong password spends the same bcrypt cost as a right one, so neither the
   * body nor the timing maps the approval space.
   */
  app.post(
    "/approve",
    { preHandler: [authGuard], config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = connectorApproveSchema.parse(request.body);

        // The rule lives in the service, because the web application grants
        // the same approvals for the person who has no terminal to type at,
        // and a browser path one condition looser than this one would be the
        // whole control quietly undone.
        const granted = await grantApproval(app.prisma, {
          approvalId: body.approvalId,
          password: body.password,
          userId: request.user.userId,
          organisationId: request.user.organisationId,
        });

        if (!granted) {
          throw new AppError(
            401,
            "APPROVAL_REFUSED",
            "That approval could not be granted. Check the password, and that the "
              + "identifier is the one just printed and has not expired.",
          );
        }

        // Deliberately no token of any kind: approving an action is not
        // signing in, and the caller already holds a session.
        reply.send({ ok: true, summary: granted.summary, expiresAt: granted.expiresAt });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  /**
   * Reads one approval back, so `charitypilot-mcp approve` can show a person
   * what they are about to approve BEFORE asking for their password. Without
   * this the summary was printed only after the grant, and the person was
   * approving on the agent's word.
   *
   * Only the person the approval belongs to can read it. Anyone else, and any
   * identifier that does not exist, gets the same not-found.
   */
  app.get(
    "/approvals/:id",
    { preHandler: [authGuard] },
    async (request, reply) => {
      try {
        const id = z.string().min(1).max(64).parse((request.params as { id?: unknown }).id);
        const approval = await app.prisma.authActionApproval.findFirst({
          where: {
            id,
            userId: request.user.userId,
            organisationId: request.user.organisationId,
          },
          select: {
            id: true,
            summary: true,
            method: true,
            routePattern: true,
            resourceId: true,
            createdAt: true,
            expiresAt: true,
            approvedAt: true,
            consumedAt: true,
          },
        });
        if (!approval) {
          throw new AppError(
            404,
            "APPROVAL_NOT_FOUND",
            "No approval with that identifier belongs to you. Approvals expire five "
              + "minutes after they are asked for.",
          );
        }
        reply.send({
          approvalId: approval.id,
          summary: approval.summary,
          method: approval.method,
          routePattern: approval.routePattern,
          resourceId: approval.resourceId,
          createdAt: approval.createdAt.toISOString(),
          expiresAt: approval.expiresAt.toISOString(),
          approvedAt: approval.approvedAt?.toISOString() ?? null,
          consumedAt: approval.consumedAt?.toISOString() ?? null,
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
          dataScope: request.authSession.dataScope,
          role: request.user.role,
          organisationId: request.user.organisationId,
        });
      } catch (err) {
        handleError(reply, err);
      }
    },
  );
}
