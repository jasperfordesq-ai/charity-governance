import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { authGuard } from '../../middleware/auth.js';
import { requireOwner } from '../../middleware/roles.js';
import { requireWebSession } from '../../middleware/session-level.js';
import { ConfluenceRetainedCopyReviewService } from '../../services/confluence-retained-copy-review.service.js';
import { observeRetainedConfluenceCopySource } from '../../services/confluence-retained-copy-source.js';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const empty = z.object({}).strict();
export const RETAINED_COPY_REVIEW_ROUTES_PREFIX = '/api/v1/integrations/confluence/retained-copy-reviews';
export type RetainedCopyReviewRoutesOptions = {
  /** Test dependencies; production uses guarded services and the live observer. */
  deps?: {
    observe?: typeof observeRetainedConfluenceCopySource;
    reviews?: Pick<ConfluenceRetainedCopyReviewService, 'record' | 'withdraw'>;
  };
};

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_ERROR', error: 'Invalid review request.' });
  return handleError(reply, error);
}

/** Review evidence only. Does not register maintenance scopes, issue a
 * permission, enqueue erasure or consume one-use authority. The authenticated
 * tenant/actor is never accepted from query parameters or the observation body.
 */
export async function retainedCopyReviewRoutes(app: FastifyInstance, options: RetainedCopyReviewRoutesOptions = {}) {
  const reviews = options.deps?.reviews ?? new ConfluenceRetainedCopyReviewService(app.prisma);
  const observe = options.deps?.observe ?? observeRetainedConfluenceCopySource;
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
}
