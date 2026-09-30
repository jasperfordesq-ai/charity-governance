import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const revision = z.number().int().positive().max(2147483647);
export const complaintHoldInput = z.object({
  expectedRecordRevision: revision,
  expectedHoldRevision: z.number().int().nonnegative().max(2147483646),
  held: z.boolean(), evidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  reason: z.string().trim().min(10).max(500).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/),
}).strict();
const review = { id: true, revision: true, recordRevision: true, held: true,
  actorUserId: true, evidenceRef: true, reason: true, occurredAt: true } as const;

export class ComplaintHoldService {
  constructor(private readonly prisma: PrismaClient) {}

  list(organisationId: string, complaintId: string, before?: number) {
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      const complaint = await tx.complaintRecord.findFirst({ where: { id: complaintId, organisationId },
        select: { revision: true } });
      if (!complaint) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      const latest = await tx.complaintHoldEvent.findFirst({ where: { organisationId, complaintId },
        orderBy: { revision: 'desc' }, select: { revision: true, held: true } });
      const rows = await tx.complaintHoldEvent.findMany({ where: { organisationId, complaintId,
        ...(before ? { revision: { lt: before } } : {}) }, orderBy: { revision: 'desc' }, take: 51, select: review });
      return { recordRevision: complaint.revision, holdRevision: latest?.revision ?? 0, held: latest?.held ?? false,
        items: rows.slice(0,50), nextBeforeRevision: rows.length>50 ? rows[49]!.revision : null };
    });
  }

  change(organisationId: string, complaintId: string, actorUserId: string, raw: unknown) {
    const input = complaintHoldInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      await tx.$queryRaw`SELECT id FROM "ComplaintRecord" WHERE id=${complaintId} AND "organisationId"=${organisationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        lifecycleStatus: 'ACTIVE', role: { in: ['OWNER','ADMIN'] } }, select: { id: true } });
      if (!actor) throw new AppError(403, 'COMPLAINT_HOLD_FORBIDDEN', 'An active charity administrator is required.');
      // Once independent recovery enforcement is bound to this charity, the
      // ordinary endpoint cannot create an unjournaled preservation decision.
      // The binding is append-only and the charity lock serializes activation.
      const enforcement = await tx.complaintRecoveryEnforcement.findUnique({ where: { organisationId }, select: { id: true } });
      if (enforcement) throw new AppError(409, 'COMPLAINT_HOLD_RECOVERY_REQUIRED',
        'This charity requires an independently recorded hold decision.');
      const complaint = await tx.complaintRecord.findFirst({ where: { id: complaintId, organisationId }, select: { revision: true } });
      if (!complaint) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      const previous = await tx.complaintHoldEvent.findFirst({ where: { organisationId, complaintId },
        orderBy: { revision: 'desc' }, select: { revision: true, held: true } });
      if (complaint.revision!==input.expectedRecordRevision || (previous?.revision ?? 0)!==input.expectedHoldRevision) {
        throw new AppError(409, 'COMPLAINT_HOLD_CONFLICT', 'The complaint or hold changed. Reload and review it again.');
      }
      if ((previous?.held ?? false)===input.held) {
        throw new AppError(409, 'COMPLAINT_HOLD_UNCHANGED', 'Review a change to the current hold state.');
      }
      return tx.complaintHoldEvent.create({ data: { organisationId, complaintId, actorUserId,
        revision: input.expectedHoldRevision+1, recordRevision: complaint.revision, held: input.held,
        evidenceRef: input.evidenceRef, reason: input.reason }, select: review });
    }, { isolationLevel: 'ReadCommitted' });
  }
}
