import type { FastifyInstance } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { upsertComplianceRecordSchema, complianceQuerySchema, type UpsertComplianceRecordRequest } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { ZodError } from 'zod';

export async function complianceRoutes(app: FastifyInstance) {
  const service = new ComplianceService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  // GET /principles — all 6 principles with standards (filtered by org complexity)
  app.get('/principles', async (request, reply) => {
    try {
      const org = await app.prisma.organisation.findUniqueOrThrow({
        where: { id: request.user.organisationId },
      });
      return sendSuccess(reply, await service.getPrinciples(org.complexity));
    } catch (err) {
      handleError(reply, err);
    }
  });

  // GET /records?year=2026 — all compliance records for reporting year
  app.get('/records', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.getRecords(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // GET /records/:standardId?year=2026 — single compliance record
  app.get<{ Params: { standardId: string } }>('/records/:standardId', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      const record = await service.getRecord(request.user.organisationId, request.params.standardId, year);
      return sendSuccess(reply, record ?? { status: 'NOT_STARTED' });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // PUT /records/:standardId — upsert compliance record (auto-save)
  app.put<{ Params: { standardId: string } }>('/records/:standardId', async (request, reply) => {
    try {
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
      handleError(reply, err);
    }
  });

  // GET /summary?year=2026 — compliance score summary
  app.get('/summary', async (request, reply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.getSummary(request.user.organisationId, year));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });
}
