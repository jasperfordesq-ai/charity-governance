import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { requireOwner } from '../../middleware/roles.js';
import { requireWebSession } from '../../middleware/session-level.js';
import { ConfluenceRetainedCopyReviewService } from '../../services/confluence-retained-copy-review.service.js';
import { ConfluenceRetainedCopyPermissionService } from '../../services/confluence-retained-copy-permission.service.js';
import { observeRetainedConfluenceCopySource } from '../../services/confluence-retained-copy-source.js';
import { AppError, handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const empty = z.object({}).strict();
export const RETAINED_COPY_REVIEW_ROUTES_PREFIX = '/api/v1/integrations/confluence/retained-copy-reviews';
export type RetainedCopyReviewRoutesOptions = {
  /** Test dependencies; production uses guarded services and the live observer. */
  deps?: {
    observe?: typeof observeRetainedConfluenceCopySource;
    reviews?: Pick<ConfluenceRetainedCopyReviewService, 'record' | 'withdraw'>;
    permissions?: Pick<ConfluenceRetainedCopyPermissionService, 'issue' | 'withdraw'>;
  };
};

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Invalid review request.' });
  return handleError(reply, error);
}

/** Review and permission decisions only. Does not register maintenance scopes,
 * enqueue erasure or consume one-use authority. The authenticated
 * tenant/actor is never accepted from query parameters or the observation body.
 */
export async function retainedCopyReviewRoutes(app: FastifyInstance, options: RetainedCopyReviewRoutesOptions = {}) {
  const reviews = options.deps?.reviews ?? new ConfluenceRetainedCopyReviewService(app.prisma);
  const observe = options.deps?.observe ?? observeRetainedConfluenceCopySource;
  const permissions = options.deps?.permissions ?? new ConfluenceRetainedCopyPermissionService(app.prisma);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return authGuard(request, reply);
  });
  app.addHook('preHandler', requireOwner);
  app.addHook('preHandler', requireWebSession);
  app.addHook('preHandler', async (request, reply) => {
    if (request.authSession.dataScope !== 'FULL') return reply.status(403).send({ code: 'FULL_DATA_SCOPE_REQUIRED', error: 'Full dashboard access is required.' });
  });

  app.post('/observe/:publicationId', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      empty.parse(request.query); empty.parse(request.body ?? {});
      const { publicationId } = z.object({ publicationId: identifier }).strict().parse(request.params);
      const observation = await observe(app.prisma, { organisationId: request.user.organisationId,
        actorUserId: request.user.userId, publicationId }, { signal: AbortSignal.timeout(60_000) });
      return sendSuccess(reply, { snapshot: observation.snapshot, sourceBytesObserved: observation.sourceBytesObserved,
        syntheticVerified: false, allCopiesVerified: false, actionAuthorized: false });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    try {
      empty.parse(request.query);
      const review = await reviews.record(request.user.organisationId, request.user.userId, request.body);
      return sendSuccess(reply, { id: review.id, snapshotSha256: review.snapshotSha256,
        reviewedAt: review.reviewedAt, expiresAt: review.expiresAt, authorisesProviderIO: false }, 201);
    } catch (error) { return failure(reply, error); }
  });

  app.post('/:reviewId/withdraw', async (request, reply) => {
    try {
      empty.parse(request.query);
      const { reviewId } = z.object({ reviewId: identifier }).strict().parse(request.params);
      const withdrawal = await reviews.withdraw(request.user.organisationId, request.user.userId, reviewId, request.body);
      return sendSuccess(reply, { id: withdrawal.id, authorisesProviderIO: false }, 201);
    } catch (error) { return failure(reply, error); }
  });

  // Reconcile a lost recording response before making another review. IDs are
  // opaque cursors within this tenant/publication, never a provider target.
  app.get('/publications/:publicationId/reviews', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const { publicationId } = z.object({ publicationId: identifier }).strict().parse(request.params);
      const { before } = z.object({ before: identifier.optional() }).strict().parse(request.query);
      const scope = { organisationId: request.user.organisationId, publicationId };
      if (before && !await app.prisma.confluenceRetainedCopyReview.findFirst({ where: { ...scope, id: before }, select: { id: true } })) {
        throw new AppError(400, 'CONFLUENCE_COPY_REVIEW_CURSOR_INVALID', 'Refresh this publication’s review receipts.');
      }
      const rows = await app.prisma.confluenceRetainedCopyReview.findMany({
        where: { ...scope, ...(before ? { id: { lt: before } } : {}) },
        orderBy: { id: 'desc' }, take: 26,
        select: { id: true, reviewerId: true, snapshotSha256: true, reviewedAt: true, expiresAt: true, recordedAt: true,
          review: true, withdrawal: { select: { occurredAt: true } } },
      });
      const page = rows.slice(0, 25);
      return sendSuccess(reply, { reviews: page.map(row => {
        const evidenceRef = row.review !== null && typeof row.review === 'object' && !Array.isArray(row.review)
          && typeof row.review.evidenceRef === 'string' && /^[A-Z0-9][A-Z0-9-]{2,119}$/.test(row.review.evidenceRef)
          ? row.review.evidenceRef : null;
        return { id: row.id, reviewerId: row.reviewerId, snapshotSha256: row.snapshotSha256,
          reviewedAt: row.reviewedAt, expiresAt: row.expiresAt, recordedAt: row.recordedAt,
          evidenceRef, withdrawnAt: row.withdrawal?.occurredAt ?? null };
      }), nextCursor: rows.length > 25 ? page[page.length - 1]!.id : null,
      currentSourceChecked: false, providerIOAuthorised: false, absenceProvesFailure: false });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/:reviewId/permission', { bodyLimit: 8192, config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      empty.parse(request.query);
      const { reviewId } = z.object({ reviewId: identifier }).strict().parse(request.params);
      const { permission } = await permissions.issue(request.user.organisationId, request.user.userId, reviewId, request.body);
      return sendSuccess(reply, { permission: { id: permission.id, reviewId: permission.reviewId,
        scopeId: permission.scopeId, snapshotSha256: permission.snapshotSha256,
        issuedAt: permission.issuedAt, expiresAt: permission.expiresAt }, providerIOAuthorised: false }, 201);
    } catch (error) { return failure(reply, error); }
  });

  // Receipt lookup lets a caller reconcile a lost issuance response without
  // retrying the decision. It does not refresh inventory or certify current use.
  app.get('/:reviewId/permission', async (request, reply) => {
    try {
      empty.parse(request.query);
      const { reviewId } = z.object({ reviewId: identifier }).strict().parse(request.params);
      const permission = await app.prisma.confluenceRetainedCopyPermission.findFirst({
        where: { organisationId: request.user.organisationId, reviewId },
        select: { id: true, reviewId: true, scopeId: true, snapshotSha256: true, issuedAt: true, expiresAt: true,
          withdrawal: { select: { id: true, occurredAt: true, evidenceRef: true, reason: true } },
          review: { select: { withdrawal: { select: { id: true, occurredAt: true } } } } },
      });
      if (!permission) throw new AppError(404, 'CONFLUENCE_COPY_PERMISSION_NOT_FOUND', 'Recorded permission not found.');
      return sendSuccess(reply, { permission, currentSourceChecked: false, providerIOAuthorised: false });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/permissions/:permissionId/withdraw', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      empty.parse(request.query);
      const { permissionId } = z.object({ permissionId: identifier }).strict().parse(request.params);
      const result = await permissions.withdraw(request.user.organisationId, request.user.userId, permissionId, request.body);
      return sendSuccess(reply, { id: result.id, permissionId, providerIOAuthorised: false }, 201);
    } catch (error) { return failure(reply, error); }
  });
}
