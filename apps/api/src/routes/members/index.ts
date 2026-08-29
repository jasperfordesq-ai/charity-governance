import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { requireCompletePlan } from '../../middleware/plan.js';
import { handleError } from '../../utils/errors.js';
import { MemberService } from '../../services/member.service.js';
import { createMemberSchema, updateMemberSchema } from '@charitypilot/shared';

export async function memberRoutes(app: FastifyInstance) {
  const service = new MemberService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  app.addHook('onRequest', requireCompletePlan);

  // GET /api/v1/members?includeFormer=true
  app.get('/', async (request, reply) => {
    try {
      const { includeFormer } = request.query as { includeFormer?: string };
      const members = await service.list(
        request.user.organisationId,
        includeFormer === 'true',
      );
      return reply.send(members);
    } catch (err) {
      handleError(reply, err);
    }
  });

  // POST /api/v1/members
  app.post('/', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const input = createMemberSchema.parse(request.body);
      const member = await service.create(request.user.organisationId, input);
      return reply.status(201).send(member);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // PATCH /api/v1/members/:id
  app.patch('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = updateMemberSchema.parse(request.body);
      const member = await service.update(request.user.organisationId, id, input);
      return reply.send(member);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });
}
