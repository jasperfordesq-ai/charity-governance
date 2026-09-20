import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { AppError, handleError } from '../../utils/errors.js';
import {
  beginOperatorEnrolment,
  checkOperatorSecondFactor,
  completeOperatorEnrolment,
  operatorSecondFactorState,
  removeOperatorSecondFactor,
} from '../../services/operator-second-factor.service.js';
import { bodyIdentifierRateLimit, refreshTokenRateLimit } from '../../utils/identifier-rate-limit.js';
import {
  issueOperatorSession,
  rotateOperatorSession,
  revokeOperatorSession,
} from '../../services/operator-session.service.js';
import {
  setOwnerCookies,
  clearOwnerCookies,
  getOwnerRefreshTokenFromRequest,
} from '../../utils/owner-cookies.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';

// Same constant-time defence as tenant login: an unknown operator email must
// cost the same bcrypt work as a wrong password, or operator addresses can be
// enumerated by response timing.
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const secondFactorCodeSchema = z.object({
  code: z.string().trim().max(20).optional(),
  recoveryCode: z.string().trim().max(40).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  // Both optional: an account with no second factor is signed in by password
  // alone, which is what keeps enrolment opt-in without a second code path.
  code: z.string().trim().max(20).optional(),
  recoveryCode: z.string().trim().max(40).optional(),
});

export async function ownerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const email = body.email.trim().toLowerCase();

        const operator = await app.prisma.platformOperator.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, passwordHash: true, lifecycleStatus: true },
        });

        if (!operator) {
          await bcrypt.compare(body.password, DUMMY_PASSWORD_HASH);
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        const valid = await bcrypt.compare(body.password, operator.passwordHash);
        if (!valid || operator.lifecycleStatus !== 'ACTIVE') {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        // After the password and before any session exists. An account with a
        // second factor gets no session at all until it is satisfied.
        const secondFactor = await checkOperatorSecondFactor(app.prisma, operator.id, {
          code: body.code,
          recoveryCode: body.recoveryCode,
        });

        if (secondFactor.required && !secondFactor.satisfied) {
          // Deliberately distinguishable from a wrong password: the password
          // WAS right, and telling somebody to retype it would send them
          // hunting for a problem that is not there. This leaks only that the
          // account has a second factor, which the person holding the correct
          // password for it already knows.
          return reply.status(401).send({
            error: 'This account needs a code from its authenticator application.',
            code: 'SECOND_FACTOR_REQUIRED',
          });
        }

        const tokens = await issueOperatorSession(app.prisma, operator.id);
        setOwnerCookies(reply, tokens);
        return reply.send({
          operator: { id: operator.id, email: operator.email, name: operator.name },
          ...(secondFactor.required && secondFactor.satisfied && secondFactor.usedRecoveryCode
            ? {
                // Said plainly, because a recovery code is one of ten and
                // nobody counts them in their head.
                usedRecoveryCode: true,
              }
            : {}),
        });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: refreshTokenRateLimit(5) } },
    async (request, reply) => {
      try {
        const refreshToken = getOwnerRefreshTokenFromRequest(request);
        if (!refreshToken) {
          throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'Missing session');
        }
        const tokens = await rotateOperatorSession(app.prisma, refreshToken);
        setOwnerCookies(reply, tokens);
        return reply.send({ ok: true });
      } catch (err) {
        clearOwnerCookies(reply);
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/auth/logout',
    { config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      const refreshToken = getOwnerRefreshTokenFromRequest(request);
      if (refreshToken) await revokeOperatorSession(app.prisma, refreshToken);
      clearOwnerCookies(reply);
      return reply.send({ message: 'Signed out' });
    },
  );

  /**
   * The second factor, managed by the operator it belongs to.
   *
   * All four are behind requirePlatformOperator: an operator manages their own
   * factor and nobody else's. There is deliberately no route for one operator
   * to remove another's, because that would be a way around the factor rather
   * than a way to support somebody who lost their phone. Losing every recovery
   * code is recovered by the command-line job, on the host, by somebody with
   * shell access — which is a higher bar than the console, as it should be.
   */
  app.get(
    '/auth/second-factor',
    { preHandler: [requirePlatformOperator] },
    async (request, reply) => {
      try {
        return reply.send(await operatorSecondFactorState(app.prisma, request.operator.id));
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/auth/second-factor/begin',
    { preHandler: [requirePlatformOperator] },
    async (request, reply) => {
      try {
        // The secret is returned exactly once, here, so it can be scanned. It
        // is never readable again: a route that could hand it back would make
        // a stolen session enough to clone the factor.
        return reply.send(await beginOperatorEnrolment(app.prisma, request.operator.id));
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/auth/second-factor/complete',
    { preHandler: [requirePlatformOperator], config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = secondFactorCodeSchema.parse(request.body ?? {});
        if (!body.code) {
          throw new AppError(400, 'VALIDATION_ERROR', 'A code from the application is required.');
        }
        // The recovery codes are shown once and never again, which the console
        // says out loud before it stops showing them.
        return reply.send(await completeOperatorEnrolment(app.prisma, request.operator.id, body.code));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        }
        return handleError(reply, err);
      }
    },
  );

  app.post(
    '/auth/second-factor/remove',
    { preHandler: [requirePlatformOperator], config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = secondFactorCodeSchema.parse(request.body ?? {});
        await removeOperatorSecondFactor(app.prisma, request.operator.id, body);
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        }
        return handleError(reply, err);
      }
    },
  );

  app.get('/auth/me', { preHandler: [requirePlatformOperator] }, async (request, reply) => {
    return reply.send({ operator: request.operator });
  });

  const setPasswordSchema = z.object({
    token: z.string().min(1).max(200),
    password: z.string().min(12).max(200),
  });

  app.post(
    '/auth/set-password',
    { config: { rateLimit: bodyIdentifierRateLimit(['token']) } },
    async (request, reply) => {
      try {
        const body = setPasswordSchema.parse(request.body);
        // The column holds a sha256 hash, never the raw token from the link.
        const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');

        const operator = await app.prisma.platformOperator.findFirst({
          where: { resetToken: tokenHash, resetTokenExpiry: { gt: new Date() } },
          select: { id: true },
        });

        if (!operator) {
          throw new AppError(400, 'INVALID_RESET_TOKEN', 'That link is invalid or has expired.');
        }

        const passwordHash = await bcrypt.hash(body.password, 10);

        // Password write and session revocation commit or fail together, and
        // the write is re-conditioned on the token still matching so a second
        // concurrent request carrying the same (already-consumed) token loses
        // cleanly instead of performing a second password write.
        await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const updated = await tx.platformOperator.updateMany({
            where: { id: operator.id, resetToken: tokenHash },
            data: {
              passwordHash,
              resetToken: null,
              resetTokenExpiry: null,
            },
          });

          if (updated.count !== 1) {
            throw new AppError(400, 'INVALID_RESET_TOKEN', 'That link is invalid or has expired.');
          }

          // Any session established before a credential change must not survive it.
          await tx.platformOperatorSession.updateMany({
            where: { operatorId: operator.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        });

        return reply.send({ message: 'Password set. You can now sign in.' });
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Password must be at least 12 characters.', code: 'VALIDATION_ERROR' });
        }
        return handleError(reply, err);
      }
    },
  );
}
