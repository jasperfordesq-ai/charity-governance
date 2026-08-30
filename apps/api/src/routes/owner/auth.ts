import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { AppError, handleError } from '../../utils/errors.js';
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

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
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

        const tokens = await issueOperatorSession(app.prisma, operator.id);
        setOwnerCookies(reply, tokens);
        reply.send({ operator: { id: operator.id, email: operator.email, name: operator.name } });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
          return;
        }
        handleError(reply, err);
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
        reply.send({ ok: true });
      } catch (err) {
        clearOwnerCookies(reply);
        handleError(reply, err);
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
      reply.send({ message: 'Signed out' });
    },
  );

  app.get('/auth/me', { preHandler: [requirePlatformOperator] }, async (request, reply) => {
    reply.send({ operator: request.operator });
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
          select: { id: true, email: true },
        });

        if (!operator) {
          throw new AppError(400, 'INVALID_RESET_TOKEN', 'That link is invalid or has expired.');
        }

        await app.prisma.platformOperator.update({
          where: { id: operator.id },
          data: {
            passwordHash: await bcrypt.hash(body.password, 10),
            resetToken: null,
            resetTokenExpiry: null,
          },
        });

        // Any session established before a credential change must not survive it.
        await app.prisma.platformOperatorSession.updateMany({
          where: { operatorId: operator.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        reply.send({ message: 'Password set. You can now sign in.' });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send({ error: 'Password must be at least 12 characters.', code: 'VALIDATION_ERROR' });
          return;
        }
        handleError(reply, err);
      }
    },
  );
}
