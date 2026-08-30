import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  createGoverningActSchema,
  updateGoverningActSchema,
  createResolutionSchema,
  updateResolutionSchema,
  setDocumentApprovalSchema,
  governingActQuerySchema,
  voidGoverningActSchema,
  type CreateGoverningActRequest,
  type UpdateGoverningActRequest,
  type CreateResolutionRequest,
  type UpdateResolutionRequest,
  type VoidGoverningActRequest,
} from '@charitypilot/shared';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireCompletePlan } from '../../middleware/plan.js';
import { requireAdmin } from '../../middleware/roles.js';
import { GoverningActService } from '../../services/governing-act.service.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

function validationError(reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: err.errors,
  });
}

export async function governingActRoutes(app: FastifyInstance) {
  const service = new GoverningActService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  app.addHook('preHandler', requireCompletePlan);

  // ── Governing Acts ──────────────────────────────────────────────────────────

  app.get('/', async (request, reply) => {
    try {
      const query = governingActQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.list(request.user.organisationId, query));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.post('/', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createGoverningActSchema.parse(request.body) as CreateGoverningActRequest;
      return sendCreated(reply, await service.create(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateGoverningActSchema.parse(request.body) as UpdateGoverningActRequest;
      return sendSuccess(reply, await service.update(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  // ── Resolutions ─────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/:id/resolutions',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      try {
        const data = createResolutionSchema.parse(request.body) as CreateResolutionRequest;
        return sendCreated(
          reply,
          await service.createResolution(request.user.organisationId, request.params.id, data),
        );
      } catch (err) {
        if (err instanceof ZodError) return validationError(reply, err);
        handleError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/resolutions/:id',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      try {
        const data = updateResolutionSchema.parse(request.body) as UpdateResolutionRequest;
        return sendSuccess(
          reply,
          await service.updateResolution(request.user.organisationId, request.params.id, data),
        );
      } catch (err) {
        if (err instanceof ZodError) return validationError(reply, err);
        handleError(reply, err);
      }
    },
  );

  // ── Void (permanent removal, audited) ───────────────────────────────────────

  // Static path first so it is never captured by /:id.
  app.get('/voids', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listVoids(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/void', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = voidGoverningActSchema.parse(request.body) as VoidGoverningActRequest;
      return sendSuccess(
        reply,
        await service.voidAct(request.user.organisationId, request.params.id, request.user.userId, data),
      );
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  // ── Board Submissions ───────────────────────────────────────────────────────

  app.get('/board-submissions', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.getBoardSubmissions(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── Document approval (enforces rules 1 & 2) ────────────────────────────────

  app.patch<{ Params: { documentId: string } }>(
    '/documents/:documentId/approval',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      try {
        const data = setDocumentApprovalSchema.parse(request.body);
        await service.setDocumentApproval(
          request.user.organisationId,
          request.params.documentId,
          data.approvedByResolutionId,
          data.approvalAsserted,
          data.expectedUpdatedAt,
        );
        return sendSuccess(reply, { ok: true });
      } catch (err) {
        if (err instanceof ZodError) return validationError(reply, err);
        handleError(reply, err);
      }
    },
  );
}
