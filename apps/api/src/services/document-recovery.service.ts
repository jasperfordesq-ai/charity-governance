import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { calendarYearRetentionCutoffUtc } from './retention-calendar.js';

type RecoveryInput = {
  organisationId: string; documentId: string; actorUserId: string;
  expectedUpdatedAt: Date; reason: string;
};
type ReadFile = (organisationId: string, path: string, provider: string) => Promise<Buffer>;
const summary = { id: true, name: true, category: true, deletedAt: true,
  recoveryUntil: true, deletionHold: true, updatedAt: true, recoveryPolicyId: true } as const;

/** Files remain in their pinned store. No cleanup job is created by this service. */
export class DocumentRecoveryService {
  constructor(private readonly prisma: PrismaClient, private readonly readFile: ReadFile) {}

  private async actor(tx: Prisma.TransactionClient, input: RecoveryInput) {
    const actor = await tx.user.findFirst({ where: { id: input.actorUserId,
      organisationId: input.organisationId, role: { in: ['OWNER', 'ADMIN'] }, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!actor) throw new AppError(403, 'DOCUMENT_RECOVERY_FORBIDDEN', 'An active charity administrator is required.');
    if (Array.from(input.reason.trim()).length < 10 || Array.from(input.reason.trim()).length > 500
      || /[\u0000-\u001f\u007f-\u009f]/.test(input.reason)) {
      throw new AppError(400, 'DOCUMENT_RECOVERY_REASON_REQUIRED', 'Give a reason between 10 and 500 characters without control characters.');
    }
  }

  private async locked(tx: Prisma.TransactionClient, input: RecoveryInput, removed: boolean) {
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${input.documentId}
      AND "organisationId"=${input.organisationId} FOR UPDATE`;
    const doc = await tx.document.findFirst({ where: { id: input.documentId,
      organisationId: input.organisationId, deletedAt: removed ? { not: null } : null } });
    if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    if (doc.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new AppError(409, 'DOCUMENT_RECOVERY_CONFLICT', 'Document changed. Refresh and review it again.');
    }
    return doc;
  }

  async list(organisationId: string, before?: string) {
    const anchor = before ? await this.prisma.document.findFirst({ where: {
      id: before, organisationId, deletedAt: { not: null } }, select: { deletedAt: true, id: true } }) : null;
    if (before && !anchor) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Deleted-item cursor not found');
    const rows = await this.prisma.document.findMany({ where: { organisationId, deletedAt: { not: null },
      ...(anchor ? { OR: [{ deletedAt: { lt: anchor.deletedAt! } },
        { deletedAt: anchor.deletedAt, id: { lt: anchor.id } }] } : {}) },
      select: summary, orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }], take: 51 });
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  }

  async remove(input: RecoveryInput & { policyId: string; evidenceRef: string }) {
    if (!/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(input.evidenceRef)) {
      throw new AppError(400, 'DOCUMENT_REMOVAL_EVIDENCE_REQUIRED', 'Provide a controlled removal evidence reference.');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${input.organisationId} FOR UPDATE`;
      await this.actor(tx, input);
      const doc = await this.locked(tx, input, false);
      if (doc.deletionHold || doc.lifecycleStatus !== 'DRAFT' || doc.approvalAsserted || doc.approvedByResolutionId) {
        throw new AppError(409, 'DOCUMENT_RETENTION_REVIEW_REQUIRED', 'Only unheld drafts without approval evidence can enter Deleted Items.');
      }
      if (!['local', 'supabase'].includes(doc.storageProvider ?? '')) {
        throw new AppError(409, 'DOCUMENT_STORAGE_PROVIDER_UNVERIFIED', 'Review the recorded storage provider first.');
      }
      const [standard, citation, predecessor] = await Promise.all([
        tx.documentStandardLink.findFirst({ where: { documentId: doc.id }, select: { id: true } }),
        tx.confluenceReference.findFirst({ where: { documentId: doc.id }, select: { id: true } }),
        tx.document.findFirst({ where: { supersededByDocumentId: doc.id }, select: { id: true } }),
      ]);
      if (standard || citation || predecessor) throw new AppError(409,
        'DOCUMENT_LINKED_EVIDENCE_REVIEW_REQUIRED', 'Review this document’s evidence links before removal.');
      await tx.$queryRaw`SELECT id FROM "DataRetentionPolicyRevision" WHERE id=${input.policyId}
        AND "organisationId"=${input.organisationId} FOR UPDATE`;
      const policy = await tx.dataRetentionPolicyRevision.findFirst({ where: { id: input.policyId,
        organisationId: input.organisationId, recordClass: 'VAULT_DRAFT', state: 'APPROVED',
        withdrawal: { is: null } } });
      const competingPolicy = await tx.dataRetentionPolicyRevision.findFirst({ where: {
        id: { not: input.policyId }, organisationId: input.organisationId,
        recordClass: 'VAULT_DRAFT', state: 'APPROVED', withdrawal: { is: null },
      }, select: { id: true } });
      if (!policy || competingPolicy || !['REVIEW_REQUIRED', 'AFTER_ANCHOR', 'AFTER_CALENDAR_YEARS'].includes(policy.retentionMode)) throw new AppError(409,
        'DOCUMENT_RECOVERY_POLICY_REQUIRED', 'An approved current draft-removal policy is required.');
      if (policy.retentionMode === 'AFTER_ANCHOR' && (policy.retentionAnchor !== 'CREATED_AT'
        || !Number.isInteger(policy.retentionDays) || policy.retentionDays! < 1 || policy.retentionDays! > 36525)) {
        throw new AppError(409, 'DOCUMENT_RECOVERY_POLICY_REQUIRED', 'The approved draft-removal policy is invalid.');
      }
      if (policy.retentionMode === 'AFTER_CALENDAR_YEARS' && (policy.retentionAnchor !== 'CREATED_AT'
        || !Number.isInteger(policy.retentionYears) || policy.retentionYears! < 1 || policy.retentionYears! > 100
        || policy.retentionDays !== null)) {
        throw new AppError(409, 'DOCUMENT_RECOVERY_POLICY_REQUIRED', 'The approved draft-removal policy is invalid.');
      }
      const bytes = await this.readFile(input.organisationId, doc.fileUrl, doc.storageProvider!);
      if (bytes.length !== doc.fileSize) throw new AppError(409,
        'DOCUMENT_RECOVERY_FILE_MISMATCH', 'The stored file does not match its recorded size.');
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      const now = clock!.now;
      if (policy.retentionMode === 'AFTER_ANCHOR'
        && doc.createdAt.getTime() + policy.retentionDays! * 86400000 > now.getTime()) {
        throw new AppError(409, 'DOCUMENT_RETENTION_NOT_REACHED', 'The approved retention period has not elapsed.');
      }
      if (policy.retentionMode === 'AFTER_CALENDAR_YEARS'
        && calendarYearRetentionCutoffUtc(doc.createdAt, policy.retentionYears!) > now) {
        throw new AppError(409, 'DOCUMENT_RETENTION_NOT_REACHED', 'The approved retention period has not elapsed.');
      }
      const result = await tx.document.update({ where: { id: doc.id, organisationId: input.organisationId }, data: {
        deletedAt: now, deletedById: input.actorUserId, removedFromRevision: doc.updatedAt,
        removalEvidenceRef: input.evidenceRef, recoveryPolicyId: policy.id,
        recoveryUntil: new Date(now.getTime() + policy.recoveryDays * 86400000),
        recoverySha256: createHash('sha256').update(bytes).digest('hex'),
        visibility: 'RESTRICTED', contentAccessClass: 'UNASSESSED', memberReviewedSha256: null,
        externalPublicationApproved: false, externalPublicationSiteId: null, externalPublicationSpaceId: null,
        updatedAt: now,
      }, select: summary });
      await tx.documentControlAudit.create({ data: { organisationId: input.organisationId,
        documentId: doc.id, actorUserId: input.actorUserId, kind: 'RECORD_REMOVE',
        previous: 'ACTIVE', next: 'RECOVERABLE', reason: input.reason.trim() } });
      return result;
    }, { timeout: 90000 });
  }

  async restore(input: RecoveryInput) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${input.organisationId} FOR UPDATE`;
      await this.actor(tx, input);
      const doc = await this.locked(tx, input, true);
      // Restoring preserves a hold. A hold forbids destruction, not recovery.
      if (!doc.recoverySha256 || !['local', 'supabase'].includes(doc.storageProvider ?? '')) {
        throw new AppError(409, 'DOCUMENT_RECOVERY_EVIDENCE_MISSING', 'Stored-file recovery evidence is missing.');
      }
      const bytes = await this.readFile(input.organisationId, doc.fileUrl, doc.storageProvider!);
      if (bytes.length !== doc.fileSize || createHash('sha256').update(bytes).digest('hex') !== doc.recoverySha256) {
        throw new AppError(409, 'DOCUMENT_RECOVERY_FILE_MISMATCH', 'The stored file differs from the removed file.');
      }
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (!doc.recoveryUntil || clock!.now >= doc.recoveryUntil) throw new AppError(409,
        'DOCUMENT_RECOVERY_EXPIRED', 'The approved recovery window has expired. Review the disposition separately.');
      const result = await tx.document.update({ where: { id: doc.id, organisationId: input.organisationId }, data: {
        deletedAt: null, deletedById: null, removedFromRevision: null, removalEvidenceRef: null,
        recoveryPolicyId: null, recoveryUntil: null, recoverySha256: null, updatedAt: clock!.now,
      }, select: summary });
      await tx.documentControlAudit.create({ data: { organisationId: input.organisationId,
        documentId: doc.id, actorUserId: input.actorUserId, kind: 'RECORD_RESTORE',
        previous: 'RECOVERABLE', next: 'ACTIVE_RESTRICTED', reason: input.reason.trim() } });
      return result;
    }, { timeout: 90000 });
  }
}
