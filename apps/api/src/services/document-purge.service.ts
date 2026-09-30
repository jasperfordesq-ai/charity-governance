import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { retentionWithdrawalInput } from './retention-policy.service.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const store = z.object({ disposition: z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']),
  evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/) }).strict();
export const purgeAuthorizationInput = retentionWithdrawalInput.extend({
  documentId: id, policyId: id, expectedUpdatedAt: z.string().datetime({ offset: true }),
  authorityConfirmed: z.literal(true),
  dispositionPlan: z.object({ PRIMARY: store.extend({ disposition: z.literal('DISPOSE') }),
    VERSIONS: store, CONFLUENCE: store, EXPORTS: store, AUDIT: store, BACKUPS: store }).strict(),
}).strict();
export const purgeClaimInput = z.object({ confirmPermanentPurge: z.literal(true) }).strict();
export const purgeHistoryInput = z.object({ documentId: id.optional(), before: id.optional() }).strict();
export const purgeId = id;
export const purgeDispositionInput = retentionWithdrawalInput.extend({
  area: z.enum(['VERSIONS', 'CONFLUENCE', 'EXPORTS', 'AUDIT', 'BACKUPS']),
  scopeRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  revision: z.number().int().min(1).max(2147483647),
  status: z.enum(['NEEDS_REVIEW', 'PENDING_DISPOSAL', 'FAILED', 'VERIFIED_ABSENT', 'RETAINED_APPROVED', 'NOT_APPLICABLE']),
  observedAt: z.string().datetime({ offset: true }),
  nextReviewAt: z.string().datetime({ offset: true }).nullable(),
  evidenceReviewed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (['NEEDS_REVIEW', 'PENDING_DISPOSAL', 'FAILED', 'RETAINED_APPROVED'].includes(value.status) && !value.nextReviewAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextReviewAt'], message: 'Record a follow-up review date for unresolved or retained copies.' });
  }
});
const dispositionHistoryInput = z.object({ before: id.optional() }).strict();
const dispositionReview = { id: true, authorizationId: true, area: true, scopeRef: true,
  revision: true, status: true, actorUserId: true, evidenceRef: true, reason: true,
  observedAt: true, nextReviewAt: true, occurredAt: true } as const;


// Never return provider paths, fingerprints or PostgreSQL transaction IDs.
const review = { id: true, documentId: true, documentRevision: true, policyId: true,
  actorUserId: true, evidenceRef: true, reason: true, recoveryUntil: true,
  dispositionPlan: true, authorizedAt: true, withdrawal: true,
  claim: { select: { id: true, deletionId: true, claimedAt: true,
    deletion: { select: { state: true, processedAt: true, activeObjectAbsentAt: true } } } } } as const;
type ReadFile = (organisationId: string, path: string, provider: string) => Promise<Buffer>;

export class DocumentPurgeService {
  constructor(private readonly prisma: PrismaClient, private readonly readFile: ReadFile) {}

  private async owner(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string) {
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR UPDATE`;
    const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!actor) throw new AppError(403, 'PURGE_OWNER_REQUIRED', 'The active charity Owner must review this disposal decision.');
  }

  private async transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(callback, { timeout: 90000 }); }
    catch (error) {
      // PostgreSQL RAISE EXCEPTION (P0001) arrives as an unknown-request error,
      // not P2004, with this Prisma engine. Translate only named purge guards.
      if (error instanceof Error && error.name === 'PrismaClientUnknownRequestError') {
        if (error.message.includes('Purge claim must wait for retention and recovery expiry')) {
          throw new AppError(409, 'PURGE_NOT_DUE', 'The approved retention and recovery periods must both expire before primary disposal.');
        }
        if (error.message.includes('Purge disposition observation must be between claim and recording')) {
          throw new AppError(409, 'PURGE_OBSERVATION_TIME_INVALID', 'The observation time must be after the primary disposal claim and no later than the server time. Check the date, local time and device clock.');
        }
        if (error.message.includes('Purge disposition')) {
          throw new AppError(409, 'PURGE_DISPOSITION_REVIEW_CHANGED', 'Refresh the scoped evidence history and review the approved plan, observation and follow-up dates.');
        }
        if (/Purge (?:authorization (?:requires|must bind|not found)|claim (?:requires|cannot reuse)|withdrawal requires|has been claimed)/.test(error.message)) {
          throw new AppError(409, 'PURGE_REVIEW_CHANGED', 'Disposal could not proceed. Refresh the record, policy, holds and authorization before reviewing again.');
        }
      }
      // Database guards remain authoritative when a concurrent change wins.
      if (error && typeof error === 'object' && 'code' in error
        && ['P2002', 'P2004', 'P2010', 'P2034'].includes(String(error.code))) {
        throw new AppError(409, 'PURGE_REVIEW_CHANGED', 'Disposal could not proceed. Refresh the record, policy, holds and authorization before reviewing again.');
      }
      throw error;
    }
  }

  private async verifyBytes(organisationId: string, doc: { fileUrl: string; storageProvider: string | null; fileSize: number; recoverySha256: string | null }) {
    if (!doc.recoverySha256 || !['local', 'supabase'].includes(doc.storageProvider ?? '')) {
      throw new AppError(409, 'PURGE_FILE_UNVERIFIED', 'The retained file has no verified storage identity.');
    }
    const bytes = await this.readFile(organisationId, doc.fileUrl, doc.storageProvider!);
    if (bytes.length !== doc.fileSize || createHash('sha256').update(bytes).digest('hex') !== doc.recoverySha256) {
      throw new AppError(409, 'PURGE_FILE_CHANGED', 'The stored bytes differ from the removed file. Investigate before disposal.');
    }
  }

  async list(organisationId: string, raw: unknown) {
    const { documentId, before } = purgeHistoryInput.parse(raw);
    const anchor = before ? await this.prisma.documentPurgeAuthorization.findFirst({ where: { id: before, organisationId, documentId }, select: { id: true, authorizedAt: true } }) : null;
    if (before && !anchor) throw new AppError(404, 'PURGE_AUTHORIZATION_NOT_FOUND', 'Authorization cursor not found');
    const rows = await this.prisma.documentPurgeAuthorization.findMany({ where: { organisationId, documentId,
      ...(anchor ? { OR: [{ authorizedAt: { lt: anchor.authorizedAt } }, { authorizedAt: anchor.authorizedAt, id: { lt: anchor.id } }] } : {}) },
      select: review, orderBy: [{ authorizedAt: 'desc' }, { id: 'desc' }], take: 51 });
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  }

  async listDispositions(organisationId: string, authorizationId: string, raw: unknown) {
    const { before } = dispositionHistoryInput.parse(raw);
    const auth = await this.prisma.documentPurgeAuthorization.findFirst({ where: { id: authorizationId, organisationId }, select: { id: true } });
    if (!auth) throw new AppError(404, 'PURGE_AUTHORIZATION_NOT_FOUND', 'Authorization not found');
    const anchor = before ? await this.prisma.documentPurgeDispositionEvent.findFirst({
      where: { id: before, organisationId, authorizationId }, select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) throw new AppError(404, 'PURGE_DISPOSITION_NOT_FOUND', 'Evidence cursor not found');
    const rows = await this.prisma.documentPurgeDispositionEvent.findMany({ where: { organisationId, authorizationId,
      ...(anchor ? { OR: [{ occurredAt: { lt: anchor.occurredAt } }, { occurredAt: anchor.occurredAt, id: { lt: anchor.id } }] } : {}) },
      select: dispositionReview, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51 });
    // This is scoped reviewer evidence; no aggregation can assert all copies erased.
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  }

  async recordDisposition(organisationId: string, actorUserId: string, authorizationId: string, raw: unknown) {
    const { evidenceReviewed: _confirmed, observedAt, nextReviewAt, ...input } = purgeDispositionInput.parse(raw);
    return this.transaction(async tx => {
      await this.owner(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "DocumentPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const auth = await tx.documentPurgeAuthorization.findFirst({ where: { id: authorizationId, organisationId }, select: { id: true, claim: { select: { id: true } } } });
      if (!auth) throw new AppError(404, 'PURGE_AUTHORIZATION_NOT_FOUND', 'Authorization not found');
      if (!auth.claim) throw new AppError(409, 'PURGE_NOT_CLAIMED', 'Record disposal evidence against a claimed authorization.');
      return tx.documentPurgeDispositionEvent.create({ data: { ...input, organisationId, actorUserId, authorizationId,
        observedAt: new Date(observedAt), nextReviewAt: nextReviewAt ? new Date(nextReviewAt) : null }, select: dispositionReview });
    });
  }

  async authorize(organisationId: string, actorUserId: string, raw: unknown) {
    const input = purgeAuthorizationInput.parse(raw);
    return this.transaction(async tx => {
      await this.owner(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${input.documentId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: input.documentId, organisationId, deletedAt: { not: null } } });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Deleted document not found');
      if (doc.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime() || doc.deletionHold) {
        throw new AppError(409, 'PURGE_DOCUMENT_CHANGED', 'Refresh this document and review its hold before authorizing disposal.');
      }
      await this.verifyBytes(organisationId, doc);
      return tx.documentPurgeAuthorization.create({ data: { organisationId, documentId: doc.id,
        documentRevision: doc.updatedAt, policyId: input.policyId, actorUserId, evidenceRef: input.evidenceRef,
        reason: input.reason, storagePath: doc.fileUrl, provider: doc.storageProvider!, sha256: doc.recoverySha256!,
        fileSize: doc.fileSize, recoveryUntil: doc.recoveryUntil!, dispositionPlan: input.dispositionPlan }, select: review });
    });
  }

  async withdraw(organisationId: string, actorUserId: string, authorizationId: string, raw: unknown) {
    const input = retentionWithdrawalInput.parse(raw);
    return this.transaction(async tx => {
      await this.owner(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "DocumentPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const auth = await tx.documentPurgeAuthorization.findFirst({ where: { id: authorizationId, organisationId }, select: review });
      if (!auth) throw new AppError(404, 'PURGE_AUTHORIZATION_NOT_FOUND', 'Authorization not found');
      if (auth.claim || auth.withdrawal) throw new AppError(409, 'PURGE_CANNOT_WITHDRAW', 'This authorization is already withdrawn or disposal has been claimed.');
      return tx.documentPurgeAuthorizationWithdrawal.create({ data: { organisationId, authorizationId, actorUserId, ...input } });
    });
  }

  async claim(organisationId: string, actorUserId: string, authorizationId: string, raw: unknown) {
    purgeClaimInput.parse(raw);
    return this.transaction(async tx => {
      await this.owner(tx, organisationId, actorUserId);
      await tx.$queryRaw`SELECT id FROM "DocumentPurgeAuthorization" WHERE id=${authorizationId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const auth = await tx.documentPurgeAuthorization.findFirst({ where: { id: authorizationId, organisationId }, include: { withdrawal: true, claim: true } });
      if (!auth) throw new AppError(404, 'PURGE_AUTHORIZATION_NOT_FOUND', 'Authorization not found');
      if (auth.withdrawal) throw new AppError(409, 'PURGE_AUTHORIZATION_WITHDRAWN', 'This disposal authorization was withdrawn.');
      if (auth.actorUserId !== actorUserId) throw new AppError(409, 'PURGE_OWNER_CHANGED', 'The current Owner must record a new disposal authorization.');
      // Retries report the existing claim; they never create another job.
      if (auth.claim) return { id: auth.claim.id, deletionId: auth.claim.deletionId, claimedAt: auth.claim.claimedAt };
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${auth.documentId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: auth.documentId, organisationId, deletedAt: { not: null } } });
      if (!doc) throw new AppError(409, 'PURGE_DOCUMENT_CHANGED', 'The document is no longer in Deleted Items.');
      await this.verifyBytes(organisationId, doc);
      return tx.documentPurgeClaim.create({ data: { organisationId, authorizationId, actorUserId,
        documentId: auth.documentId, deletionId: randomUUID() }, select: { id: true, deletionId: true, claimedAt: true } });
    });
  }
}
