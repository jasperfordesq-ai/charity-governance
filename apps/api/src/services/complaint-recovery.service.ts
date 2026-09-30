import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

type Input = { organisationId: string; complaintId: string; actorUserId: string; expectedRevision: number };
const summary = { id: true, summary: true, receivedDate: true, revision: true, removedAt: true,
  removal: { select: { id: true, recoveryUntil: true, evidenceRef: true } } } as const;

export class ComplaintRecoveryService {
  constructor(private readonly prisma: PrismaClient) {}

  private async lock(tx: Prisma.TransactionClient, input: Input, removed: boolean) {
    await lockOrganisationForUpdate(tx, input.organisationId);
    await tx.$queryRaw`SELECT id FROM "ComplaintRecord" WHERE id=${input.complaintId} AND "organisationId"=${input.organisationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.actorUserId} AND "organisationId"=${input.organisationId} FOR SHARE`;
    const actor = await tx.user.findFirst({ where: { id: input.actorUserId, organisationId: input.organisationId,
      lifecycleStatus: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } }, select: { id: true } });
    if (!actor) throw new AppError(403, 'COMPLAINT_RECOVERY_FORBIDDEN', 'An active charity administrator is required.');
    const complaint = await tx.complaintRecord.findFirst({ where: { id: input.complaintId, organisationId: input.organisationId,
      removedAt: removed ? { not: null } : null }, include: { removal: true } });
    if (!complaint) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
    if (complaint.revision !== input.expectedRevision) throw new AppError(409, 'COMPLAINT_RECOVERY_CONFLICT', 'The complaint changed. Reload and review it again.');
    return complaint;
  }

  async list(organisationId: string, before?: string) {
    const anchor = before ? await this.prisma.complaintRecord.findFirst({ where: { id: before, organisationId, removedAt: { not: null } },
      select: { removedAt: true, id: true } }) : null;
    if (before && !anchor) throw new AppError(409, 'COMPLAINT_RECOVERY_LIST_CHANGED', 'The recovery list changed. Reload it.');
    const rows = await this.prisma.complaintRecord.findMany({ where: { organisationId, removedAt: { not: null },
      ...(anchor ? { OR: [{ removedAt: { lt: anchor.removedAt! } }, { removedAt: anchor.removedAt, id: { lt: anchor.id } }] } : {}) },
      orderBy: [{ removedAt: 'desc' }, { id: 'desc' }], take: 51, select: summary });
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  }

  remove(input: Input & { policyId: string; expectedEvidenceRevision: number; evidenceRef: string; reason: string }) {
    return this.prisma.$transaction(async tx => {
      const complaint = await this.lock(tx, input, false);
      if (complaint.status !== 'CLOSED' || complaint.reviewedByBoard || complaint.boardMinuteReference?.trim()) {
        throw new AppError(409, 'COMPLAINT_REMOVAL_REVIEW_REQUIRED', 'Only closed complaints without retained board evidence can enter recovery.');
      }
      const policies = await tx.dataRetentionPolicyRevision.findMany({ where: { organisationId: input.organisationId,
        recordClass: 'COMPLAINT', state: 'APPROVED', withdrawal: { is: null } }, take: 2 });
      const policy = policies.length === 1 ? policies[0] : null;
      if (!policy || policy.id !== input.policyId || policy.retentionMode === 'PERMANENT') {
        throw new AppError(409, 'COMPLAINT_POLICY_CHANGED', 'Review the current approved complaint policy before removal.');
      }
      const evidence = await tx.complaintResolutionEvidence.findFirst({ where: { organisationId: input.organisationId,
        complaintId: input.complaintId }, orderBy: { revision: 'desc' } });
      if ((evidence?.revision ?? 0) !== input.expectedEvidenceRevision) throw new AppError(409, 'COMPLAINT_RESOLUTION_CONFLICT', 'Resolution evidence changed. Reload the review.');
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (policy.retentionMode === 'AFTER_ANCHOR' && (policy.retentionAnchor !== 'RESOLVED_AT' ||
        !Number.isInteger(policy.retentionDays) || policy.retentionDays! < 1 || policy.retentionDays! > 36525 ||
        !evidence?.resolvedAt || evidence.state !== 'RECORDED' || evidence.recordRevision !== complaint.revision ||
        evidence.resolvedAt.getTime() + policy.retentionDays! * 86400000 > clock!.now.getTime())) {
        throw new AppError(409, 'COMPLAINT_RETENTION_NOT_REACHED', 'Current resolution evidence and elapsed retention are required.');
      }
      const decision = await tx.complaintRemoval.create({ data: {
        organisationId: input.organisationId, complaintId: complaint.id, recordRevision: complaint.revision,
        actorUserId: input.actorUserId, policyId: policy.id,
        resolutionEvidenceId: policy.retentionMode === 'AFTER_ANCHOR' ? evidence!.id : null,
        evidenceRef: input.evidenceRef, reason: input.reason,
      } });
      const row = await tx.complaintRecord.update({ where: { id: complaint.id, organisationId: input.organisationId },
        data: { removalId: decision.id, removedAt: decision.occurredAt }, select: summary });
      await this.audit(tx, input, 'ACTIVE', 'RECOVERABLE');
      return row;
    });
  }

  restore(input: Input) {
    return this.prisma.$transaction(async tx => {
      const complaint = await this.lock(tx, input, true);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (!complaint.removal || clock!.now >= complaint.removal.recoveryUntil) {
        throw new AppError(409, 'COMPLAINT_RECOVERY_EXPIRED', 'The approved recovery window has expired. Review the disposition separately.');
      }
      const row = await tx.complaintRecord.update({ where: { id: complaint.id, organisationId: input.organisationId },
        data: { removalId: null, removedAt: null }, select: summary });
      await this.audit(tx, input, 'RECOVERABLE', 'ACTIVE');
      return row;
    });
  }

  private audit(tx: Prisma.TransactionClient, input: Input, previousStatus: string, nextStatus: string) {
    return tx.governanceRegisterChangeAudit.create({ data: { organisationId: input.organisationId,
      recordKind: 'COMPLAINT', recordId: input.complaintId, actorUserId: input.actorUserId, action: 'UPDATE',
      previousStatus, nextStatus, changedFields: ['removedAt', 'removalId'] } });
  }
}
