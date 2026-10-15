import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../utils/app-error.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { prepareRetainedConfluenceCopyReview } from './confluence-retained-copy-review.js';

/** Internal review evidence storage. Not a provider authorisation endpoint.
 * Caller identity must come from the authenticated tenant context. Provider
 * inventory and byte claims remain reviewed assertions until independently
 * collected; no execution path consumes this table as permission.
 */
export class ConfluenceRetainedCopyReviewService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(organisationId: string, actorUserId: string, input: unknown) {
    return this.prisma.$transaction(async tx => {
      await this.ownerAndRecoveryFence(tx, organisationId, actorUserId);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (!clock) throw new AppError(503, 'CONFLUENCE_COPY_REVIEW_CLOCK_UNAVAILABLE', 'The review clock is unavailable.');
      const candidate = prepareRetainedConfluenceCopyReview(input, clock.now);
      if (candidate.review.reviewerId !== actorUserId
        || candidate.review.snapshot.organisationId !== organisationId) {
        throw new AppError(403, 'CONFLUENCE_COPY_REVIEW_SCOPE_REQUIRED', 'Review evidence must match the authenticated Owner and charity.');
      }
      // SQL locks and rechecks the current source/publication revisions too.
      // This insert does not stamp a publication or create a deletion job.
      return tx.confluenceRetainedCopyReview.create({ data: {
        organisationId, reviewerId: actorUserId,
        documentId: candidate.review.snapshot.documentId,
        publicationId: candidate.review.snapshot.publicationId,
        snapshotSha256: candidate.snapshotSha256, review: candidate.review,
        reviewedAt: new Date(candidate.review.reviewedAt),
        expiresAt: new Date(candidate.review.expiresAt), authorisesProviderIO: false,
      } });
    });
  }

  async withdraw(organisationId: string, actorUserId: string, reviewId: string, raw: unknown) {
    const input = retentionWithdrawalInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      await this.ownerAndRecoveryFence(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "ConfluenceRetainedCopyReview"
        WHERE id=${reviewId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const review = await tx.confluenceRetainedCopyReview.findFirst({
        where: { id: reviewId, organisationId }, include: { withdrawal: true },
      });
      if (!review) throw new AppError(404, 'CONFLUENCE_COPY_REVIEW_NOT_FOUND', 'Review not found.');
      if (review.withdrawal) throw new AppError(409, 'CONFLUENCE_COPY_REVIEW_WITHDRAWN', 'This review is already withdrawn.');
      return tx.confluenceRetainedCopyReviewWithdrawal.create({ data: {
        organisationId, reviewId, actorUserId, ...input,
      } });
    });
  }

  private async ownerAndRecoveryFence(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR UPDATE`;
    const actor = await tx.user.findFirst({ where: {
      id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE',
    }, select: { id: true } });
    if (!actor) throw new AppError(403, 'CONFLUENCE_COPY_REVIEW_OWNER_REQUIRED', 'An active charity Owner is required.');
    if (await tx.documentRecoveryEnforcement.findUnique({ where: { organisationId }, select: { id: true } })) {
      throw new AppError(409, 'CONFLUENCE_COPY_REVIEW_RECOVERY_REQUIRED', 'Review decisions require independently recorded recovery evidence.');
    }
  }
}
