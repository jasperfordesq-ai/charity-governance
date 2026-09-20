import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import bcrypt from 'bcryptjs';
import { AppError, handleError } from '../../utils/errors.js';
import { assertNonBrowserClient } from '../../utils/non-browser-client.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';
import {
  issueOperatorSession,
  rotateOperatorSession,
  revokeOperatorSession,
} from '../../services/operator-session.service.js';
import { checkOperatorSecondFactor } from '../../services/operator-second-factor.service.js';
import { grantOperatorApproval } from '../../services/owner-action-approval.service.js';
import {
  bodyIdentifierRateLimit,
  refreshTokenRateLimit,
} from '../../utils/identifier-rate-limit.js';

/**
 * Sign-in for the operator connector, which is not a browser and must not be
 * treated as one.
 *
 * These mirror `/api/v1/auth/connector/*` deliberately and almost line for
 * line. The charity connector could not use the browser sign-in for three
 * reasons, and every one of them applies here too: the browser route sets
 * cookies and the connector has no cookie jar; a response that sets no cookie
 * cannot be the target of login cross-site request forgery, which is what lets
 * these routes waive the origin requirement; and the caller must prove it is
 * not a browser before any credential is looked at.
 *
 * One rule is stricter than the charity side, and it is the reason this file
 * exists rather than a flag on the other one.
 *
 * **The second factor is mandatory.** An operator connector can close a
 * charity, and it reaches every tenant rather than one. The person installing
 * it is, by design, asking a coding agent to hold the credential. A credential
 * an agent holds, which can close a charity, may not rest on a password alone
 * — so an operator with no enrolled authenticator is refused here, and told
 * where to enrol. The database refuses the same thing independently, in
 * `guard_platform_operator_session`, because this is a route and routes get
 * rewritten.
 *
 * There is deliberately no data scope. The operator realm exposes no personal
 * data: its tenant summary selects a user count, never users. A scope field
 * would imply that rule is something a caller may choose.
 */
const ACCESS_LEVELS = ['READ', 'WRITE', 'ADMIN'] as const;

const operatorLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  accessLevel: z.enum(ACCESS_LEVELS),
  /** The authenticator code. Typed once at connect, never at serve. */
  code: z.string().trim().min(1).max(10).optional(),
  /** A recovery code, for the operator whose authenticator is gone. */
  recoveryCode: z.string().trim().max(40).optional(),
  deviceLabel: z.string().trim().min(1).max(120).optional(),
});

const operatorRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const operatorApproveSchema = z.object({
  approvalId: z.string().min(1).max(64),
  password: z.string().min(1),
});

// Spent on an unknown address so a wrong email costs the same as a right one.
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function formatZodError(error: ZodError) {
  return {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
  };
}

export async function ownerConnectorAuthRoutes(app: FastifyInstance): Promise<void> {
  // Before every route here, and before any credential is read. A browser is
  // turned away without learning whether an account exists.
  app.addHook('onRequest', async (request, reply) => {
    const verdict = assertNonBrowserClient(request);
    if (!verdict.ok) {
      return reply.status(verdict.statusCode).send(verdict.payload);
    }
  });

  app.post(
    '/login',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = operatorLoginSchema.parse(request.body);

        const operator = await app.prisma.platformOperator.findUnique({
          where: { email: body.email.toLowerCase().trim() },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            lifecycleStatus: true,
            totpEnrolledAt: true,
          },
        });

        if (!operator) {
          await bcrypt.compare(body.password, DUMMY_PASSWORD_HASH);
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        const valid = await bcrypt.compare(body.password, operator.passwordHash);
        if (!valid || operator.lifecycleStatus !== 'ACTIVE') {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        // Checked after the password, never before: refusing earlier would say
        // which addresses are operators to anyone who asked.
        if (operator.totpEnrolledAt === null) {
          throw new AppError(
            403,
            'OPERATOR_SECOND_FACTOR_REQUIRED',
            'This account has no authenticator enrolled, and a connector session may not '
              + 'rest on a password alone: it reaches every tenant and can close a charity. '
              + 'Enrol one at /owner/security in a browser, then connect again.',
          );
        }

        const secondFactor = await checkOperatorSecondFactor(app.prisma, operator.id, {
          code: body.code,
          recoveryCode: body.recoveryCode,
        });

        // Written as "not satisfied" rather than "not required, or not
        // satisfied" on purpose. The `required: false` arm means the account
        // has an enrolment timestamp but no usable secret, which is a broken
        // enrolment, and a broken second factor must fail closed here.
        if (secondFactor.required !== true || secondFactor.satisfied !== true) {
          throw new AppError(
            401,
            'SECOND_FACTOR_REQUIRED',
            'That authenticator code was not accepted. Pass the current six digits with '
              + '--code, or a recovery code with --recovery-code.',
          );
        }

        const tokens = await issueOperatorSession(app.prisma, operator.id, {
          // From the route, never the body: a browser cannot mint a connector
          // session and this cannot mint a console one, whatever either sends.
          clientKind: 'MCP_CONNECTOR',
          accessLevel: body.accessLevel,
        });

        // Deliberately no setOwnerCookies. A test asserts no set-cookie header
        // leaves these routes.
        return reply.send({
          operator: { id: operator.id, email: operator.email, name: operator.name },
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          session: {
            realm: 'operator',
            clientKind: 'MCP_CONNECTOR',
            accessLevel: body.accessLevel,
            deviceLabel: body.deviceLabel ?? null,
          },
          ...(secondFactor.usedRecoveryCode
            ? { usedRecoveryCode: true }
            : {}),
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/refresh',
    { config: { rateLimit: refreshTokenRateLimit(5) } },
    async (request, reply) => {
      try {
        const body = operatorRefreshSchema.parse(request.body ?? {});
        // The expected client kind is what makes a stolen console credential
        // useless here and a connector credential useless in the console. The
        // refusal is the same opaque one an unknown token gets.
        const tokens = await rotateOperatorSession(app.prisma, body.refreshToken, 'MCP_CONNECTOR');
        return reply.send({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/logout',
    { config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = operatorRefreshSchema.partial().parse(request.body ?? {});
        if (body.refreshToken) {
          await revokeOperatorSession(app.prisma, body.refreshToken);
        }
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  /**
   * Grants one pending approval, after checking the operator's password.
   *
   * The password is typed by a person in their own terminal, by
   * `charitypilot-mcp approve <id> --realm operator`, which refuses to run
   * when standard input is not a terminal. The agent that provoked the
   * approval never sees it.
   *
   * Every refusal below is identical, and a wrong password spends the same
   * bcrypt cost as a right one, so neither the body nor the timing maps the
   * approval space.
   */
  app.post(
    '/approve',
    { preHandler: [requirePlatformOperator], config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = operatorApproveSchema.parse(request.body);

        const granted = await grantOperatorApproval(app.prisma, {
          approvalId: body.approvalId,
          password: body.password,
          operatorId: request.operator.id,
        });

        if (!granted) {
          throw new AppError(
            401,
            'APPROVAL_REFUSED',
            'That approval could not be granted. Check the password, and that the '
              + 'identifier is the one just printed and has not expired.',
          );
        }

        // No token of any kind: approving an action is not signing in, and the
        // caller already holds a session.
        return reply.send({
          ok: true,
          summary: granted.summary,
          expiresAt: granted.expiresAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send(formatZodError(err));
        }
        return handleError(reply, err);
      }
    },
  );

  /**
   * Reads one approval back, so the terminal can show a person what they are
   * about to approve BEFORE asking for their password. Without this they would
   * be approving on the agent's word.
   *
   * Only the operator the approval belongs to can read it. Anyone else, and
   * any identifier that does not exist, gets the same not-found.
   */
  app.get('/approvals/:id', { preHandler: [requirePlatformOperator] }, async (request, reply) => {
    try {
      const id = z.string().min(1).max(64).parse((request.params as { id?: unknown }).id);
      const approval = await app.prisma.operatorActionApproval.findFirst({
        where: { id, operatorId: request.operator.id },
        select: {
          id: true,
          summary: true,
          method: true,
          routePattern: true,
          resourceId: true,
          resourceLabel: true,
          createdAt: true,
          expiresAt: true,
          approvedAt: true,
          consumedAt: true,
        },
      });

      if (!approval) {
        throw new AppError(
          404,
          'APPROVAL_NOT_FOUND',
          'No approval with that identifier belongs to you. Approvals expire five '
            + 'minutes after they are asked for.',
        );
      }

      return reply.send({
        approvalId: approval.id,
        summary: approval.summary,
        method: approval.method,
        routePattern: approval.routePattern,
        resourceId: approval.resourceId,
        resourceLabel: approval.resourceLabel,
        createdAt: approval.createdAt.toISOString(),
        expiresAt: approval.expiresAt.toISOString(),
        approvedAt: approval.approvedAt?.toISOString() ?? null,
        consumedAt: approval.consumedAt?.toISOString() ?? null,
      });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send(formatZodError(err));
      }
      return handleError(reply, err);
    }
  });

  app.get('/session', { preHandler: [requirePlatformOperator] }, async (request, reply) => {
    try {
      const session = request.operatorSession;
      if (!session) {
        throw new AppError(401, 'OWNER_UNAUTHORIZED', 'No session');
      }
      const operator = await app.prisma.platformOperator.findUnique({
        where: { id: request.operator.id },
        select: { name: true, totpEnrolledAt: true },
      });

      return reply.send({
        realm: 'operator',
        clientKind: session.clientKind,
        accessLevel: session.accessLevel,
        operator: {
          id: request.operator.id,
          email: request.operator.email,
          name: operator?.name ?? null,
        },
        secondFactorEnrolled: operator?.totpEnrolledAt != null,
        // Stated rather than implied. An agent reading this should not have to
        // infer from an absent field that the realm holds no personal data.
        personalData: 'NONE',
      });
    } catch (err) {
      return handleError(reply, err);
    }
  });
}
