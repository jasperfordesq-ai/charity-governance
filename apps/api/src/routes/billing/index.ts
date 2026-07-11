import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BillingService } from '../../services/billing.service.js';
import { authGuard } from '../../middleware/auth.js';
import { requireOwner } from '../../middleware/roles.js';
import { createCheckoutSchema, type SubscriptionPlan } from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import { ZodError } from 'zod';

export async function billingRoutes(app: FastifyInstance) {
  const service = new BillingService(app.prisma);

  // ── Stripe webhook ──
  // Must receive raw body for signature verification.
  // Register in its own encapsulated scope with a Buffer content-type parser.
  app.register(async (webhookScope: FastifyInstance) => {
    // Override JSON parsing in this scope: receive raw Buffer instead
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        done(null, body);
      },
    );

    webhookScope.post('/webhooks', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const sig = request.headers['stripe-signature'] as string | undefined;
        const rawBody = request.body as Buffer;

        const event = service.constructWebhookEvent(rawBody, sig);

        await service.handleWebhook(event);
        return { received: true };
      } catch (err) {
        if (err instanceof AppError && err.statusCode < 500) {
          app.log.warn({ code: err.code, statusCode: err.statusCode }, err.message);
        }
        handleError(reply, err);
      }
    });
  });

  // ── Authenticated billing routes ──
  app.register(async (authedApp: FastifyInstance) => {
    authedApp.addHook('onRequest', authGuard);

    const createCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = createCheckoutSchema.parse(request.body);
        const result = await service.createCheckoutSessionForCurrentOwner(
          request.user.organisationId,
          request.user.userId,
          request.user.sessionId,
          data.plan as SubscriptionPlan,
          data.interval,
        );
        return result;
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
        }
        handleError(reply, err);
      }
    };

    const createPortal = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await service.createPortalSessionForCurrentOwner(
          request.user.organisationId,
          request.user.userId,
          request.user.sessionId,
        );
      } catch (err) {
        handleError(reply, err);
      }
    };

    authedApp.post('/checkout', { preHandler: [requireOwner] }, createCheckout);
    authedApp.post('/create-checkout', { preHandler: [requireOwner] }, createCheckout);
    authedApp.post('/portal', { preHandler: [requireOwner] }, createPortal);
    authedApp.post('/create-portal', { preHandler: [requireOwner] }, createPortal);

    authedApp.get('/status', async (request, reply) => {
      try {
        return await service.getStatus(request.user.organisationId, {
          id: request.user.userId,
          sessionId: request.user.sessionId,
          role: request.user.role,
        });
      } catch (err) {
        handleError(reply, err);
      }
    });
  });
}
