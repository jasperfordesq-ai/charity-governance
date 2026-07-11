import type { FastifyInstance } from 'fastify';
import { DeadlineService } from '../../services/deadline.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { createDeadlineSchema, deleteDeadlineSchema, updateDeadlineSchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../utils/response.js';
import { ZodError } from 'zod';

export async function deadlineRoutes(app: FastifyInstance) {
  const service = new DeadlineService(app.prisma);
  const pagination = (query: { page?: string; pageSize?: string }) => ({
    page: Math.max(1, parseInt(query.page ?? '1', 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50)),
  });

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      const { page, pageSize } = request.query as { page?: string; pageSize?: string };
      const bounds = pagination({ page, pageSize });
      return await service.list(request.user.organisationId, bounds.page, bounds.pageSize);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/history', async (request, reply) => {
    try {
      const { page, pageSize } = request.query as { page?: string; pageSize?: string };
      const bounds = pagination({ page, pageSize });
      return await service.history(request.user.organisationId, bounds.page, bounds.pageSize);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/reminder-history', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const query = request.query as {
        page?: string;
        pageSize?: string;
        deadlineId?: string;
        status?: string;
      };
      const bounds = pagination(query);
      const status = query.status?.toUpperCase();
      if (status && !['RESERVED', 'SENT', 'SKIPPED', 'FAILED', 'SENDING', 'UNCERTAIN'].includes(status)) {
        return reply.status(400).send({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: [{ path: ['status'], message: 'Unknown reminder status' }],
        });
      }
      return await service.reminderHistory(
        request.user.organisationId,
        bounds.page,
        bounds.pageSize,
        { deadlineId: query.deadlineId, status },
      );
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createDeadlineSchema.parse(request.body);
      const deadline = await service.create(request.user.organisationId, data);
      return sendCreated(reply, deadline);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateDeadlineSchema.parse(request.body);
      return sendSuccess(reply, await service.update(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = deleteDeadlineSchema.parse(request.body);
      await service.remove(request.user.organisationId, request.params.id, data.expectedUpdatedAt);
      return sendNoContent(reply);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });
}
