import { registerCopyReviewRoutes } from '../copy-review.js';
import { CopyReviewService } from '../../services/copy-review.service.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { requireAdmin, requireOwner } from '../../middleware/roles.js';
import { RetentionPolicyService } from '../../services/retention-policy.service.js';
import { ComplaintRetentionService } from '../../services/complaint-retention.service.js';
import { ComplaintRecoveryService } from '../../services/complaint-recovery.service.js';
import { ComplaintHoldService } from '../../services/complaint-hold.service.js';
import { ComplaintPurgeService } from '../../services/complaint-purge.service.js';
import { requireSessionLevel } from '../../middleware/session-level.js';
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
  registerCopyReviewRoutes(app,'/complaints',new CopyReviewService(app.prisma,'COMPLAINT'),new RetentionPolicyService(app.prisma,'COMPLAINT_COPY'));
  const policies = new RetentionPolicyService(app.prisma, 'COMPLAINT');
  const retention = new ComplaintRetentionService(app.prisma);
  const recovery = new ComplaintRecoveryService(app.prisma);
  const holds = new ComplaintHoldService(app.prisma);
  const purge = new ComplaintPurgeService(app.prisma);
  app.get<{ Params: { id: string } }>('/complaints/purge-authorizations/:id/dispositions', { preHandler: [requireOwner, webOnly] }, async (request, reply) => {
    try { return sendSuccess(reply, await purge.listDispositions(request.user.organisationId, request.user.userId, request.params.id, request.query)); }
    catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/purge-authorizations/:id/dispositions', { preHandler: [requireOwner, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try { return sendCreated(reply, await purge.recordDisposition(request.user.organisationId, request.user.userId, request.params.id, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  app.get('/complaints/purge-authorizations', { preHandler: [requireOwner, webOnly] }, async (request, reply) => {
    try { return sendSuccess(reply, await purge.list(request.user.organisationId, request.user.userId, request.query)); }
    catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/:id/purge-authorizations', { preHandler: [requireOwner, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try { return sendCreated(reply, await purge.authorize(request.user.organisationId, request.params.id, request.user.userId, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/purge-authorizations/:id/withdraw', { preHandler: [requireOwner, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try { return sendCreated(reply, await purge.withdraw(request.user.organisationId, request.user.userId, request.params.id, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/purge-authorizations/:id/claim', { preHandler: [requireOwner, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try { return sendSuccess(reply, await purge.claim(request.user.organisationId, request.user.userId, request.params.id, request.body)); }
    catch (error) { return failure(reply, error); }
  });
  const revision = z.number().int().positive().max(2147483647);
  app.get<{ Params: { id: string } }>('/complaints/:id/holds', { preHandler: [requireAdmin, webOnly] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: z.coerce.number().int().positive().max(2147483647).optional() }).strict().parse(request.query);
      return sendSuccess(reply, await holds.list(request.user.organisationId, request.params.id, before));
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/:id/holds', { preHandler: [requireAdmin, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try {
      return sendCreated(reply, await holds.change(request.user.organisationId, request.params.id, request.user.userId, request.body));
    } catch (error) { return failure(reply, error); }
  });
  const removalInput = z.object({ expectedRevision: revision,
    expectedEvidenceRevision: z.number().int().nonnegative().max(2147483647),
    policyId: z.string().min(1).max(160), evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
    reason: z.string().trim().min(10).max(500).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/),
  }).strict();
  app.get('/complaints/removed', { preHandler: [requireAdmin, webOnly] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: z.string().min(1).max(160).optional() }).strict().parse(request.query);
      return sendSuccess(reply, await recovery.list(request.user.organisationId, before));
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/:id/remove', { preHandler: [requireAdmin, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try {
      return sendCreated(reply, await recovery.remove({ ...removalInput.parse(request.body),
        organisationId: request.user.organisationId, complaintId: request.params.id, actorUserId: request.user.userId }));
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/complaints/:id/restore', { preHandler: [requireAdmin, webOnly, requireSessionLevel('ADMIN')] }, async (request, reply) => {
    try {
      return sendSuccess(reply, await recovery.restore({ ...z.object({ expectedRevision: revision }).strict().parse(request.body),
        organisationId: request.user.organisationId, complaintId: request.params.id, actorUserId: request.user.userId }));
    } catch (error) { return failure(reply, error); }
  });
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
