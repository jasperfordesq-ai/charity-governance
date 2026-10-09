import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { DocumentService } from '../../services/document.service.js';
import { DocumentRecoveryService } from '../../services/document-recovery.service.js';
import { RetentionPolicyService } from '../../services/retention-policy.service.js';
import { DocumentPurgeService } from '../../services/document-purge.service.js';
import { registerDocumentPurgeRoutes } from './purge.js';
import { StorageService } from '../../services/storage.service.js';
import { authGuard } from '../../middleware/auth.js';
import { requireSessionLevel, requireWebSession } from '../../middleware/session-level.js';
import { requireActionApproval } from '../../middleware/action-approval.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin, requireOwner } from '../../middleware/roles.js';
import { uploadDocumentSchema, updateDocumentSchema, linkStandardSchema } from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import {
  mirrorsForDocuments,
  retryFailedPublication,
} from '../../services/document-mirror.service.js';
import { confluencePublishTargetForOrganisation, confluenceSiteIdFromConfig,
  readConfluencePublishTarget } from '../../services/confluence-publish-target.service.js';
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/response.js';
import { createPrismaOrganisationStorageResolver } from '../../services/document-storage-resolution.js';
import { z, ZodError } from 'zod';
import {
  DOCUMENT_UPLOAD_MAX_FILE_SIZE,
  DOCUMENT_UPLOAD_MULTIPART_LIMITS,
  hasAllowedExtension,
  hasAllowedMimeType,
  hasValidSignature,
  isFileTooLargeError,
  isMultipartLimitError,
} from './document-upload-validation.js';

export { DOCUMENT_UPLOAD_MAX_FILE_SIZE, DOCUMENT_UPLOAD_MULTIPART_LIMITS } from './document-upload-validation.js';

const requeueStorageDeletionSchema = z.object({
  reason: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .pipe(
      z
        .string()
        // `char_length` in the `DocumentStorageDeletionRecovery_reason_bounded`
        // CHECK this backs counts Unicode code points, not UTF-16 code
        // units — zod's built-in `.min()`/`.max()` count `.length`, which is
        // code units. Five astral-plane characters (most emoji) are ten
        // UTF-16 units but five code points: `.min(10)` would accept them
        // and the CHECK would then reject the INSERT, turning a 400 into a
        // 500. `Array.from` iterates by code point (the same idiom
        // `confluenceErasureSchema` in `routes/integrations/index.ts` uses
        // for this), so counting its length agrees with Postgres.
        .refine(
          (value) => Array.from(value).length >= 10,
          'Give a recovery reason of at least 10 characters',
        )
        .refine(
          (value) => Array.from(value).length <= 500,
          'Recovery reason must be at most 500 characters',
        )
        // Mirrors `confluenceErasureSchema` in `routes/integrations/index.ts`
        // exactly — both back a CHECK of the same shape, so the two must read
        // the same. Postgres's `[[:cntrl:]]` also matches the C1 block,
        // U+0080-U+009F, which is not JavaScript whitespace so `.trim()` leaves
        // it in place; omitting that range here let a reason pass this
        // refinement and then violate the CHECK, turning a 400 into a 500.
        .refine(
          (value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(value),
          'Recovery reason contains unsupported control characters',
        ),
    ),
  confirmation: z.literal('REQUEUE DOCUMENT STORAGE DELETION'),
  disposition: z.literal('REQUEUE_UNCHANGED'),
}).strict();
const storageDeletionIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const documentControlCursorSchema = z.string().regex(/^(control|visibility):[A-Za-z0-9_-]{1,160}$/);
const deletionHoldSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  held: z.boolean(),
  reason: z.string().trim()
    .refine((value) => Array.from(value).length >= 10 && Array.from(value).length <= 500,
      'Give a reason between 10 and 500 characters')
    .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value),
      'Reason contains unsupported control characters'),
}).strict();
const deleteDocumentSchema = z.object({
  reason: z.string().trim()
    .refine((value) => Array.from(value).length >= 10 && Array.from(value).length <= 500,
      'Give a deletion reason between 10 and 500 characters')
    .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value),
      'Reason contains unsupported control characters'),
}).strict();
const verifyStorageProviderSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

async function requireDocumentControlWebSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authSession.clientKind !== 'WEB') {
    return reply.status(403).send({
      error: 'Review document controls in the dashboard.',
      code: 'WEB_SESSION_REQUIRED',
    });
  }
}

function safeDownloadFilename(name: string, storagePath: string): string {
  const storedFilename = storagePath.split('/').pop() ?? '';
  const storedExtension = storedFilename.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
  const candidate = name || storedFilename || 'document';
  const safeBase = candidate
    .replace(/[\u0000-\u001f\u007f<>:"\\/|?*]/g, '-')
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/g, '');
  const safe = safeBase || 'document';
  return storedExtension && !safe.toLowerCase().endsWith(storedExtension.toLowerCase())
    ? `${safe.slice(0, 180 - storedExtension.length).replace(/[. ]+$/g, '') || 'document'}${storedExtension}`
    : safe;
}

export async function documentRoutes(app: FastifyInstance) {
  const service = new DocumentService(app.prisma);
  const storageService = new StorageService(createPrismaOrganisationStorageResolver(app.prisma));
  const recovery = new DocumentRecoveryService(app.prisma,
    (organisationId, path, provider) => storageService.downloadFile(organisationId, path, provider));
  const policies = new RetentionPolicyService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  registerDocumentPurgeRoutes(app, new DocumentPurgeService(app.prisma,
    (organisationId, path, provider) => storageService.downloadFile(organisationId, path, provider)));

  app.get('/policy-revisions', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).strict().parse(request.query);
      return sendSuccess(reply, await policies.list(request.user.organisationId, before));
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
      return handleError(reply, error);
    }
  });
  app.post('/policy-revisions', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      return sendCreated(reply, await policies.create(request.user.organisationId, request.user.userId, request.body));
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
      return handleError(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/policy-revisions/:id/withdraw', {
    preHandler: [requireOwner, requireWebSession],
  }, async (request, reply) => {
    try {
      return sendCreated(reply, await policies.withdraw(request.user.organisationId, request.user.userId,
        storageDeletionIdSchema.parse(request.params.id), request.body));
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
      return handleError(reply, error);
    }
  });

  app.get('/recovery-policies', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    const policies = await app.prisma.dataRetentionPolicyRevision.findMany({ where: {
      organisationId: request.user.organisationId, recordClass: 'VAULT_DRAFT', state: 'APPROVED',
      retentionMode: { in: ['REVIEW_REQUIRED', 'AFTER_ANCHOR', 'AFTER_CALENDAR_YEARS'] }, withdrawal: { is: null },
    }, select: { id: true, revision: true, recoveryDays: true, retentionMode: true,
      retentionAnchor: true, retentionDays: true, retentionYears: true, approvalEvidenceRef: true },
    orderBy: { revision: 'desc' }, take: 100 });
    return sendSuccess(reply, policies);
  });

  app.get('/deleted', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: storageDeletionIdSchema.optional() }).strict().parse(request.query);
      return sendSuccess(reply, await recovery.list(request.user.organisationId, before));
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/restore', {
    preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireWebSession],
  }, async (request, reply) => {
    try {
      const body = deleteDocumentSchema.extend({ expectedUpdatedAt: z.string().datetime({ offset: true }) }).parse(request.body);
      return sendSuccess(reply, await recovery.restore({ organisationId: request.user.organisationId,
        documentId: request.params.id, actorUserId: request.user.userId,
        reason: body.reason, expectedUpdatedAt: new Date(body.expectedUpdatedAt) }));
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Validation failed', details: error.errors });
      return handleError(reply, error);
    }
  });

  app.get('/', async (request, reply) => {
    try {
      const { page, pageSize, before } = request.query as { page?: string; pageSize?: string; before?: string };
      if (before && !storageDeletionIdSchema.safeParse(before).success) {
        throw new AppError(400, 'DOCUMENT_CURSOR_INVALID', 'Invalid document cursor');
      }
      const cursor = before || undefined;
      return await service.list(
        request.user.organisationId,
        Math.max(1, parseInt(page ?? '1', 10) || 1),
        Math.min(100, Math.max(1, parseInt(pageSize ?? '50', 10) || 50)),
        request.user.role,
        cursor,
      );
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/replacement-candidates/:id', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const query = z.object({
        page: z.coerce.number().int().min(1).max(1000).default(1),
        q: z.string().trim().max(100).optional(),
      }).parse(request.query);
      const source = await app.prisma.document.findFirst({
        where: { deletedAt: null, id: request.params.id, organisationId: request.user.organisationId },
        select: { category: true },
      });
      if (!source) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const rows = await app.prisma.document.findMany({
        where: {
          organisationId: request.user.organisationId,
          id: { not: request.params.id },
          deletedAt: null,
          category: source.category,
          lifecycleStatus: 'CURRENT',
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        select: { id: true, name: true, updatedAt: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * 50,
        take: 51,
      });
      return sendSuccess(reply, { data: rows.slice(0, 50), page: query.page, hasMore: rows.length > 50 });
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      return handleError(reply, error);
    }
  });

  /**
   * What the Confluence copy of these documents looks like.
   *
   * A SEPARATE ENDPOINT RATHER THAN A FIELD ON EVERY DOCUMENT, and the reason
   * is the DPO-agreed architecture rather than convenience. A document's
   * response is CharityPilot's own authoritative record; the mirror is an
   * observation of somebody else's system that may be up to a reconcile
   * interval out of date. Folding one into the other would present them as
   * equally current, and would also make a documents list fail whenever the
   * mirror could not be read.
   *
   * Ids come in on the query string, so the common case — a documents page that
   * has just listed twenty documents — is one query rather than twenty.
   * Ungated by subscription for the same reason `GET /confluence/publications`
   * is: it reports where a charity's own documents have been sent.
   */
  app.get('/confluence-mirrors', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { ids } = request.query as { ids?: string };
      const documentIds = (ids ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        // Bounded: this is one IN clause, and an unbounded list from a query
        // string is a way to ask the database for the whole table.
        .slice(0, 100);

      const integration = await app.prisma.organisationIntegration.findUnique({
        where: {
          organisationId_provider: { organisationId: request.user.organisationId, provider: 'CONFLUENCE' },
        },
        select: { config: true, status: true, publishSpaceId: true, publishSpaceKey: true,
          publishSpaceName: true, publishSpaceSiteId: true, publishingModel: true },
      });
      const connected = integration?.status === 'CONNECTED';
      const config = connected ? integration.config as { siteUrl?: unknown } | null : null;
      const siteUrl = typeof config?.siteUrl === 'string' ? config.siteUrl : null;
      const target = connected ? readConfluencePublishTarget(integration) : null;

      const documents = documentIds.length ? await app.prisma.document.findMany({
        where: { organisationId: request.user.organisationId, deletedAt: null, id: { in: documentIds } },
        select: { id: true, externalPublicationApproved: true,
          externalPublicationSiteId: true, externalPublicationSpaceId: true },
      }) : [];
      const mirrors = await mirrorsForDocuments(app.prisma, {
        organisationId: request.user.organisationId,
        documentIds: documents.map((doc) => doc.id),
        siteUrl,
        siteId: connected ? confluenceSiteIdFromConfig(integration.config) : null,
        connectionAvailable: connected,
        publishSiteId: target?.cloudId ?? null,
        publishSpaceId: target?.spaceId ?? null,
      });

      const approvalCurrent = new Map(documents.map((doc) => [doc.id,
        Boolean(doc.externalPublicationApproved && target &&
          doc.externalPublicationSiteId === target.cloudId &&
          doc.externalPublicationSpaceId === target.spaceId)]));
      return reply.send({ mirrors: Object.fromEntries(Array.from(mirrors, ([id, mirror]) =>
        [id, { ...mirror, approvalDestinationCurrent: approvalCurrent.get(id) ?? false,
          publishDestination: target ? { siteId: target.cloudId, siteUrl,
            spaceId: target.spaceId, spaceKey: target.spaceKey, spaceName: target.spaceName } : null }])) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/control-audit', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: documentControlCursorSchema.optional() }).strict().parse(request.query);
      const organisationId = request.user.organisationId;
      const [anchorSource, anchorId] = before ? before.split(':') as ['control' | 'visibility', string] : [null, null];
      const anchor = anchorId ? (anchorSource === 'control'
        ? await app.prisma.documentControlAudit.findFirst({
          where: { id: anchorId, organisationId }, select: { id: true, occurredAt: true },
        })
        : await app.prisma.documentVisibilityAudit.findFirst({
          where: { id: anchorId, organisationId }, select: { id: true, occurredAt: true },
        })) : null;
      if (before && !anchor) {
        throw new AppError(404, 'DOCUMENT_CONTROL_CURSOR_NOT_FOUND', 'Document control cursor not found');
      }
      const olderWhere = (source: 'control' | 'visibility') => ({ organisationId,
        ...(anchor ? { OR: [
          { occurredAt: { lt: anchor.occurredAt } },
          ...(source === anchorSource
            ? [{ occurredAt: anchor.occurredAt, id: { lt: anchor.id } }]
            : source === 'visibility' ? [{ occurredAt: anchor.occurredAt }] : []),
        ] } : {}),
      });
      const [visibility, controls] = await Promise.all([
        app.prisma.documentVisibilityAudit.findMany({
          where: olderWhere('visibility'), orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51,
          select: { id: true, documentId: true, actorUserId: true, previous: true, next: true, reason: true, occurredAt: true },
        }),
        app.prisma.documentControlAudit.findMany({
          where: olderWhere('control'), orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51,
          select: { id: true, documentId: true, actorUserId: true, kind: true, previous: true, next: true, reason: true, occurredAt: true },
        }),
      ]);
      const events = [
        ...visibility.map((row) => ({ ...row, source: 'visibility' as const, kind: 'VISIBILITY' })),
        ...controls.map((row) => ({ ...row, source: 'control' as const })),
      ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
        || (a.source === b.source ? 0 : a.source === 'control' ? -1 : 1)
        || b.id.localeCompare(a.id));
      const page = events.slice(0, 50);
      return reply.send({ data: page, nextCursor: events.length > 50
        ? `${page[page.length - 1]!.source}:${page[page.length - 1]!.id}` : null });
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      return handleError(reply, error);
    }
  });

  app.get('/storage-deletions/history', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { before } = z.object({ before: storageDeletionIdSchema.optional() }).strict().parse(request.query);
      const organisationId = request.user.organisationId;
      const anchor = before ? await app.prisma.documentStorageDeletion.findFirst({
        where: { id: before, organisationId }, select: { id: true, createdAt: true },
      }) : null;
      if (before && !anchor) {
        throw new AppError(404, 'DOCUMENT_STORAGE_DELETION_CURSOR_NOT_FOUND', 'Deletion cursor not found');
      }
      const rows = await app.prisma.documentStorageDeletion.findMany({
        where: { organisationId, ...(anchor ? { OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
        select: {
          id: true, provider: true, state: true, reason: true, requestedById: true,
          terminalReason: true, attempts: true, createdAt: true, processedAt: true,
          activeObjectAbsentAt: true,
        },
      });
      const items = rows.slice(0, 50);
      return reply.send({ data: items, nextCursor: rows.length > 50 ? items[items.length - 1]!.id : null });
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      return handleError(reply, error);
    }
  });

  /**
   * Puts a failed publication back in the queue.
   *
   * ADMIN, because it sends a charity's governance document to a third-party
   * site, and only a `DEAD_LETTER` row is eligible — see
   * `retryFailedPublication` for why each of the other states is excluded, and
   * in particular why a RETIRED row must never be revived.
   *
   * A 409 when nothing matched, not a cheerful 200: an administrator who
   * pressed "try again" is entitled to know that nothing was tried.
   */
  app.post<{ Params: { id: string } }>(
    '/:id/publication/retry',
    { preHandler: [requireAdmin, requireWebSession] },
    async (request, reply) => {
      try {
        const target = await confluencePublishTargetForOrganisation(app.prisma, request.user.organisationId);
        if (!target) {
          throw new AppError(409, 'CONFLUENCE_PUBLISH_TARGET_UNAVAILABLE',
            'Reconnect Confluence and choose a publication space before retrying.');
        }
        const approved = await app.prisma.document.findFirst({
          where: {
            deletedAt: null, id: request.params.id,
            organisationId: request.user.organisationId,
            lifecycleStatus: 'CURRENT',
            externalPublicationApproved: true,
            externalPublicationSiteId: target.cloudId,
            externalPublicationSpaceId: target.spaceId,
          },
          select: { id: true },
        });
        if (!approved) {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_NOT_APPROVED', 'Only a current document with a separate publication approval may be retried.');
        }
        const recorded = await app.prisma.documentPublication.findFirst({
          where: { organisationId: request.user.organisationId,
            documentId: request.params.id, provider: 'confluence', state: 'DEAD_LETTER' },
          select: { cloudId: true, spaceId: true, pageId: true, terminalReason: true },
        });
        if (recorded?.terminalReason === 'REMOTE_WRITE_OUTCOME_UNKNOWN') {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_REMOTE_OUTCOME_UNKNOWN',
            'A Confluence write may have completed. Verify the original page and attachment versions before any new publication attempt.');
        }
        if (recorded?.cloudId && recorded.cloudId !== target.cloudId) {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_SITE_CHANGED',
            'The recorded Confluence page belongs to another site. Review that copy before retrying publication.');
        }
        if (recorded?.pageId && recorded.spaceId !== target.spaceId) {
          throw new AppError(409, 'DOCUMENT_PUBLICATION_SPACE_CHANGED',
            'The recorded Confluence page belongs to another space. Review that copy before retrying publication.');
        }
        const retried = await retryFailedPublication(app.prisma, {
          organisationId: request.user.organisationId,
          documentId: request.params.id,
        });

        if (!retried) {
          throw new AppError(
            409,
            'DOCUMENT_PUBLICATION_NOT_RETRYABLE',
            'This document has no failed Confluence publication to retry. It may already be ' +
              'queued, already published, or belong to a document that has been removed.',
          );
        }

        return reply.send({ retried: true });
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.get('/storage-deletions/dead-letter', { preHandler: [requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const { limit, after } = z.object({
        limit: z.string().optional(), after: storageDeletionIdSchema.optional(),
      }).strict().parse(request.query);
      return await service.listDeadLetterStorageDeletions(
        request.user.organisationId,
        Math.min(100, Math.max(1, Number.parseInt(limit ?? '50', 10) || 50)),
        after,
      );
    } catch (error) {
      if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/storage-deletions/:id/requeue',
    { preHandler: [requireAdmin, requireWebSession] },
    async (request, reply) => {
      try {
        const body = requeueStorageDeletionSchema.parse(request.body);
        const deletionId = storageDeletionIdSchema.parse(request.params.id);
        const result = await service.recoverDeadLetterStorageDeletion({
          organisationId: request.user.organisationId,
          deletionId,
          actor: { actorType: 'TENANT_USER', actorUserId: request.user.userId },
          reason: body.reason,
          disposition: body.disposition,
        });
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: error.errors,
          });
        }
        return handleError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      return await service.getById(request.user.organisationId, request.params.id, request.user.role);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Changes the card, never the file. Replacing a file is a new upload, so
  // this route has no multipart branch and cannot move a document's storage
  // path out from under a download already in flight.
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { expectedUpdatedAt, visibilityReason, contentAccessReason, lifecycleReason, publicationApprovalReason, ...data } = updateDocumentSchema.parse(request.body);
      // The connector advertises metadata edits only. Enforce the same
      // boundary for direct API calls before reading file bytes or changing a
      // governance decision on the connector user's behalf.
      if (request.authSession.clientKind !== 'WEB' &&
          (data.visibility !== undefined || data.contentAccessClass !== undefined ||
            data.lifecycleStatus !== undefined || data.externalPublicationApproved !== undefined)) {
        throw new AppError(403, 'WEB_SESSION_REQUIRED',
          'Review document access, lifecycle and publication in the dashboard.');
      }
      let verifiedSha256: string | undefined;
      if (data.contentAccessClass === 'MEMBER_SUITABLE' || data.visibility === 'MEMBER_VISIBLE') {
        const descriptor = await service.getDownloadDescriptor(request.user.organisationId, request.params.id, request.user.role);
        const needsByteRead = data.contentAccessClass === 'MEMBER_SUITABLE' ||
          (data.visibility === 'MEMBER_VISIBLE' && descriptor.contentAccessClass === 'MEMBER_SUITABLE'
            && descriptor.lifecycleStatus !== 'UNREVIEWED' && descriptor.lifecycleStatus !== 'DRAFT');
        if (needsByteRead) {
          if (descriptor.storageProvider !== 'local' && descriptor.storageProvider !== 'supabase') {
            throw new AppError(409, 'DOCUMENT_STORAGE_PROVIDER_UNVERIFIED', 'Verify which provider holds this file before allowing Member access.');
          }
          const file = await storageService.downloadFile(request.user.organisationId, descriptor.storagePath, descriptor.storageProvider);
          if (file.length !== descriptor.fileSize) {
            throw new AppError(409, 'DOCUMENT_REVIEWED_BYTES_CHANGED', 'The stored file size differs from the Vault record. Review its custody before allowing Member access.');
          }
          verifiedSha256 = createHash('sha256').update(file).digest('hex');
        }
      }
      return sendSuccess(
        reply,
        await service.update(request.user.organisationId, request.params.id, data, expectedUpdatedAt, request.user.userId, visibilityReason, lifecycleReason, publicationApprovalReason, contentAccessReason, verifiedSha256),
      );
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/deletion-hold', {
    preHandler: [requireAdmin, requireDocumentControlWebSession],
  }, async (request, reply) => {
    try {
      const input = deletionHoldSchema.parse(request.body);
      return sendSuccess(reply, await service.setDeletionHold({
        organisationId: request.user.organisationId,
        documentId: request.params.id,
        actorUserId: request.user.userId,
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        held: input.held,
        reason: input.reason,
      }));
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      }
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/verify-storage-provider', {
    preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireDocumentControlWebSession, requireActionApproval()],
  }, async (request, reply) => {
    try {
      const input = verifyStorageProviderSchema.parse(request.body);
      return sendSuccess(reply, await service.verifyWrittenStorageProvider({
        organisationId: request.user.organisationId,
        documentId: request.params.id,
        actorUserId: request.user.userId,
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
      }, (path, provider) => storageService.inspectActiveObject(request.user.organisationId, path, provider)));
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors });
      }
      return handleError(reply, error);
    }
  });

  // Authenticated proxy download: storage capabilities never leave the API.
  app.get<{ Params: { id: string } }>('/:id/download', async (request, reply) => {
    try {
      if (request.authSession.clientKind === 'MCP_CONNECTOR' && request.authSession.accessLevel === 'READ') {
        throw new AppError(403, 'SESSION_LEVEL_TOO_LOW', 'A read-only connector session cannot download document files');
      }
      // Raw document bytes cannot be filtered by the connector field policy.
      if (request.authSession.clientKind === 'MCP_CONNECTOR' && request.authSession.dataScope !== 'FULL') {
        throw new AppError(403, 'PERSONAL_DATA_SCOPE_REQUIRED', 'Document downloads require a full personal-data connector session');
      }
      const descriptor = await service.getDownloadDescriptor(
        request.user.organisationId,
        request.params.id,
        request.user.role,
      );
      const file = await storageService.downloadFile(
        request.user.organisationId,
        descriptor.storagePath,
        descriptor.storageProvider ?? undefined,
      );

      // A draft can be removed or visibility tightened while provider I/O runs.
      // Re-read the live tenant record before deciding which current role is
      // required; the descriptor's earlier visibility is no longer authority.
      const currentDocument = await app.prisma.document.findFirst({
        where: { deletedAt: null, id: request.params.id, organisationId: request.user.organisationId },
        select: { id: true, visibility: true, contentAccessClass: true, memberReviewedSha256: true,
          lifecycleStatus: true, fileUrl: true, storageProvider: true, fileSize: true, updatedAt: true },
      });
      const memberAccessible = currentDocument?.visibility === 'MEMBER_VISIBLE'
        && currentDocument.contentAccessClass === 'MEMBER_SUITABLE'
        && typeof currentDocument.memberReviewedSha256 === 'string'
        && (currentDocument.storageProvider === 'local' || currentDocument.storageProvider === 'supabase')
        && currentDocument.lifecycleStatus !== 'UNREVIEWED'
        && currentDocument.lifecycleStatus !== 'DRAFT';
      if (!currentDocument || (request.user.role === 'MEMBER' && !memberAccessible)) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      if (request.user.role === 'MEMBER' && (file.length !== currentDocument.fileSize ||
          createHash('sha256').update(file).digest('hex') !== currentDocument.memberReviewedSha256)) {
        request.log.error({ documentId: request.params.id }, 'Member document byte integrity mismatch');
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      // A legacy file can acquire a verified written provider while storage
      // I/O is in flight. Never return bytes fetched from the old provider (or
      // a changed path) under the current Vault record and its access audit.
      if (currentDocument.fileUrl !== descriptor.storagePath ||
          currentDocument.storageProvider !== descriptor.storageProvider) {
        throw new AppError(409, 'DOCUMENT_DOWNLOAD_SOURCE_CHANGED',
          'The document storage source changed. Refresh and download it again.');
      }
      if (currentDocument.updatedAt.getTime() !== descriptor.updatedAt.getTime()) {
        throw new AppError(409, 'DOCUMENT_DOWNLOAD_RECORD_CHANGED',
          'The document record changed. Refresh and download it again.');
      }

      // Storage reads can also outlast a role change or session revocation.
      // A currently restricted file requires a current Owner/Admin account.
      const activeSession = await app.prisma.authSession.findFirst({
        where: {
          id: request.user.sessionId,
          userId: request.user.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          ...(request.authSession.clientKind === 'MCP_CONNECTOR' ? { accessLevel: { in: ['WRITE', 'ADMIN'] as const } } : {}),
          ...(request.authSession.clientKind === 'MCP_CONNECTOR' ? { dataScope: 'FULL' as const } : {}),
          user: {
            is: {
              organisationId: request.user.organisationId,
              lifecycleStatus: 'ACTIVE',
              ...(!memberAccessible ? { role: { in: ['OWNER', 'ADMIN'] as const } } : {}),
              organisation: { is: { lifecycleStatus: 'ACTIVE' } },
            },
          },
        },
        select: { id: true },
      });
      if (!activeSession) {
        throw new AppError(401, 'UNAUTHORIZED', 'Your authenticated session is no longer active');
      }

      // An audit-write failure withholds the bytes. This records that the
      // server prepared a response after access checks, not client receipt.
      await app.prisma.documentDownloadPreparationAudit.create({ data: {
        organisationId: request.user.organisationId,
        documentId: request.params.id,
        actorUserId: request.user.userId,
        visibility: currentDocument.visibility,
        ...(request.user.role !== 'MEMBER' &&
          (currentDocument.storageProvider === 'local' || currentDocument.storageProvider === 'supabase') &&
          file.length === currentDocument.fileSize
          ? { reviewSha256: createHash('sha256').update(file).digest('hex'), documentUpdatedAt: currentDocument.updatedAt }
          : {}),
      } });

      const filename = safeDownloadFilename(descriptor.name, descriptor.storagePath);
      return reply
        .type(hasAllowedMimeType(descriptor.mimeType) ? descriptor.mimeType : 'application/octet-stream')
        .header('Cache-Control', 'private, no-store, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(file);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Upload document (multipart/form-data)
  app.post('/', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const fields: Record<string, { value?: string }> = {};
      let uploadedFile: { filename: string; mimetype: string; buffer: Buffer } | null = null;
      let partCount = 0;
      let fieldCount = 0;
      let fileCount = 0;

      try {
        for await (const part of request.parts()) {
          partCount += 1;
          if (partCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.parts) {
            return reply.status(413).send({
              error: 'Multipart upload exceeds the document request limits.',
              code: 'MULTIPART_LIMIT_EXCEEDED',
            });
          }

          if (part.type === 'field') {
            fieldCount += 1;
            const fieldValue = typeof part.value === 'string' ? part.value : String(part.value ?? '');

            if (
              fieldCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fields ||
              part.fieldnameTruncated ||
              part.valueTruncated ||
              Buffer.byteLength(part.fieldname) > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldNameSize ||
              Buffer.byteLength(fieldValue) > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldSize
            ) {
              return reply.status(413).send({
                error: 'Multipart upload exceeds the document request limits.',
                code: 'MULTIPART_LIMIT_EXCEEDED',
              });
            }

            fields[part.fieldname] = {
              value: fieldValue,
            };
            continue;
          }

          fileCount += 1;
          if (fileCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.files || uploadedFile) {
            return reply.status(413).send({
              error: 'Multipart upload exceeds the document request limits.',
              code: 'MULTIPART_LIMIT_EXCEEDED',
            });
          }

          if (!hasAllowedMimeType(part.mimetype)) {
            return reply.status(400).send({
              error: `File type '${part.mimetype}' is not allowed. Accepted types: PDF, modern Office documents, text, CSV, JPEG, PNG.`,
              code: 'INVALID_MIME_TYPE',
            });
          }

          const buffer = await part.toBuffer();
          if (buffer.length > DOCUMENT_UPLOAD_MAX_FILE_SIZE) {
            return reply.status(413).send({
              error: 'File size exceeds the 10 MB limit.',
              code: 'FILE_TOO_LARGE',
            });
          }

          uploadedFile = {
            filename: part.filename,
            mimetype: part.mimetype,
            buffer,
          };
        }
      } catch (error) {
        if (isFileTooLargeError(error)) {
          return reply.status(413).send({
            error: 'File size exceeds the 10 MB limit.',
            code: 'FILE_TOO_LARGE',
          });
        }
        if (isMultipartLimitError(error)) {
          return reply.status(413).send({
            error: 'Multipart upload exceeds the document request limits.',
            code: 'MULTIPART_LIMIT_EXCEEDED',
          });
        }
        throw error;
      }

      if (!uploadedFile) {
        return reply.status(400).send({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const meta = uploadDocumentSchema.parse({
        name: fields.name?.value,
        description: fields.description?.value,
        category: fields.category?.value,
        owner: fields.owner?.value,
        approvedDate: fields.approvedDate?.value,
        nextReviewDate: fields.nextReviewDate?.value,
        boardMinuteReference: fields.boardMinuteReference?.value,
      });

      if (!hasAllowedExtension(uploadedFile.filename, uploadedFile.mimetype) || !hasValidSignature(uploadedFile.mimetype, uploadedFile.buffer)) {
        return reply.status(400).send({
          error: 'File content does not match the declared document type.',
          code: 'INVALID_FILE_SIGNATURE',
        });
      }

      // This check gives the normal API a stable 409 before provider I/O.
      // The upload-intent SQL trigger serialises a concurrent recovery bind.
      if (await app.prisma.documentRecoveryEnforcement.findUnique({
        where: { organisationId: request.user.organisationId }, select: { id: true },
      })) {
        throw new AppError(409, 'DOCUMENT_SOURCE_RECOVERY_REQUIRED',
          'Document uploads require independent recovery authority for this charity.');
      }

      let uploadIntentId: string | null = null;
      const uploaded = await storageService.uploadFile(
        request.user.organisationId,
        uploadedFile.filename,
        uploadedFile.buffer,
        uploadedFile.mimetype,
        async (prepared) => {
          const intent = await app.prisma.documentUploadIntent.create({
            data: { organisationId: request.user.organisationId, ...prepared, state: 'RESERVED' },
            select: { id: true },
          });
          uploadIntentId = intent.id;
        },
      );
      if (!uploadIntentId) {
        throw new AppError(503, 'DOCUMENT_UPLOAD_RESERVATION_FAILED', 'Document upload could not be reserved. Try again later.');
      }
      const { storagePath, provider: uploadedProvider } = uploaded;
      if (!uploadedProvider) {
        throw new AppError(503, 'DOCUMENT_UPLOAD_PROVIDER_UNVERIFIED', 'Document upload provider could not be verified. Try again later.');
      }

      const doc = await service.create(request.user.organisationId, request.user.userId, {
          name: meta.name,
          description: meta.description,
          category: meta.category,
          fileUrl: storagePath,
          fileSize: uploadedFile.buffer.length,
          mimeType: uploadedFile.mimetype,
          owner: meta.owner || null,
          approvedDate: meta.approvedDate || null,
          nextReviewDate: meta.nextReviewDate || null,
          boardMinuteReference: meta.boardMinuteReference || null,
      }, uploadIntentId, uploadedProvider);

      return sendCreated(reply, doc);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireWebSession] }, async (request, reply) => {
    try {
      const body = deleteDocumentSchema.extend({
        expectedUpdatedAt: z.string().datetime({ offset: true }),
        policyId: storageDeletionIdSchema,
        evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
      }).parse(request.body);
      const removed = await recovery.remove({ organisationId: request.user.organisationId,
        documentId: request.params.id, actorUserId: request.user.userId,
        reason: body.reason, policyId: body.policyId, evidenceRef: body.evidenceRef,
        expectedUpdatedAt: new Date(body.expectedUpdatedAt) });
      return sendSuccess(reply, removed);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // Link document to governance standard
  app.post<{ Params: { id: string } }>('/:id/link-standard', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.linkStandard(request.user.organisationId, request.params.id, standardId, request.user.userId);
      return sendCreated(reply, { success: true });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // Alias used by the web app: POST /documents/:id/standards
  app.post<{ Params: { id: string } }>('/:id/standards', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.linkStandard(request.user.organisationId, request.params.id, standardId, request.user.userId);
      return sendCreated(reply, { success: true });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // Unlink document from governance standard
  app.delete<{ Params: { id: string } }>('/:id/unlink-standard', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.unlinkStandard(request.user.organisationId, request.params.id, standardId, request.user.userId);
      return sendNoContent(reply);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      return handleError(reply, err);
    }
  });

  // Alias used by the web app: DELETE /documents/:id/standards/:standardId
  app.delete<{ Params: { id: string; standardId: string } }>('/:id/standards/:standardId', { preHandler: [requireSessionLevel('ADMIN'), requireAdmin, requireActionApproval()] }, async (request, reply) => {
    try {
      await service.unlinkStandard(
        request.user.organisationId,
        request.params.id,
        request.params.standardId,
        request.user.userId,
      );
      return sendNoContent(reply);
    } catch (err) {
      return handleError(reply, err);
    }
  });
}
