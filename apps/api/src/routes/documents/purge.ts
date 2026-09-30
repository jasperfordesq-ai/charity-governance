import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DocumentPurgeService, purgeId } from '../../services/document-purge.service.js';
import { requireAdmin, requireOwner } from '../../middleware/roles.js';
import { requireSessionLevel, requireWebSession } from '../../middleware/session-level.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

/** Registered inside the authenticated/subscription-guarded document routes. */
export function registerDocumentPurgeRoutes(app: FastifyInstance, service: DocumentPurgeService) {
  app.get('/purge-authorizations', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try { return sendSuccess(reply, await service.list(request.user.organisationId, request.query)); }
    catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Invalid purge history query' });
      return handleError(reply, error);
    }
  });
  app.post('/purge-authorizations', { preHandler: [requireSessionLevel('ADMIN'), requireOwner, requireWebSession] }, async (request, reply) => {
    try { return sendCreated(reply, await service.authorize(request.user.organisationId, request.user.userId, request.body)); }
    catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Review every disposal plan field and confirm your authority', details: error.errors });
      return handleError(reply, error);
    }
  });
  app.get<{ Params: { id: string } }>('/purge-authorizations/:id/dispositions', {
    preHandler: [requireAdmin, requireWebSession],
  }, async (request, reply) => {
    try { return sendSuccess(reply, await service.listDispositions(request.user.organisationId,
      purgeId.parse(request.params.id), request.query)); }
    catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Invalid disposal evidence history query' });
      return handleError(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/purge-authorizations/:id/dispositions', {
    preHandler: [requireSessionLevel('ADMIN'), requireOwner, requireWebSession],
  }, async (request, reply) => {
    try { return sendSuccess(reply, await service.recordDisposition(request.user.organisationId,
      request.user.userId, purgeId.parse(request.params.id), request.body)); }
    catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Review the scope, evidence, outcome and follow-up date', details: error.errors });
      return handleError(reply, error);
    }
  });
  for (const operation of ['withdraw', 'claim'] as const) {
    app.post<{ Params: { id: string } }>(`/purge-authorizations/:id/${operation}`, {
      preHandler: [requireSessionLevel('ADMIN'), requireOwner, requireWebSession],
    }, async (request, reply) => {
      try {
        return sendSuccess(reply, await service[operation](request.user.organisationId, request.user.userId,
          purgeId.parse(request.params.id), request.body));
      } catch (error) {
        if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Review and confirm this disposal action', details: error.errors });
        return handleError(reply, error);
      }
    });
  }
}
