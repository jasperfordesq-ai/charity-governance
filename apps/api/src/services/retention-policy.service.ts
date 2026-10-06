import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';

const evidence = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const terms = z.object({
  retentionMode: z.enum(['REVIEW_REQUIRED', 'PERMANENT', 'AFTER_ANCHOR']),
  retentionDays: z.number().int().min(1).max(36525).nullable(),
  recoveryDays: z.number().int().min(1).max(3650),
});
export const retentionPolicyInput = z.discriminatedUnion('state', [
  terms.extend({ state: z.literal('DRAFT') }).strict(),
  terms.extend({ state: z.literal('APPROVED'), approvalEvidenceRef: evidence,
    authorityConfirmed: z.literal(true) }).strict(),
]).superRefine((value, context) => {
  if ((value.retentionMode === 'AFTER_ANCHOR') !== (value.retentionDays !== null)) {
    context.addIssue({ code: 'custom', path: ['retentionDays'], message: 'Only a timed retention rule has retention days.' });
  }
});
export const retentionWithdrawalInput = z.object({
  evidenceRef: evidence,
  reason: z.string().trim().refine(value => Array.from(value).length >= 10 && Array.from(value).length <= 500
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'Give a reason of 10–500 characters without control characters'),
}).strict();

export type RetentionRecordClass = 'VAULT_DRAFT' | 'COMPLAINT' | 'DOCUMENT_COPY' | 'COMPLAINT_COPY';

/** Class is chosen by the server route, never by a submitted policy body. */
export class RetentionPolicyService {
  constructor(private readonly prisma: PrismaClient, private readonly recordClass: RetentionRecordClass = 'VAULT_DRAFT') {}

  async list(organisationId: string, before?: number) {
    const rows = await this.prisma.dataRetentionPolicyRevision.findMany({ where: {
      organisationId, recordClass: this.recordClass, ...(before ? { revision: { lt: before } } : {}),
    }, include: { withdrawal: true }, orderBy: { revision: 'desc' }, take: 51 });
    return { items: rows.slice(0, 50), nextBefore: rows.length > 50 ? rows[49]!.revision : null };
  }

  async create(organisationId: string, actorUserId: string, raw: unknown) {
    const input = retentionPolicyInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      // Allocate versions and supersede prior approvals in one charity-scoped transaction.
      await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId, lifecycleStatus: 'ACTIVE',
        role: { in: input.state === 'APPROVED' ? ['OWNER'] : ['OWNER', 'ADMIN'] } }, select: { id: true } });
      if (!actor) throw new AppError(403, 'RETENTION_POLICY_AUTHORITY_REQUIRED',
        input.state === 'APPROVED' ? 'Only the active charity Owner can approve a policy.' : 'An active charity administrator is required.');
      if (this.recordClass === 'COMPLAINT' && await tx.complaintRecoveryEnforcement.findUnique({
        where: { organisationId }, select: { id: true },
      })) throw new AppError(409, 'RETENTION_POLICY_RECOVERY_REQUIRED',
        'Complaint policy changes require an independently recorded recovery decision.');
      const latest = await tx.dataRetentionPolicyRevision.findFirst({ where: { organisationId, recordClass: this.recordClass },
        orderBy: { revision: 'desc' }, select: { revision: true } });
      const revision = (latest?.revision ?? 0) + 1;
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      if (input.state === 'APPROVED') {
        const previous = await tx.$queryRaw<Array<{ id: string }>>`SELECT p.id FROM "DataRetentionPolicyRevision" p
          WHERE p."organisationId"=${organisationId} AND p."recordClass"=${this.recordClass} AND p.state='APPROVED'
          AND NOT EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" w WHERE w."policyId"=p.id)
          ORDER BY p.revision FOR UPDATE OF p`;
        for (const prior of previous) await tx.dataRetentionPolicyWithdrawal.create({ data: {
          organisationId, policyId: prior.id, actorUserId,
          reason: `Superseded by approved policy revision ${revision}.`, evidenceRef: input.approvalEvidenceRef,
          occurredAt: clock!.now,
        } });
      }
      return tx.dataRetentionPolicyRevision.create({ data: {
        organisationId, recordClass: this.recordClass, revision, state: input.state,
        retentionMode: input.retentionMode, retentionAnchor: input.retentionMode === 'AFTER_ANCHOR'
          ? this.recordClass === 'COMPLAINT' ? 'RESOLVED_AT' : 'CREATED_AT' : null,
        retentionDays: input.retentionDays, recoveryDays: input.recoveryDays, createdById: actorUserId,
        ...(input.state === 'APPROVED' ? { approvedById: actorUserId, approvedAt: clock!.now,
          approvalEvidenceRef: input.approvalEvidenceRef } : {}),
      } });
    });
  }

  async withdraw(organisationId: string, actorUserId: string, policyId: string, raw: unknown) {
    const input = retentionWithdrawalInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      // Use the same ordering as replacement approval, so a concurrent
      // withdrawal cannot race its NOT EXISTS selection and duplicate a fact.
      await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id=${organisationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "DataRetentionPolicyRevision" WHERE id=${policyId}
        AND "organisationId"=${organisationId} FOR UPDATE`;
      const policy = await tx.dataRetentionPolicyRevision.findFirst({ where: { id: policyId, organisationId,
        recordClass: this.recordClass, state: 'APPROVED' }, include: { withdrawal: true } });
      if (!policy) throw new AppError(404, 'RETENTION_POLICY_NOT_FOUND', 'Approved policy not found');
      if (policy.withdrawal) throw new AppError(409, 'RETENTION_POLICY_WITHDRAWN', 'This policy is already withdrawn. Refresh its history.');
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
      if (!actor) throw new AppError(403, 'RETENTION_POLICY_AUTHORITY_REQUIRED', 'Only the active charity Owner can withdraw a policy.');
      if (this.recordClass === 'COMPLAINT' && await tx.complaintRecoveryEnforcement.findUnique({
        where: { organisationId }, select: { id: true },
      })) throw new AppError(409, 'RETENTION_POLICY_RECOVERY_REQUIRED',
        'Complaint policy changes require an independently recorded recovery decision.');
      return tx.dataRetentionPolicyWithdrawal.create({ data: { organisationId, policyId, actorUserId, ...input } });
    });
  }
}
