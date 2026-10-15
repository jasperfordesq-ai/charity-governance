import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';
import { prepareRetainedConfluenceCopyReview, assertRetainedConfluenceCopyReviewCurrent } from './confluence-retained-copy-review.js';
import { observeRetainedConfluenceCopySource } from './confluence-retained-copy-source.js';

export const SYNTHETIC_COPY_PERMISSION_ATTESTATION =
  'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY';
const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const connectionIdentity = z.object({ integrationId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  connectedAt: z.string().datetime({ precision: 3 }), cloudId: z.string().uuid(), siteOrigin: z.string().url() }).strict();
const permissionInput = retentionWithdrawalInput.extend({
  scopeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/),
  expectedSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scopeEvidenceRef: evidence, disposalPolicyEvidenceRef: evidence,
  expiresAt: z.string().datetime({ precision: 3 }),
  attestation: z.literal(SYNTHETIC_COPY_PERMISSION_ATTESTATION),
}).strict();
function refuse(): never {
  throw new AppError(409, 'CONFLUENCE_COPY_PERMISSION_REVIEW_REQUIRED',
    'A current exact review, registered synthetic scope and confirmed disposal decision are required.');
}

/** Records a controller decision only. No erasure request/worker consumes it
 * until independent history and one-use execution are implemented. Maintenance
 * registration is deliberately not exposed to the application role or this API.
 */
export class ConfluenceRetainedCopyPermissionService {
  constructor(private readonly prisma: PrismaClient,
    private readonly deps: { observeSource?: typeof observeRetainedConfluenceCopySource } = {}) {}

  async issue(organisationId: string, actorUserId: string, reviewId: string, raw: unknown) {
    const input = permissionInput.parse(raw);
    const readDecision = async (tx: Prisma.TransactionClient) => {
      await this.ownerAndRecoveryFence(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "ConfluenceRetainedCopyReview"
        WHERE id=${reviewId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const row = await tx.confluenceRetainedCopyReview.findFirst({
        where: { id: reviewId, organisationId }, include: { withdrawal: true },
      });
      if (!row || row.withdrawal) refuse();
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (!clock || !Number.isFinite(clock.now.getTime())) refuse();
      const candidate = prepareRetainedConfluenceCopyReview(row.review, clock.now);
      if (candidate.snapshotSha256 !== row.snapshotSha256 || row.snapshotSha256 !== input.expectedSnapshotSha256
        || candidate.review.reviewerId !== row.reviewerId || candidate.review.snapshot.organisationId !== organisationId
        || candidate.review.snapshot.documentId !== row.documentId || candidate.review.snapshot.publicationId !== row.publicationId) refuse();
      await tx.$queryRaw`SELECT id FROM "ConfluenceSyntheticCopyScope"
        WHERE id=${input.scopeId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const scope = await tx.confluenceSyntheticCopyScope.findFirst({ where: { id: input.scopeId, organisationId } });
      const expires = Date.parse(input.expiresAt);
      if (!scope || scope.id !== input.scopeId || scope.organisationId !== organisationId || scope.reviewId !== reviewId
        || scope.classification !== 'SYNTHETIC_ONLY' || scope.snapshotSha256 !== candidate.snapshotSha256
        || scope.evidenceRef !== input.scopeEvidenceRef || scope.disposalPolicyEvidenceRef !== input.disposalPolicyEvidenceRef
        || expires <= clock.now.getTime() || expires > scope.expiresAt.getTime()
        || expires > Date.parse(candidate.review.expiresAt)) refuse();
      const existing = await tx.confluenceRetainedCopyPermission.findFirst({ where: { organisationId, reviewId }, select: { id: true } });
      if (existing) throw new AppError(409, 'CONFLUENCE_COPY_PERMISSION_ALREADY_ISSUED', 'This review already has a permission. A withdrawal does not renew it.');
      // SQL locks the current local source/publication too. No network/storage
      // read occurs while this short preflight/final transaction is held.
      await tx.$queryRaw`SELECT public."ConfluenceCopyPermission_current_review"(${reviewId}, ${organisationId})`;
      return { candidate, now: clock.now };
    };
    const before = await this.prisma.$transaction(readDecision);
    const observation = await (this.deps.observeSource ?? observeRetainedConfluenceCopySource)(this.prisma, {
      organisationId, actorUserId, publicationId: before.candidate.review.snapshot.publicationId,
    });
    if (observation.actorUserId !== actorUserId || observation.sourceBytesObserved !== true
      || observation.actionAuthorized !== false || observation.syntheticVerified !== false
      || observation.allCopiesVerified !== false) refuse();
    const connection = connectionIdentity.safeParse(observation.connection);
    if (!connection.success || connection.data.cloudId !== observation.snapshot.cloudId
      || connection.data.siteOrigin !== observation.snapshot.siteOrigin) refuse();
    return this.prisma.$transaction(async tx => {
      const current = await readDecision(tx);
      if (current.candidate.snapshotSha256 !== before.candidate.snapshotSha256) refuse();
      assertRetainedConfluenceCopyReviewCurrent(current.candidate, observation.snapshot, current.now);
      const permission = await tx.confluenceRetainedCopyPermission.create({ data: {
        organisationId, reviewId, scopeId: input.scopeId, actorUserId,
        integrationId: connection.data.integrationId, connectionGeneration: new Date(connection.data.connectedAt),
        snapshotSha256: current.candidate.snapshotSha256, evidenceRef: input.evidenceRef,
        reason: input.reason, attestation: input.attestation, scopeEvidenceRef: input.scopeEvidenceRef,
        disposalPolicyEvidenceRef: input.disposalPolicyEvidenceRef,
        classification: 'OWNER_ATTESTED_SYNTHETIC', expiresAt: new Date(input.expiresAt),
      } });
      return { permission, providerIOAuthorised: false as const };
    });
  }

  async withdraw(organisationId: string, actorUserId: string, permissionId: string, raw: unknown) {
    const input = retentionWithdrawalInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      await this.ownerAndRecoveryFence(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "ConfluenceRetainedCopyPermission"
        WHERE id=${permissionId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const permission = await tx.confluenceRetainedCopyPermission.findFirst({
        where: { id: permissionId, organisationId }, include: { withdrawal: true },
      });
      if (!permission) throw new AppError(404, 'CONFLUENCE_COPY_PERMISSION_NOT_FOUND', 'Permission not found.');
      if (permission.withdrawal) throw new AppError(409, 'CONFLUENCE_COPY_PERMISSION_WITHDRAWN', 'Permission already withdrawn.');
      return tx.confluenceRetainedCopyPermissionWithdrawal.create({ data: { organisationId, permissionId, actorUserId, ...input } });
    });
  }

  private async ownerAndRecoveryFence(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR UPDATE`;
    const organisation = await tx.organisation.findFirst({ where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
    if (!organisation || !actor) throw new AppError(403, 'CONFLUENCE_COPY_PERMISSION_OWNER_REQUIRED', 'An active charity Owner is required.');
    if (await tx.documentRecoveryEnforcement.findUnique({ where: { organisationId }, select: { id: true } })) {
      throw new AppError(409, 'CONFLUENCE_COPY_PERMISSION_RECOVERY_REQUIRED', 'Permission decisions require independently recorded recovery evidence.');
    }
  }
}
