import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { requireAdmin, requireOwner } from '../../middleware/roles.js';
import { RetentionPolicyService } from '../../services/retention-policy.service.js';
import { ComplaintRetentionService } from '../../services/complaint-retention.service.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

async function webOnly(request: FastifyRequest, reply: FastifyReply) {
  if (request.authSession.clientKind !== 'WEB') return reply.status(403).send({
    code: 'WEB_SESSION_REQUIRED', error: 'Review complaint retention in the dashboard.',
  });
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
  return handleError(reply, error);
}

export function registerComplaintRetentionRoutes(app: FastifyInstance) {
  const policies = new RetentionPolicyService(app.prisma, 'COMPLAINT');
  const retention = new ComplaintRetentionService(app.prisma);
  app.get('/complaints/policy-revisions', { preHandler: [requireAdmin, webOnly] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: z.coerce.number().int().positive().max(2147483647).optional() }).strict().parse(request.query);
      return sendSuccess(reply, await policies.list(request.user.organisationId, before));
    } catch (error) { return failure(reply, error); }
  });
  app.post('/complaints/policy-revisions', { preHandler: [requireAdmin, webOnly] }, async (request, reply) => {
    try { return sendCreated(reply, await policies.create(request.user.organisationId, request.user.userId, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/policy-revisions/:id/withdraw', { preHandler: [requireOwner, webOnly] }, async (request, reply) => {
    try { return sendCreated(reply, await policies.withdraw(request.user.organisationId, request.user.userId, request.params.id, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  app.get<{ Params: { id: string } }>('/complaints/:id/retention-assessment', { preHandler: [requireAdmin, webOnly] }, async (request, reply) => {
    try { return sendSuccess(reply, await retention.assess(request.user.organisationId, request.params.id)); }
    catch (error) { return failure(reply, error); }
  });
}
