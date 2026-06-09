import type { FastifyReply, FastifyRequest } from 'fastify';
import { SubscriptionPlan } from '@charitypilot/shared';

export async function requireCompletePlan(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { organisationId } = request.user;
  const subscription = await request.server.prisma.subscription.findUnique({
    where: { organisationId },
    select: { plan: true },
  });

  if (subscription?.plan === SubscriptionPlan.COMPLETE) {
    return;
  }

  reply.status(403).send({
    error: 'This feature requires the Complete plan.',
    code: 'PLAN_FEATURE_UNAVAILABLE',
  });
}
