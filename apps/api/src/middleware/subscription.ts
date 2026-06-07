import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasSubscriptionAccess } from '../utils/subscription-access.js';

/**
 * Ensures the user's organisation has an active subscription or is within a trial period.
 * Must be used after authGuard.
 */
export async function subscriptionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { organisationId } = request.user;

  const subscription = await request.server.prisma.subscription.findUnique({
    where: { organisationId },
  });

  if (!subscription) {
    reply.status(403).send({
      error: 'No active subscription. Please subscribe to continue.',
      code: 'NO_SUBSCRIPTION',
    });
    return;
  }

  const now = new Date();

  if (hasSubscriptionAccess(subscription, now)) {
    return;
  }

  if (subscription.status === 'TRIALING') {
    if (subscription.trialEndsAt && subscription.trialEndsAt <= now) {
      reply.status(403).send({
        error: 'Your trial has expired. Please subscribe to continue.',
        code: 'TRIAL_EXPIRED',
      });
      return;
    }
  }

  if (subscription.status === 'PAST_DUE') {
    reply.status(403).send({
      error: 'Your payment is past due and the grace period has ended. Please update billing to continue.',
      code: 'PAST_DUE_GRACE_EXPIRED',
    });
    return;
  }

  reply.status(403).send({
    error: 'Your subscription is no longer active. Please resubscribe.',
    code: 'SUBSCRIPTION_INACTIVE',
  });
}
