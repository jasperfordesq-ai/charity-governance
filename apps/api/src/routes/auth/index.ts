import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AuthService } from '../../services/auth.service.js';
import { authIdentityGuard } from '../../middleware/auth.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import {
  clearAuthCookies,
  getRefreshTokenFromRequest,
  setAuthCookies,
} from '../../utils/auth-cookies.js';
import { publicUser } from '../../utils/public-dtos.js';
import { authCredentialRateLimit, bodyIdentifierRateLimit, refreshTokenRateLimit } from '../../utils/identifier-rate-limit.js';

function formatZodError(error: ZodError) {
  return {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    })),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app.prisma);

  app.post(
    '/register',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = registerSchema.parse(request.body);
        const result = await authService.register(body);

        reply.status(202).send(result);
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
    '/login',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const result = await authService.login(body);

        setAuthCookies(reply, result);
        reply.send({ user: publicUser(result.user) });
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
    '/refresh',
    { config: { rateLimit: refreshTokenRateLimit(5) } },
    async (request, reply) => {
      try {
        const body = refreshSchema.parse(request.body ?? {});
        const refreshToken = body.refreshToken ?? getRefreshTokenFromRequest(request);

        if (!refreshToken) {
          throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Missing refresh token');
        }

        const result = await authService.refresh(refreshToken);
        setAuthCookies(reply, result);

        reply.send({ ok: true });
      } catch (err) {
        clearAuthCookies(reply);
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.post(
    '/logout',
    { config: { rateLimit: refreshTokenRateLimit(10) } },
    async (request, reply) => {
      try {
        const body = refreshSchema.partial().parse(request.body ?? {});
        const refreshToken = body.refreshToken ?? getRefreshTokenFromRequest(request);

        if (refreshToken) {
          await authService.logout(refreshToken);
        }

        clearAuthCookies(reply);
        reply.send({ ok: true });
      } catch (err) {
        clearAuthCookies(reply);
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.get('/me', { preHandler: [authIdentityGuard] }, async (request, reply) => {
    try {
      const user = await authService.getMe(request.user.userId);
      reply.send(publicUser(user));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post(
    '/forgot-password',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = forgotPasswordSchema.parse(request.body);
        const result = await authService.forgotPassword(body.email);

        reply.send(result);
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
    '/resend-verification',
    {
      preHandler: [authIdentityGuard],
      config: { rateLimit: authCredentialRateLimit() },
    },
    async (request, reply) => {
      try {
        const result = await authService.resendEmailVerification(request.user.userId);

        reply.send(result);
      } catch (err) {
        handleError(reply, err);
      }
    },
  );

  app.post(
    '/reset-password',
    { config: { rateLimit: bodyIdentifierRateLimit(['token']) } },
    async (request, reply) => {
      try {
        const body = resetPasswordSchema.parse(request.body);
        const result = await authService.resetPassword(body.token, body.password);

        clearAuthCookies(reply);
        reply.send(result);
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
    '/verify-email',
    { config: { rateLimit: bodyIdentifierRateLimit(['token']) } },
    async (request, reply) => {
      try {
        const body = verifyEmailSchema.parse(request.body);
        const result = await authService.verifyEmail(body.token);

        reply.send(result);
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );
}
