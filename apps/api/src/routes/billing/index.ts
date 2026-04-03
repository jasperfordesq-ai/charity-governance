import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { BillingService } from '../../services/billing.service.js';
import { authGuard } from '../../middleware/auth.js';
import { createCheckoutSchema, type SubscriptionPlan } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
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
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');
        const sig = request.headers['stripe-signature'] as string;
        const rawBody = request.body as Buffer;

        const event = stripe.webhooks.constructEvent(
          rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET ?? '',
        );

        await service.handleWebhook(event);
        return { received: true };
      } catch (err) {
        app.log.error(err);
        return reply.status(400).send({ error: 'Webhook signature verification failed' });
      }
    });
  });

  // ── Authenticated billing routes ──
  app.register(async (authedApp: FastifyInstance) => {
    authedApp.addHook('onRequest', authGuard);

    authedApp.post('/create-checkout', async (request, reply) => {
      try {
        const data = createCheckoutSchema.parse(request.body);
        const result = await service.createCheckoutSession(
          request.user.organisationId,
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
    });

    authedApp.post('/create-portal', async (request, reply) => {
      try {
        return await service.createPortalSession(request.user.organisationId);
      } catch (err) {
        handleError(reply, err);
      }
    });

    authedApp.get('/status', async (request, reply) => {
      try {
        return await service.getStatus(request.user.organisationId);
      } catch (err) {
        handleError(reply, err);
      }
    });
  });
}
