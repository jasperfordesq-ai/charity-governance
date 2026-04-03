import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AuthService } from '../../services/auth.service.js';
import { authGuard } from '../../middleware/auth.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';

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

  // ── POST /register ──

  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const body = registerSchema.parse(request.body);
        const result = await authService.register(body);

        reply.status(201).send({
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
            role: result.user.role,
            organisation: result.user.organisation,
          },
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

  // ── POST /login ──

  app.post(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const result = await authService.login(body);

        reply.send({
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
            role: result.user.role,
            organisation: result.user.organisation,
          },
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

  // ── POST /refresh ──

  app.post('/refresh', async (request, reply) => {
    try {
      const body = refreshSchema.parse(request.body);
      const result = await authService.refresh(body.refreshToken);

      reply.send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send(formatZodError(err));
        return;
      }
      handleError(reply, err);
    }
  });

  // ── GET /me ──

  app.get('/me', { preHandler: [authGuard] }, async (request, reply) => {
    try {
      const user = await authService.getMe(request.user.userId);

      reply.send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organisation: user.organisation,
      });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── POST /forgot-password ──

  app.post('/forgot-password', async (request, reply) => {
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
  });

  // ── POST /reset-password ──

  app.post('/reset-password', async (request, reply) => {
    try {
      const body = resetPasswordSchema.parse(request.body);
      const result = await authService.resetPassword(body.token, body.password);

      reply.send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send(formatZodError(err));
        return;
      }
      handleError(reply, err);
    }
  });

  // ── POST /verify-email ──

  app.post('/verify-email', async (request, reply) => {
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
  });
}
