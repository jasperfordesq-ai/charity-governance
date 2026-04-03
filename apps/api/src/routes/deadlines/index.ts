import type { FastifyInstance } from 'fastify';
import { DeadlineService } from '../../services/deadline.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { createDeadlineSchema, updateDeadlineSchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { ZodError } from 'zod';

export async function deadlineRoutes(app: FastifyInstance) {
  const service = new DeadlineService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      const { page, pageSize } = request.query as { page?: string; pageSize?: string };
      return await service.list(
        request.user.organisationId,
        Math.max(1, parseInt(page ?? '1', 10) || 1),
        Math.min(100, Math.max(1, parseInt(pageSize ?? '50', 10) || 50)),
      );
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const data = createDeadlineSchema.parse(request.body);
      const deadline = await service.create(request.user.organisationId, data);
      return reply.status(201).send(deadline);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const data = updateDeadlineSchema.parse(request.body);
      return await service.update(request.user.organisationId, request.params.id, data);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      await service.remove(request.user.organisationId, request.params.id);
      return reply.status(204).send();
    } catch (err) {
      handleError(reply, err);
    }
  });
}
