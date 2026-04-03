import type { FastifyRequest, FastifyReply } from 'fastify';

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

  if (subscription.status === 'TRIALING') {
    if (subscription.trialEndsAt && subscription.trialEndsAt < now) {
      reply.status(403).send({
        error: 'Your trial has expired. Please subscribe to continue.',
        code: 'TRIAL_EXPIRED',
      });
      return;
    }
    return; // Trial still active
  }

  if (subscription.status === 'ACTIVE') {
    return; // Paid and active
  }

  if (subscription.status === 'PAST_DUE') {
    return; // Still has access during grace period
  }

  reply.status(403).send({
    error: 'Your subscription is no longer active. Please resubscribe.',
    code: 'SUBSCRIPTION_INACTIVE',
  });
}
