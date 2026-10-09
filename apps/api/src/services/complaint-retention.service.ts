import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { calendarYearRetentionCutoffUtc } from './retention-calendar.js';

/** Read-only assessment. Removal must repeat these checks inside its own transaction. */
export class ComplaintRetentionService {
  constructor(private readonly prisma: PrismaClient) {}

  assess(organisationId: string, complaintId: string) {
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      const complaint = await tx.complaintRecord.findFirst({ where: { id: complaintId, organisationId, removedAt: null },
        select: { id: true, revision: true, status: true, receivedDate: true } });
      if (!complaint) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
      const policies = await tx.dataRetentionPolicyRevision.findMany({ where: {
        organisationId, recordClass: 'COMPLAINT', state: 'APPROVED', withdrawal: { is: null },
      }, orderBy: { revision: 'desc' }, take: 2 });
      const latest = await tx.complaintResolutionEvidence.findFirst({
        where: { organisationId, complaintId }, orderBy: { revision: 'desc' },
        select: { id: true, revision: true, recordRevision: true, state: true, resolvedAt: true },
      });
      const base = { complaintId, recordRevision: complaint.revision,
        evidenceRevision: latest?.revision ?? 0, assessedAt: clock!.now,
        policyId: policies.length === 1 ? policies[0]!.id : null,
        removalAuthorized: false as const };
      const hold = await tx.complaintHoldEvent.findFirst({ where: { organisationId, complaintId },
        orderBy: { revision: 'desc' }, select: { held: true } });
      if (hold?.held) return { ...base, state: 'ADMINISTRATIVE_HOLD' as const, retentionUntil: null };
      if (policies.length !== 1) return { ...base, state: 'POLICY_REVIEW_REQUIRED' as const, retentionUntil: null };
      const policy = policies[0]!;
      if (policy.retentionMode === 'PERMANENT') return { ...base, state: 'PERMANENT_RETENTION' as const, retentionUntil: null };
      if (complaint.status !== 'CLOSED') return { ...base, state: 'COMPLAINT_OPEN' as const, retentionUntil: null };
      const enforcement = await tx.complaintRecoveryEnforcement.findUnique({
        where: { organisationId }, select: { id: true },
      });
      if (policy.retentionMode === 'REVIEW_REQUIRED') return { ...base,
        state: enforcement ? 'INDEPENDENT_RECOVERY_REQUIRED' as const : 'INDIVIDUAL_REVIEW_REQUIRED' as const,
        retentionUntil: null };
      const timedDays = policy.retentionMode === 'AFTER_ANCHOR';
      const timedYears = policy.retentionMode === 'AFTER_CALENDAR_YEARS';
      if ((!timedDays && !timedYears) || policy.retentionAnchor !== 'RESOLVED_AT' ||
        (timedDays && (!Number.isInteger(policy.retentionDays) || policy.retentionDays! < 1 || policy.retentionDays! > 36525
          || policy.retentionYears != null)) ||
        (timedYears && (!Number.isInteger(policy.retentionYears) || policy.retentionYears! < 1 || policy.retentionYears! > 100
          || policy.retentionDays !== null))) {
        return { ...base, state: 'POLICY_REVIEW_REQUIRED' as const, retentionUntil: null };
      }
      if (!latest || latest.state !== 'RECORDED' || latest.recordRevision !== complaint.revision ||
        !latest.resolvedAt || latest.resolvedAt < complaint.receivedDate || latest.resolvedAt > clock!.now) {
        return { ...base, state: 'RESOLUTION_REVIEW_REQUIRED' as const, retentionUntil: null };
      }
      const retentionUntil = timedYears
        ? calendarYearRetentionCutoffUtc(latest.resolvedAt, policy.retentionYears!)
        : new Date(latest.resolvedAt.getTime() + policy.retentionDays! * 86400000);
      return { ...base, state: retentionUntil > clock!.now ? 'RETENTION_NOT_REACHED' as const
        : enforcement ? 'INDEPENDENT_RECOVERY_REQUIRED' as const : 'READY_FOR_REMOVAL_REVIEW' as const,
        retentionUntil };
    });
  }
}
