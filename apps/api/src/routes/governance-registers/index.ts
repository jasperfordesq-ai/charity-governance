import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
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
import { requireSessionLevel } from '../../middleware/session-level.js';
import { requireActionApproval } from '../../middleware/action-approval.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireCompletePlan } from '../../middleware/plan.js';
import { requireAdmin } from '../../middleware/roles.js';
import { GovernanceRegisterService } from '../../services/governance-register.service.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/response.js';

function validationError(reply: FastifyReply, err: ZodError) {
  return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
}

async function requireControlReviewWebSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authSession.clientKind !== 'WEB') {
    return reply.status(403).send({ error: 'Review control evidence in the dashboard.', code: 'WEB_SESSION_REQUIRED' });
  }
}

function reportingYear(query: unknown): number {
  const { year } = complianceQuerySchema.parse(query);
  return year ?? new Date().getFullYear();
}

// Member responses are deliberately assembled from safe fields rather than
// spreading a Prisma row. A future free-text column cannot leak by accident.
function memberRisk(row: Awaited<ReturnType<GovernanceRegisterService['listMemberRisks']>>[number]) {
  return {
    id: row.id, organisationId: row.organisationId, title: '',
    category: row.category, description: '', likelihood: row.likelihood,
    impact: row.impact, mitigation: '', owner: null,
    reviewDate: row.reviewDate, status: row.status,
    boardMinuteReference: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function memberFundraising(row: Awaited<ReturnType<GovernanceRegisterService['listMemberFundraising']>>[number]) {
  return {
    id: row.id, organisationId: row.organisationId, name: '',
    activityType: row.activityType, startDate: row.startDate, endDate: row.endDate,
    publicFacing: row.publicFacing, thirdPartyFundraiser: null, controls: null,
    complaintsReceived: row.complaintsReceived, reviewOutcome: null,
    status: row.status, boardMinuteReference: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

const riskControlCommon = {
  controlReference: z.string().trim().min(2).max(120),
  affectedRelease: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(10).max(500),
};
const riskControlVerificationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('VERIFIED'), ...riskControlCommon,
    verifiedAt: z.string().datetime({ offset: true }).refine(
      (value) => Date.parse(value) <= Date.now(), 'Verification time cannot be in the future',
    ),
    evidenceReference: z.string().trim().min(3).max(500),
  }),
  z.object({ state: z.literal('WITHDRAWN'), ...riskControlCommon }),
]);
const riskControlHistoryQuerySchema = z.object({
  before: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
  controlReference: z.string().trim().min(2).max(120).optional(),
}).strict();
const riskControlAttentionQuerySchema = z.object({
  after: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const riskAuditQuerySchema = z.object({
  before: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const registerAuditQuerySchema = riskAuditQuerySchema;

const complaintResolutionCommon = {
  expectedRecordRevision: z.number().int().positive().max(2147483647),
  expectedEvidenceRevision: z.number().int().nonnegative().max(2147483646),
  evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  reason: z.string().trim().min(10).max(500).regex(/^[^\x00-\x1f\x7f]*$/),
};
const complaintResolutionSchema = z.discriminatedUnion('state', [
  z.object({ ...complaintResolutionCommon, state: z.literal('RECORDED'), resolvedAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ ...complaintResolutionCommon, state: z.literal('WITHDRAWN') }).strict(),
]);
const complaintResolutionQuerySchema = z.object({
  beforeRevision: z.coerce.number().int().positive().max(2147483647).optional(),
}).strict();

export async function governanceRegisterRoutes(app: FastifyInstance) {
  const service = new GovernanceRegisterService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  app.addHook('preHandler', requireCompletePlan);

  // The summary includes counts of restricted conflicts and complaints.
  app.get('/summary', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, await service.summary(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get('/conflicts', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listConflicts(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/conflicts/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      return sendSuccess(
        reply,
        await service.getRecord('conflict', request.user.organisationId, request.params.id),
      );
    } catch (err) {
      return handleError(reply, err);
    }
  });
  app.post('/conflicts', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createConflictRecordSchema.parse(request.body) as CreateConflictRecordRequest;
      return sendCreated(reply, await service.createConflict(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/conflicts/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { expectedUpdatedAt, ...data } = updateConflictRecordSchema.parse(request.body) as UpdateConflictRecordRequest & { expectedUpdatedAt?: string };
      return sendSuccess(reply, await service.updateConflict(request.user.organisationId, request.params.id, data, expectedUpdatedAt, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/conflicts/:id', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      await service.removeConflict(request.user.organisationId, request.params.id, request.user.userId);
      return sendNoContent(reply);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/risks', async (request, reply) => {
    try {
      if (request.user.role === 'MEMBER') {
        const rows = await service.listMemberRisks(request.user.organisationId);
        return sendSuccess(reply, rows.map(memberRisk));
      }
      return sendSuccess(reply, await service.listRisks(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/risks/audit', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const { before } = riskAuditQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listRiskAudit(request.user.organisationId, before));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get('/risks/control-verifications', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listRiskControlVerifications(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/risks/control-review-attention', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const { after } = riskControlAttentionQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listRiskControlReviewAttention(request.user.organisationId, after));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/risks/:id/control-verifications', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const { before, controlReference } = riskControlHistoryQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listRiskControlHistory(
        request.user.organisationId, request.params.id, before, controlReference,
      ));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/risks/:id/control-verifications', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const data = riskControlVerificationSchema.parse(request.body);
      return sendCreated(reply, await service.recordRiskControlVerification({
        ...data, organisationId: request.user.organisationId, riskId: request.params.id,
        actorUserId: request.user.userId,
      }));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/risks/:id', async (request, reply) => {
    try {
      if (request.user.role === 'MEMBER') {
        const row = await service.getMemberRisk(request.user.organisationId, request.params.id);
        return sendSuccess(reply, memberRisk(row));
      }
      return sendSuccess(reply, await service.getRecord('risk', request.user.organisationId, request.params.id));
    } catch (err) {
      return handleError(reply, err);
    }
  });
  app.post('/risks', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createRiskRecordSchema.parse(request.body) as CreateRiskRecordRequest;
      return sendCreated(reply, await service.createRisk(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/risks/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { expectedUpdatedAt, ...data } = updateRiskRecordSchema.parse(request.body) as UpdateRiskRecordRequest & { expectedUpdatedAt?: string };
      return sendSuccess(reply, await service.updateRisk(request.user.organisationId, request.params.id, data, expectedUpdatedAt, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/risks/:id', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      await service.removeRisk(request.user.organisationId, request.params.id, request.user.userId);
      return sendNoContent(reply);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/complaints/:id/resolution-evidence', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const { beforeRevision } = complaintResolutionQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listComplaintResolutionEvidence(request.user.organisationId, request.params.id, beforeRevision));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/complaints/:id/resolution-evidence', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const data = complaintResolutionSchema.parse(request.body);
      return sendCreated(reply, await service.recordComplaintResolutionEvidence({
        ...data, organisationId: request.user.organisationId, complaintId: request.params.id,
        actorUserId: request.user.userId,
      }));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get('/complaints', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listComplaints(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/change-audit', { preHandler: [requireAdmin, requireControlReviewWebSession] }, async (request, reply) => {
    try {
      const { before } = registerAuditQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listRegisterAudit(request.user.organisationId, before));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/complaints/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      return sendSuccess(
        reply,
        await service.getRecord('complaint', request.user.organisationId, request.params.id),
      );
    } catch (err) {
      return handleError(reply, err);
    }
  });
  app.post('/complaints', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createComplaintRecordSchema.parse(request.body) as CreateComplaintRecordRequest;
      return sendCreated(reply, await service.createComplaint(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/complaints/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { expectedUpdatedAt, ...data } = updateComplaintRecordSchema.parse(request.body) as UpdateComplaintRecordRequest & { expectedUpdatedAt?: string };
      return sendSuccess(reply, await service.updateComplaint(request.user.organisationId, request.params.id, data, expectedUpdatedAt, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/complaints/:id', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      await service.removeComplaint(request.user.organisationId, request.params.id, request.user.userId);
      return sendNoContent(reply);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/fundraising', async (request, reply) => {
    try {
      if (request.user.role === 'MEMBER') {
        const rows = await service.listMemberFundraising(request.user.organisationId);
        return sendSuccess(reply, rows.map(memberFundraising));
      }
      return sendSuccess(reply, await service.listFundraising(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/fundraising/:id', async (request, reply) => {
    try {
      if (request.user.role === 'MEMBER') {
        const row = await service.getMemberFundraising(request.user.organisationId, request.params.id);
        return sendSuccess(reply, memberFundraising(row));
      }
      return sendSuccess(reply, await service.getRecord('fundraising', request.user.organisationId, request.params.id));
    } catch (err) {
      return handleError(reply, err);
    }
  });
  app.post('/fundraising', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = createFundraisingRecordSchema.parse(request.body) as CreateFundraisingRecordRequest;
      return sendCreated(reply, await service.createFundraising(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/fundraising/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { expectedUpdatedAt, ...data } = updateFundraisingRecordSchema.parse(request.body) as UpdateFundraisingRecordRequest & { expectedUpdatedAt?: string };
      return sendSuccess(reply, await service.updateFundraising(request.user.organisationId, request.params.id, data, expectedUpdatedAt, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/fundraising/:id', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      await service.removeFundraising(request.user.organisationId, request.params.id, request.user.userId);
      return sendNoContent(reply);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/annual-report', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, request.user.role === 'MEMBER'
        ? await service.getMemberAnnualReportReadiness(request.user.organisationId, year)
        : await service.getAnnualReportReadiness(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.put('/annual-report', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = upsertAnnualReportReadinessSchema.parse(request.body) as UpsertAnnualReportReadinessRequest;
      return sendSuccess(reply, await service.upsertAnnualReportReadiness(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.get('/financial-controls', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, request.user.role === 'MEMBER'
        ? await service.getMemberFinancialControlReview(request.user.organisationId, year)
        : await service.getFinancialControlReview(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });

  app.put('/financial-controls', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = upsertFinancialControlReviewSchema.parse(request.body) as UpsertFinancialControlReviewRequest;
      return sendSuccess(reply, await service.upsertFinancialControlReview(request.user.organisationId, data, request.user.userId));
    } catch (err) {
      if (err instanceof ZodError) return validationError(reply, err);
      return handleError(reply, err);
    }
  });
}
