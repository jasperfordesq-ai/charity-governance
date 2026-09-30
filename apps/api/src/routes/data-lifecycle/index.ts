import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/roles.js';
import { DATA_LIFECYCLE_COVERAGE_AREAS, DataLifecycleService } from '../../services/data-lifecycle.service.js';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const opaqueReference = z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/, 'Use an opaque uppercase case reference, not a name or email');
const receivedAt = z.string().datetime({ offset: true }).refine(
  (value) => Date.parse(value) <= Date.now(), 'Received time cannot be in the future',
);
const intakeSchema = z.object({
  caseReference: opaqueReference,
  kind: z.enum(['ERASURE', 'RETENTION_REVIEW']),
  scope: z.enum(['ACCOUNT', 'GOVERNANCE', 'DOCUMENT', 'INTEGRATION', 'ORGANISATION', 'OTHER']),
  receivedAt,
}).strict();
const triageSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  nextState: z.enum(['OPEN', 'ASSESSING', 'DECISION_REQUIRED']),
  reason: z.string().trim().min(10).max(500),
  evidenceRef: opaqueReference.optional(),
}).strict();
const responseTargetSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  targetResponseAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(10).max(500),
  evidenceRef: opaqueReference.optional(),
}).strict();
const responseSentSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  responseSentAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(10).max(500),
  evidenceRef: opaqueReference.optional(),
}).strict();
const coverageSchema = z.object({
  area: z.enum(DATA_LIFECYCLE_COVERAGE_AREAS),
  disposition: z.enum(['IN_SCOPE', 'NEEDS_FOLLOW_UP', 'NOT_APPLICABLE']),
  reason: z.string().trim().min(10).max(500),
  evidenceRef: opaqueReference.optional(),
}).strict();
const storageLinkSchema = z.object({
  deletionId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  reason: z.string().trim().min(10).max(500),
}).strict();
const documentLinkSchema = z.object({
  documentId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  reason: z.string().trim().min(10).max(500),
}).strict();
const withdrawalSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const requestQuerySchema = z.object({ before: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const lookupQuerySchema = z.object({ caseReference: opaqueReference }).strict();
const sourceLookupQuerySchema = z.object({
  sourceDocumentId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  before: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const historyQuerySchema = z.object({ before: z.string().min(1).max(100).optional() });
const idSchema = z.string().min(1).max(100);

function validationError(reply: FastifyReply, error: ZodError) {
  return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
}

async function requireDataLifecycleWebSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authSession.clientKind !== 'WEB') {
    return reply.status(403).send({
      error: 'Review data requests in the dashboard.',
      code: 'WEB_SESSION_REQUIRED',
    });
  }
}

export async function dataLifecycleRoutes(app: FastifyInstance) {
  const service = new DataLifecycleService(app.prisma);
  app.addHook('onRequest', authGuard);
  app.addHook('preHandler', requireAdmin);
  app.addHook('preHandler', requireDataLifecycleWebSession);

  app.get('/requests', async (request, reply) => {
    try {
      const { before } = requestQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.list(request.user.organisationId, before));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get('/requests/due-targets', async (request, reply) => {
    try {
      const { before } = requestQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listDueTargets(request.user.organisationId, before));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get('/audit', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listRecentEvents(request.user.organisationId));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/storage-deletions/by-source', async (request, reply) => {
    try {
      const { sourceDocumentId, before } = sourceLookupQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.findStorageDeletionsBySource(
        request.user.organisationId, sourceDocumentId, before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post('/requests', async (request, reply) => {
    try {
      const input = intakeSchema.parse(request.body);
      return sendCreated(reply, await service.create({
        ...input, receivedAt: new Date(input.receivedAt),
        organisationId: request.user.organisationId, actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get('/requests/by-reference', async (request, reply) => {
    try {
      const { caseReference } = lookupQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.getByReference(request.user.organisationId, caseReference));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.get(request.user.organisationId, idSchema.parse(request.params.id)));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/events', async (request, reply) => {
    try {
      const { before } = historyQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listEvents(request.user.organisationId, idSchema.parse(request.params.id), before));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/coverage', async (request, reply) => {
    try {
      return sendSuccess(reply, await service.listCoverage(request.user.organisationId, idSchema.parse(request.params.id)));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/coverage-events', async (request, reply) => {
    try {
      const { before } = historyQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listCoverageEvents(
        request.user.organisationId, idSchema.parse(request.params.id), before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/coverage', async (request, reply) => {
    try {
      const input = coverageSchema.parse(request.body);
      return sendCreated(reply, await service.recordCoverage({
        ...input, requestId: idSchema.parse(request.params.id),
        organisationId: request.user.organisationId, actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/target-events', async (request, reply) => {
    try {
      const { before } = historyQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listTargetEvents(
        request.user.organisationId, idSchema.parse(request.params.id), before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/response-events', async (request, reply) => {
    try {
      const { before } = historyQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listResponseEvents(
        request.user.organisationId, idSchema.parse(request.params.id), before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/storage-links', async (request, reply) => {
    try {
      const { before } = requestQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listStorageLinks(
        request.user.organisationId, idSchema.parse(request.params.id), before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/requests/:id/document-links', async (request, reply) => {
    try {
      const { before } = requestQuerySchema.parse(request.query);
      return sendSuccess(reply, await service.listDocumentLinks(
        request.user.organisationId, idSchema.parse(request.params.id), before,
      ));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/document-links', async (request, reply) => {
    try {
      const input = documentLinkSchema.parse(request.body);
      return sendCreated(reply, await service.linkDocument({
        ...input, organisationId: request.user.organisationId,
        requestId: idSchema.parse(request.params.id), actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string; linkId: string } }>('/requests/:id/document-links/:linkId/withdraw', async (request, reply) => {
    try {
      const input = withdrawalSchema.parse(request.body);
      return sendCreated(reply, await service.withdrawDocumentLink({
        ...input, organisationId: request.user.organisationId,
        requestId: idSchema.parse(request.params.id), linkId: idSchema.parse(request.params.linkId),
        actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/storage-links', async (request, reply) => {
    try {
      const input = storageLinkSchema.parse(request.body);
      return sendCreated(reply, await service.linkStorageDeletion({
        ...input, organisationId: request.user.organisationId,
        requestId: idSchema.parse(request.params.id), actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string; linkId: string } }>('/requests/:id/storage-links/:linkId/withdraw', async (request, reply) => {
    try {
      const input = withdrawalSchema.parse(request.body);
      return sendCreated(reply, await service.withdrawStorageLink({
        ...input, organisationId: request.user.organisationId,
        requestId: idSchema.parse(request.params.id), linkId: idSchema.parse(request.params.linkId),
        actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/triage', async (request, reply) => {
    try {
      const input = triageSchema.parse(request.body);
      return sendSuccess(reply, await service.triage({
        ...input, requestId: idSchema.parse(request.params.id),
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        organisationId: request.user.organisationId, actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/response-target', async (request, reply) => {
    try {
      const input = responseTargetSchema.parse(request.body);
      return sendSuccess(reply, await service.setResponseTarget({
        ...input, requestId: idSchema.parse(request.params.id),
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        targetResponseAt: input.targetResponseAt ? new Date(input.targetResponseAt) : null,
        organisationId: request.user.organisationId, actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/requests/:id/response-sent', async (request, reply) => {
    try {
      const input = responseSentSchema.parse(request.body);
      return sendSuccess(reply, await service.setResponseSentAt({
        ...input, requestId: idSchema.parse(request.params.id),
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        responseSentAt: input.responseSentAt ? new Date(input.responseSentAt) : null,
        organisationId: request.user.organisationId, actorUserId: request.user.userId,
      }));
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error);
      return handleError(reply, error);
    }
  });
}
