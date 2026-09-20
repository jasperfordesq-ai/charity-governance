import type { FastifyInstance } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import {
  IRISH_COMPLIANCE_MATRIX,
  IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
} from '@charitypilot/shared';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import {
  complianceQuerySchema,
  upsertComplianceRecordSchema,
  upsertComplianceSignoffSchema,
  type UpsertComplianceRecordRequest,
  type UpsertComplianceSignoffRequest,
} from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { ZodError } from 'zod';

function reportingYear(query: unknown): number {
  const { year } = complianceQuerySchema.parse(query);
  return year ?? new Date().getFullYear();
}

export async function complianceRoutes(app: FastifyInstance) {
  const service = new ComplianceService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  /**
   * The regulator guidance behind the Governance Code, as reference data.
   *
   * The same for every charity in Ireland: which obligation each standard
   * carries, whether it is in force, what evidence it wants, whether a board
   * has to approve it, which specialist should look at it, and the sources
   * it is drawn from. No tenant data at all, which is why it needs no
   * filtering and why an agent can hold it as context for a whole session.
   *
   * Still behind the auth guard: it is the work that went into reading the
   * law, and there is no reason to serve it to anyone who asks.
   */
  app.get('/guidance', async (_request, reply) => {
    try {
      return sendSuccess(reply, {
        lastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
        entries: IRISH_COMPLIANCE_MATRIX.map((entry) => ({
          id: entry.id,
          principleNumbers: entry.principleNumbers,
          standardCodes: entry.standardCodes,
          featureArea: entry.featureArea,
          userTask: entry.userTask,
          commencementStatus: entry.commencementStatus,
          applicabilityNote: entry.applicabilityNote,
          evidenceRequired: entry.evidenceRequired,
          boardApproval: entry.boardApproval,
          professionalReview: entry.professionalReview,
          sourceRefs: entry.sourceRefs,
        })),
      });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // GET /principles — all 6 principles with standards (filtered by org complexity)
  app.get('/principles', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.getPrinciplesForOrganisation(request.user.organisationId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // GET /principles/:principleId - single principle with standards
  app.get<{ Params: { principleId: string } }>('/principles/:principleId', async (request, reply) => {
    try {
      const principle = await service.getPrincipleForOrganisation(request.user.organisationId, request.params.principleId);

      if (!principle) {
        return reply.status(404).send({
          error: 'Principle not found',
          code: 'PRINCIPLE_NOT_FOUND',
        });
      }

      return sendSuccess(reply, principle);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // GET /records?year=2026 — all compliance records for reporting year
  app.get('/records', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, await service.getRecords(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // GET /records/:standardId?year=2026 — single compliance record
  app.get<{ Params: { standardId: string } }>('/records/:standardId', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      const record = await service.getRecord(request.user.organisationId, request.params.standardId, year);
      return sendSuccess(reply, record);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // PUT /records/:standardId — upsert compliance record (auto-save)
  app.put<{ Params: { standardId: string } }>('/records/:standardId', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      if (
        !request.body
        || typeof request.body !== 'object'
        || !Object.prototype.hasOwnProperty.call(request.body, 'expectedRevision')
      ) {
        return reply.status(428).send({
          error: 'Reload this compliance record before saving it.',
          code: 'COMPLIANCE_RECORD_REVISION_REQUIRED',
        });
      }
      const data = upsertComplianceRecordSchema.parse(request.body) as UpsertComplianceRecordRequest;
      const record = await service.upsertRecord(
        request.user.organisationId,
        request.params.standardId,
        request.user.userId,
        data,
      );
      return sendSuccess(reply, record);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // GET /summary?year=2026 — compliance score summary
  app.get('/summary', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, await service.getSummary(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // GET /approval-readiness?year=2026 - records, evidence, profile facts, and prompts for board approval readiness
  app.get('/approval-readiness', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, await service.getApprovalReadiness(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // GET /signoff?year=2026 - board approval status for the annual Compliance Record
  app.get('/signoff', async (request, reply) => {
    try {
      const year = reportingYear(request.query);
      return sendSuccess(reply, await service.getSignoff(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // PUT /signoff - create/update the board approval record for the annual Compliance Record
  app.put('/signoff', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      if (
        !request.body
        || typeof request.body !== 'object'
        || !Object.prototype.hasOwnProperty.call(request.body, 'expectedRevision')
      ) {
        return reply.status(428).send({
          error: 'Reload the board signoff before saving it.',
          code: 'COMPLIANCE_SIGNOFF_REVISION_REQUIRED',
        });
      }
      if (
        (request.body as { status?: unknown }).status === 'APPROVED'
        && !Object.prototype.hasOwnProperty.call(request.body, 'expectedEvidenceHash')
      ) {
        return reply.status(428).send({
          error: 'Refresh approval readiness before recording board approval.',
          code: 'COMPLIANCE_APPROVAL_EVIDENCE_REQUIRED',
        });
      }
      const data = upsertComplianceSignoffSchema.parse(request.body) as UpsertComplianceSignoffRequest;
      return sendSuccess(reply, await service.upsertSignoff(request.user.organisationId, request.user.userId, data));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });
}
