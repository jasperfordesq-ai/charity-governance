import type { FastifyInstance } from 'fastify';
import { BoardMemberService } from '../../services/board-member.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { createBoardMemberSchema, updateBoardMemberSchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { ZodError } from 'zod';

export async function boardMemberRoutes(app: FastifyInstance) {
  const service = new BoardMemberService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      return await service.list(request.user.organisationId);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const data = createBoardMemberSchema.parse(request.body);
      const member = await service.create(request.user.organisationId, data);
      return reply.status(201).send(member);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const data = updateBoardMemberSchema.parse(request.body);
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
