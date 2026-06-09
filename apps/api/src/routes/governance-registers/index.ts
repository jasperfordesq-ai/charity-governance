import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  complianceQuerySchema,
  createComplaintRecordSchema,
  createConflictRecordSchema,
  createFundraisingRecordSchema,
  createRiskRecordSchema,
  updateComplaintRecordSchema,
  updateConflictRecordSchema,
  updateFundraisingRecordSchema,
  updateRiskRecordSchema,
  upsertAnnualReportReadinessSchema,
  upsertFinancialControlReviewSchema,
  type CreateComplaintRecordRequest,
  type CreateConflictRecordRequest,
  type CreateFundraisingRecordRequest,
  type CreateRiskRecordRequest,
  type UpdateComplaintRecordRequest,
  type UpdateConflictRecordRequest,
  type UpdateFundraisingRecordRequest,
  type UpdateRiskRecordRequest,
  type UpsertAnnualReportReadinessRequest,
  type UpsertFinancialControlReviewRequest,
} from '@charitypilot/shared';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireCompletePlan } from '../../middleware/plan.js';
import { requireAdmin } from '../../middleware/roles.js';
import { GovernanceRegisterService } from '../../services/governance-register.service.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/response.js';

function validationError(reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
}

export async function governanceRegisterRoutes(app: FastifyInstance) {
  const service = new GovernanceRegisterService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  app.addHook('preHandler', requireCompletePlan);

  app.get('/summary', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.summary(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.get('/conflicts', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listConflicts(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/conflicts', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createConflictRecordSchema.parse(request.body) as CreateConflictRecordRequest;
      return sendCreated(reply, await service.createConflict(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/conflicts/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateConflictRecordSchema.parse(request.body) as UpdateConflictRecordRequest;
      return sendSuccess(reply, await service.updateConflict(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/conflicts/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      await service.removeConflict(request.user.organisationId, request.params.id);
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/risks', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listRisks(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/risks', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createRiskRecordSchema.parse(request.body) as CreateRiskRecordRequest;
      return sendCreated(reply, await service.createRisk(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/risks/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateRiskRecordSchema.parse(request.body) as UpdateRiskRecordRequest;
      return sendSuccess(reply, await service.updateRisk(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/risks/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      await service.removeRisk(request.user.organisationId, request.params.id);
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/complaints', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listComplaints(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/complaints', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createComplaintRecordSchema.parse(request.body) as CreateComplaintRecordRequest;
      return sendCreated(reply, await service.createComplaint(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/complaints/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateComplaintRecordSchema.parse(request.body) as UpdateComplaintRecordRequest;
      return sendSuccess(reply, await service.updateComplaint(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/complaints/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      await service.removeComplaint(request.user.organisationId, request.params.id);
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/fundraising', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listFundraising(request.user.organisationId));
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post('/fundraising', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createFundraisingRecordSchema.parse(request.body) as CreateFundraisingRecordRequest;
      return sendCreated(reply, await service.createFundraising(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/fundraising/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = updateFundraisingRecordSchema.parse(request.body) as UpdateFundraisingRecordRequest;
      return sendSuccess(reply, await service.updateFundraising(request.user.organisationId, request.params.id, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/fundraising/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      await service.removeFundraising(request.user.organisationId, request.params.id);
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get('/annual-report', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.getAnnualReportReadiness(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.put('/annual-report', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = upsertAnnualReportReadinessSchema.parse(request.body) as UpsertAnnualReportReadinessRequest;
      return sendSuccess(reply, await service.upsertAnnualReportReadiness(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.get('/financial-controls', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.getFinancialControlReview(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });

  app.put('/financial-controls', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = upsertFinancialControlReviewSchema.parse(request.body) as UpsertFinancialControlReviewRequest;
      return sendSuccess(reply, await service.upsertFinancialControlReview(request.user.organisationId, data));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      handleError(reply, err);
    }
  });
}
