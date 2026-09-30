import {
  AnnualReportFilingStatus,
  ConflictStatus,
  RegisterStatus,
  validateAnnualReportReadinessCompleteState,
  validateFundraisingRecordCompleteState,
  type AnnualReportReadinessResponse,
  type CreateComplaintRecordRequest,
  type CreateConflictRecordRequest,
  type CreateFundraisingRecordRequest,
  type CreateRiskRecordRequest,
  type FinancialControlReviewResponse,
  type GovernanceRegistersSummary,
  type UpsertAnnualReportReadinessRequest,
  type UpsertFinancialControlReviewRequest,
} from '@charitypilot/shared';
import type { AnnualReportReadiness, Prisma, PrismaClient } from '@prisma/client';
import {
  runDomainInvariantWrite,
  validateDomainCompleteState,
} from '../utils/domain-validation.js';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { assertUnchanged } from '../utils/optimistic-concurrency.js';

const toDate = (value?: string | null) => (value ? new Date(value) : null);

// Keep unclassified narrative and personal fields out of Member reads, not
// merely out of the response assembled by the route.
const memberRiskSelect = {
  id: true, organisationId: true, category: true, likelihood: true,
  impact: true, reviewDate: true, status: true, createdAt: true, updatedAt: true,
} satisfies Prisma.RiskRecordSelect;

const memberFundraisingSelect = {
  id: true, organisationId: true, activityType: true, startDate: true,
  endDate: true, publicFacing: true, complaintsReceived: true, status: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.FundraisingRecordSelect;

const memberAnnualReadinessSelect = {
  id: true, organisationId: true, reportingYear: true,
  financialStatementsApproved: true, annualReportUploaded: true,
  trusteeDetailsReviewed: true, fundraisingReviewed: true,
  complaintsReviewed: true, boardApprovalDate: true, filingStatus: true,
  filedDate: true, updatedAt: true,
} satisfies Prisma.AnnualReportReadinessSelect;

const memberFinancialReviewSelect = {
  id: true, organisationId: true, reportingYear: true,
  bankReconciliationsReviewed: true, dualAuthorisation: true,
  budgetApproved: true, managementAccountsReviewed: true,
  reservesReviewed: true, restrictedFundsReviewed: true,
  assetsInsuranceReviewed: true, payrollControlsReviewed: true,
  fundraisingControlsReviewed: true, reviewDate: true, updatedAt: true,
} satisfies Prisma.FinancialControlReviewSelect;

function annualReportReadinessResponse(
  record: AnnualReportReadiness,
): AnnualReportReadinessResponse {
  return {
    id: record.id,
    organisationId: record.organisationId,
    reportingYear: record.reportingYear,
    activitiesNarrative: record.activitiesNarrative,
    publicBenefitStatement: record.publicBenefitStatement,
    beneficiariesSummary: record.beneficiariesSummary,
    financialStatementsApproved: record.financialStatementsApproved,
    annualReportUploaded: record.annualReportUploaded,
    trusteeDetailsReviewed: record.trusteeDetailsReviewed,
    fundraisingReviewed: record.fundraisingReviewed,
    complaintsReviewed: record.complaintsReviewed,
    boardApprovalDate: record.boardApprovalDate?.toISOString() ?? null,
    filingStatus: record.filingStatus as AnnualReportFilingStatus,
    filedDate: record.filedDate?.toISOString() ?? null,
    notes: record.notes,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** The four registers, which differ only in their table and their refusal. */
export type RegisterRecordKind = 'conflict' | 'risk' | 'complaint' | 'fundraising';

const REGISTER_RECORDS: Record<
  RegisterRecordKind,
  { delegate: string; code: string; name: string }
> = {
  conflict: { delegate: 'conflictRecord', code: 'CONFLICT_NOT_FOUND', name: 'Conflict record' },
  risk: { delegate: 'riskRecord', code: 'RISK_NOT_FOUND', name: 'Risk record' },
  complaint: {
    delegate: 'complaintRecord',
    code: 'COMPLAINT_NOT_FOUND',
    name: 'Complaint record',
  },
  fundraising: {
    delegate: 'fundraisingRecord',
    code: 'FUNDRAISING_NOT_FOUND',
    name: 'Fundraising record',
  },
};

export class GovernanceRegisterService {
  constructor(private prisma: PrismaClient) {}

  private recordRegisterChange(tx: Prisma.TransactionClient, input: {
    organisationId: string;
    recordKind: 'CONFLICT' | 'COMPLAINT' | 'FUNDRAISING' | 'ANNUAL_REPORT' | 'FINANCIAL_CONTROL';
    recordId: string;
    actorUserId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    previousStatus?: string | null;
    nextStatus?: string | null;
    changedFields: string[];
  }) {
    return tx.governanceRegisterChangeAudit.create({ data: {
      ...input,
      previousStatus: input.previousStatus ?? null,
      nextStatus: input.nextStatus ?? null,
    } });
  }

  private riskAuditState(row: unknown): Prisma.InputJsonValue {
    // A fixed model row becomes ordinary JSON; dates are retained as ISO text.
    // Keeping the old narrative here makes later C1 corrections reviewable.
    return JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
  }

  async summary(organisationId: string, reportingYear: number): Promise<GovernanceRegistersSummary> {
    const [openConflicts, openRisks, openComplaints, activeFundraisingActivities, annual, financial] = await Promise.all([
      this.prisma.conflictRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
      this.prisma.riskRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
      this.prisma.complaintRecord.count({ where: { organisationId, removedAt: null, status: { not: 'CLOSED' } } }),
      this.prisma.fundraisingRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
      this.getAnnualReportReadiness(organisationId, reportingYear),
      this.getFinancialControlReview(organisationId, reportingYear),
    ]);

    return {
      openConflicts,
      openRisks,
      openComplaints,
      activeFundraisingActivities,
      annualReportReadinessPercent: annualReadinessPercent(annual),
      financialControlsPercent: financialControlsPercent(financial),
    };
  }

  /**
   * One register record, whichever of the four registers it is in.
   *
   * Written once rather than four times because the four differ only in the
   * table and the code they refuse with, and a copy of this per register is
   * four places to forget the organisationId.
   */
  async getRecord(kind: RegisterRecordKind, organisationId: string, id: string) {
    const { delegate, code, name } = REGISTER_RECORDS[kind];
    const record = await (this.prisma as unknown as Record<string, {
      findFirst: (args: unknown) => Promise<unknown>;
    }>)[delegate]!.findFirst({ where: { id, organisationId, ...(kind === 'complaint' ? { removedAt: null } : {}) } });

    if (!record) throw new AppError(404, code, `${name} not found`);
    return record;
  }

  listConflicts(organisationId: string) {
    return this.prisma.conflictRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { dateDeclared: 'desc' }],
    });
  }

  async createConflict(organisationId: string, data: CreateConflictRecordRequest, actorUserId: string) {
    return runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        await this.ensureBoardMember(transaction, organisationId, data.boardMemberId);

        const row = await transaction.conflictRecord.create({
          data: {
            organisationId,
            boardMemberId: data.boardMemberId || null,
            trusteeName: data.trusteeName,
            matter: data.matter,
            nature: data.nature,
            dateDeclared: new Date(data.dateDeclared),
            meetingDate: toDate(data.meetingDate),
            actionTaken: data.actionTaken,
            decision: data.decision,
            status: data.status ?? ConflictStatus.DECLARED,
            minuteReference: data.minuteReference,
            nextReviewDate: toDate(data.nextReviewDate),
          },
        });
        await this.recordRegisterChange(transaction, {
          organisationId, recordKind: 'CONFLICT', recordId: row.id, actorUserId, action: 'CREATE',
          nextStatus: row.status, changedFields: Object.keys(data),
        });
        return row;
      }),
      { boardMemberForeignKeyFailure: 'target-not-found' },
    );
  }

  async updateConflict(
    organisationId: string,
    id: string,
    data: Partial<CreateConflictRecordRequest>,
    expectedUpdatedAt: string | undefined,
    actorUserId: string,
  ) {
    return runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const record = await transaction.conflictRecord.findFirst({
          where: { id, organisationId },
          select: { id: true, updatedAt: true, status: true },
        });
        if (!record) {
          throw new AppError(404, 'CONFLICT_NOT_FOUND', 'Governance register record not found');
        }
        assertUnchanged(record, expectedUpdatedAt, 'REGISTER_UPDATE_CONFLICT');
        if (data.boardMemberId !== undefined) {
          await this.ensureBoardMember(transaction, organisationId, data.boardMemberId);
        }

        const row = await transaction.conflictRecord.update({
          where: { id },
          data: {
            boardMemberId: data.boardMemberId === undefined ? undefined : data.boardMemberId || null,
            trusteeName: data.trusteeName,
            matter: data.matter,
            nature: data.nature,
            dateDeclared: data.dateDeclared ? new Date(data.dateDeclared) : undefined,
            meetingDate: data.meetingDate === undefined ? undefined : toDate(data.meetingDate),
            actionTaken: data.actionTaken,
            decision: data.decision,
            status: data.status,
            minuteReference: data.minuteReference,
            nextReviewDate: data.nextReviewDate === undefined ? undefined : toDate(data.nextReviewDate),
          },
        });
        await this.recordRegisterChange(transaction, {
          organisationId, recordKind: 'CONFLICT', recordId: id, actorUserId, action: 'UPDATE',
          previousStatus: record.status, nextStatus: row.status,
          changedFields: Object.entries(data).filter(([, value]) => value !== undefined).map(([field]) => field),
        });
        return row;
      }),
      {
        boardMemberForeignKeyFailure: data.boardMemberId === undefined ? undefined : 'target-not-found',
        recordNotFound: {
          code: 'CONFLICT_NOT_FOUND',
          message: 'Governance register record not found',
        },
      },
    );
  }

  async removeConflict(organisationId: string, id: string, actorUserId: string) {
    await runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const record = await transaction.conflictRecord.findFirst({
          where: { id, organisationId },
          select: { id: true, status: true },
        });
        if (!record) {
          throw new AppError(404, 'CONFLICT_NOT_FOUND', 'Governance register record not found');
        }
        await transaction.conflictRecord.delete({ where: { id } });
        await this.recordRegisterChange(transaction, {
          organisationId, recordKind: 'CONFLICT', recordId: id, actorUserId, action: 'DELETE',
          previousStatus: record.status, changedFields: [],
        });
      }),
      {
        recordNotFound: {
          code: 'CONFLICT_NOT_FOUND',
          message: 'Governance register record not found',
        },
      },
    );
  }

  listRisks(organisationId: string) {
    return this.prisma.riskRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { reviewDate: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  listMemberRisks(organisationId: string) {
    return this.prisma.riskRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { reviewDate: 'asc' }, { updatedAt: 'desc' }],
      select: memberRiskSelect,
    });
  }

  async getMemberRisk(organisationId: string, id: string) {
    const row = await this.prisma.riskRecord.findFirst({
      where: { id, organisationId }, select: memberRiskSelect,
    });
    if (!row) throw new AppError(404, 'RISK_NOT_FOUND', 'Risk record not found');
    return row;
  }

  createRisk(organisationId: string, data: CreateRiskRecordRequest, actorUserId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const risk = await tx.riskRecord.create({
        data: {
          organisationId,
          title: data.title,
          category: data.category,
          description: data.description,
          likelihood: data.likelihood,
          impact: data.impact,
          mitigation: data.mitigation,
          owner: data.owner,
          reviewDate: toDate(data.reviewDate),
          status: data.status ?? RegisterStatus.OPEN,
          boardMinuteReference: data.boardMinuteReference,
        },
      });
      await tx.riskChangeAudit.create({ data: {
        organisationId, riskId: risk.id, actorUserId, action: 'CREATE',
        afterState: this.riskAuditState(risk),
      } });
      return risk;
    });
  }

  async updateRisk(organisationId: string, id: string, data: Partial<CreateRiskRecordRequest>, expectedUpdatedAt?: string, actorUserId?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.riskRecord.findFirst({ where: { id, organisationId } });
        if (!before) throw new AppError(404, 'RISK_NOT_FOUND', 'Governance register record not found');
        if (Object.values(data).every((value) => value === undefined)) {
          throw new AppError(400, 'RISK_UPDATE_EMPTY', 'Choose a risk field to change.');
        }
        assertUnchanged(before, expectedUpdatedAt, 'REGISTER_UPDATE_CONFLICT');
        const after = await tx.riskRecord.update({
          where: { id, organisationId, updatedAt: before.updatedAt, revision: before.revision },
          data: {
            revision: { increment: 1 },
            title: data.title,
            category: data.category,
            description: data.description,
            likelihood: data.likelihood,
            impact: data.impact,
            mitigation: data.mitigation,
            owner: data.owner,
            reviewDate: data.reviewDate === undefined ? undefined : toDate(data.reviewDate),
            status: data.status,
            boardMinuteReference: data.boardMinuteReference,
          },
        });
        await tx.riskChangeAudit.create({ data: {
          organisationId, riskId: id, actorUserId, action: 'UPDATE',
          beforeState: this.riskAuditState(before), afterState: this.riskAuditState(after),
        } });
        return after;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new AppError(409, 'REGISTER_UPDATE_CONFLICT', 'The risk changed during this update. Read it again and retry.');
      }
      throw error;
    }
  }

  async removeRisk(organisationId: string, id: string, actorUserId?: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.riskRecord.findFirst({ where: { id, organisationId } });
        if (!before) throw new AppError(404, 'RISK_NOT_FOUND', 'Governance register record not found');
        await tx.riskRecord.delete({ where: { id, organisationId, updatedAt: before.updatedAt, revision: before.revision } });
        await tx.riskChangeAudit.create({ data: {
          organisationId, riskId: id, actorUserId, action: 'DELETE',
          beforeState: this.riskAuditState(before),
        } });
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new AppError(409, 'REGISTER_UPDATE_CONFLICT', 'The risk changed during deletion. Read it again and retry.');
      }
      throw error;
    }
  }

  async listRiskAudit(organisationId: string, before?: string) {
    const anchor = before ? await this.prisma.riskChangeAudit.findFirst({
      where: { id: before, organisationId }, select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'RISK_AUDIT_CURSOR_NOT_FOUND', 'Risk change cursor not found');
    }
    const rows = await this.prisma.riskChangeAudit.findMany({
      where: { organisationId, ...(anchor ? { OR: [
        { occurredAt: { lt: anchor.occurredAt } },
        { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
      ] } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].id : null };
  }

  listRiskControlVerifications(organisationId: string) {
    return this.prisma.riskControlVerification.findMany({
      where: { organisationId }, orderBy: { sequence: 'desc' }, take: 100,
    });
  }

  async listRiskControlReviewAttention(organisationId: string, after?: string) {
    const anchor = after ? await this.prisma.riskControlVerification.findFirst({
      where: { id: after, organisationId },
      select: { riskId: true, controlReference: true },
    }) : null;
    if (after && !anchor) {
      throw new AppError(404, 'RISK_CONTROL_CURSOR_NOT_FOUND', 'Control review cursor not found');
    }
    const rows = await this.prisma.$queryRaw<Array<{
      claimId: string; riskId: string; controlReference: string;
      riskRevision: number | null; currentRiskRevision: number;
    }>>`
      WITH latest_claim AS (
        SELECT DISTINCT ON (v."riskId", v."controlReference")
          v."id" AS "claimId", v."riskId", v."controlReference",
          v."riskRevision", v."state"
        FROM "RiskControlVerification" v
        WHERE v."organisationId" = ${organisationId}
        ORDER BY v."riskId", v."controlReference", v."sequence" DESC
      )
      SELECT latest."claimId", latest."riskId", latest."controlReference",
        latest."riskRevision", risk."revision" AS "currentRiskRevision"
      FROM latest_claim latest
      JOIN "RiskRecord" risk ON risk."id" = latest."riskId"
        AND risk."organisationId" = ${organisationId}
      WHERE latest."state" = 'VERIFIED'
        AND latest."riskRevision" IS DISTINCT FROM risk."revision"
        AND (${anchor?.riskId ?? null}::text IS NULL OR
          (latest."riskId", latest."controlReference") >
          (${anchor?.riskId ?? null}::text, ${anchor?.controlReference ?? null}::text))
      ORDER BY latest."riskId", latest."controlReference"
      LIMIT 51
    `;
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1].claimId : null };
  }

  async listRiskControlHistory(organisationId: string, riskId: string, before?: string, controlReference?: string) {
    const risk = await this.prisma.riskRecord.findFirst({
      where: { id: riskId, organisationId }, select: { id: true, revision: true },
    });
    if (!risk) throw new AppError(404, 'RISK_NOT_FOUND', 'Governance register record not found');

    const anchor = before ? await this.prisma.riskControlVerification.findFirst({
      where: { id: before, riskId, organisationId, ...(controlReference ? { controlReference } : {}) },
      select: { sequence: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'RISK_CONTROL_CURSOR_NOT_FOUND', 'Control history cursor not found');
    }

    const rows = await this.prisma.riskControlVerification.findMany({
      where: {
        organisationId, riskId,
        ...(controlReference ? { controlReference } : {}),
        ...(anchor ? { sequence: { lt: anchor.sequence } } : {}),
      },
      orderBy: { sequence: 'desc' },
      take: 51,
    });
    const events = rows.slice(0, 50);
    return {
      riskRevision: risk.revision,
      events,
      nextCursor: rows.length > 50 ? events[events.length - 1].id : null,
    };
  }

  async recordRiskControlVerification(input: {
    organisationId: string;
    riskId: string;
    actorUserId: string;
    controlReference: string;
    state: 'VERIFIED' | 'WITHDRAWN';
    verifiedAt?: string;
    evidenceReference?: string;
    affectedRelease?: string;
    reason: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // The row lock serialises claims and withdrawals for this risk, and
      // excludes a concurrent delete until this evidence decision commits.
      const risks = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
        SELECT "id", "revision" FROM "RiskRecord"
        WHERE "id" = ${input.riskId} AND "organisationId" = ${input.organisationId}
        FOR UPDATE
      `;
      if (risks.length === 0) throw new AppError(404, 'RISK_NOT_FOUND', 'Governance register record not found');
      if (input.state === 'WITHDRAWN') {
        const latest = await tx.riskControlVerification.findFirst({
          where: { organisationId: input.organisationId, riskId: input.riskId, controlReference: input.controlReference },
          orderBy: { sequence: 'desc' },
          select: { state: true },
        });
        if (latest?.state !== 'VERIFIED') {
          throw new AppError(409, 'RISK_CONTROL_NOT_VERIFIED', 'Only a currently recorded verification may be withdrawn.');
        }
      }
      return tx.riskControlVerification.create({ data: {
        organisationId: input.organisationId,
        riskId: input.riskId,
        actorUserId: input.actorUserId,
        controlReference: input.controlReference,
        state: input.state,
        verifiedAt: input.state === 'VERIFIED' ? new Date(input.verifiedAt!) : null,
        riskRevision: risks[0].revision,
        evidenceReference: input.state === 'VERIFIED' ? input.evidenceReference! : null,
        affectedRelease: input.affectedRelease ?? null,
        reason: input.reason,
      } });
    });
  }

  listComplaints(organisationId: string) {
    return this.prisma.complaintRecord.findMany({
      where: { organisationId, removedAt: null },
      orderBy: [{ status: 'asc' }, { receivedDate: 'desc' }],
    });
  }

  async listComplaintResolutionEvidence(organisationId: string, complaintId: string, beforeRevision?: number) {
    // Retained evidence remains readable after source removal, scoped by both IDs.
    const rows = await this.prisma.complaintResolutionEvidence.findMany({
      where: { organisationId, complaintId, ...(beforeRevision === undefined ? {} : { revision: { lt: beforeRevision } }) },
      orderBy: { revision: 'desc' }, take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextBeforeRevision: rows.length > 50 ? items[items.length - 1]!.revision : null };
  }

  async recordComplaintResolutionEvidence(input: {
    organisationId: string; complaintId: string; actorUserId: string;
    expectedRecordRevision: number; expectedEvidenceRevision: number;
    state: 'RECORDED' | 'WITHDRAWN'; resolvedAt?: string;
    evidenceRef: string; reason: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, input.organisationId);
      const complaint = await tx.complaintRecord.findFirst({
        where: { id: input.complaintId, organisationId: input.organisationId, removedAt: null },
      });
      if (!complaint) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      const latest = await tx.complaintResolutionEvidence.findFirst({
        where: { organisationId: input.organisationId, complaintId: input.complaintId },
        orderBy: { revision: 'desc' },
      });
      if (complaint.revision !== input.expectedRecordRevision || (latest?.revision ?? 0) !== input.expectedEvidenceRevision) {
        throw new AppError(409, 'COMPLAINT_RESOLUTION_CONFLICT', 'The complaint or its resolution evidence changed. Reload and review it again.');
      }
      const resolvedAt = input.state === 'RECORDED' && input.resolvedAt ? new Date(input.resolvedAt) : null;
      if (input.state === 'RECORDED' && (complaint.status !== 'CLOSED' || !resolvedAt ||
        !Number.isFinite(resolvedAt.getTime()) || resolvedAt < complaint.receivedDate || resolvedAt.getTime() > Date.now())) {
        throw new AppError(400, 'COMPLAINT_RESOLUTION_INVALID', 'Review a closed complaint and a resolution time between receipt and now.');
      }
      if (input.state === 'WITHDRAWN' && latest?.state !== 'RECORDED') {
        throw new AppError(409, 'COMPLAINT_RESOLUTION_NOT_RECORDED', 'There is no current recorded resolution evidence to withdraw.');
      }
      return tx.complaintResolutionEvidence.create({ data: {
        organisationId: input.organisationId, complaintId: input.complaintId, actorUserId: input.actorUserId,
        revision: input.expectedEvidenceRevision + 1, recordRevision: complaint.revision,
        state: input.state, resolvedAt, evidenceRef: input.evidenceRef, reason: input.reason,
      } });
    });
  }

  async listRegisterAudit(organisationId: string, before?: string) {
    const anchor = before ? await this.prisma.governanceRegisterChangeAudit.findFirst({
      where: { id: before, organisationId }, select: { id: true, occurredAt: true },
    }) : null;
    if (before && !anchor) {
      throw new AppError(404, 'REGISTER_AUDIT_CURSOR_NOT_FOUND', 'Register change cursor not found');
    }
    const rows = await this.prisma.governanceRegisterChangeAudit.findMany({
      where: { organisationId, ...(anchor ? { OR: [
        { occurredAt: { lt: anchor.occurredAt } },
        { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
      ] } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51,
    });
    const items = rows.slice(0, 50);
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1]!.id : null };
  }

  createComplaint(organisationId: string, data: CreateComplaintRecordRequest, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, organisationId);
      const row = await tx.complaintRecord.create({
        data: {
          organisationId,
          receivedDate: new Date(data.receivedDate),
          source: data.source,
          summary: data.summary,
          actionTaken: data.actionTaken,
          outcome: data.outcome,
          status: data.status ?? RegisterStatus.OPEN,
          reviewedByBoard: data.reviewedByBoard ?? false,
          boardMinuteReference: data.boardMinuteReference,
        },
      });
      await this.recordRegisterChange(tx, {
        organisationId, recordKind: 'COMPLAINT', recordId: row.id, actorUserId, action: 'CREATE',
        nextStatus: row.status, changedFields: Object.keys(data),
      });
      return row;
    });
  }

  async updateComplaint(organisationId: string, id: string, data: Partial<CreateComplaintRecordRequest>, expectedUpdatedAt: string | undefined, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, organisationId);
      const existing = await tx.complaintRecord.findFirst({ where: { id, organisationId, removedAt: null } });
      if (!existing) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      assertUnchanged(existing, expectedUpdatedAt, 'REGISTER_UPDATE_CONFLICT');
      const row = await tx.complaintRecord.update({
        where: { id },
        data: {
          receivedDate: data.receivedDate ? new Date(data.receivedDate) : undefined,
          source: data.source,
          summary: data.summary,
          actionTaken: data.actionTaken,
          outcome: data.outcome,
          status: data.status,
          reviewedByBoard: data.reviewedByBoard,
          boardMinuteReference: data.boardMinuteReference,
        },
      });
      await this.recordRegisterChange(tx, {
        organisationId, recordKind: 'COMPLAINT', recordId: id, actorUserId, action: 'UPDATE',
        previousStatus: existing.status, nextStatus: row.status,
        changedFields: Object.entries(data).filter(([, value]) => value !== undefined).map(([field]) => field),
      });
      return row;
    });
  }

  async removeComplaint(organisationId: string, id: string, _actorUserId: string) {
    // This legacy path had no recovery window or retention-policy checks.
    // Do not let new approved policies coexist with a destructive bypass.
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      const row = await tx.complaintRecord.findFirst({ where: { id, organisationId, removedAt: null }, select: { id: true } });
      if (!row) throw new AppError(404, 'COMPLAINT_NOT_FOUND', 'Complaint record not found');
      throw new AppError(409, 'COMPLAINT_RECOVERY_REQUIRED',
        'Permanent complaint deletion is unavailable. Use the recoverable removal controls in the Registers dashboard.');
    });
  }

  listFundraising(organisationId: string) {
    return this.prisma.fundraisingRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  listMemberFundraising(organisationId: string) {
    return this.prisma.fundraisingRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { updatedAt: 'desc' }],
      select: memberFundraisingSelect,
    });
  }

  async getMemberFundraising(organisationId: string, id: string) {
    const row = await this.prisma.fundraisingRecord.findFirst({
      where: { id, organisationId }, select: memberFundraisingSelect,
    });
    if (!row) throw new AppError(404, 'FUNDRAISING_NOT_FOUND', 'Fundraising record not found');
    return row;
  }

  async createFundraising(organisationId: string, data: CreateFundraisingRecordRequest, actorUserId: string) {
    const createData = {
      organisationId,
      name: data.name,
      activityType: data.activityType,
      startDate: toDate(data.startDate),
      endDate: toDate(data.endDate),
      publicFacing: data.publicFacing ?? true,
      thirdPartyFundraiser: data.thirdPartyFundraiser,
      controls: data.controls,
      complaintsReceived: data.complaintsReceived ?? false,
      reviewOutcome: data.reviewOutcome,
      status: data.status ?? RegisterStatus.OPEN,
      boardMinuteReference: data.boardMinuteReference,
    };

    validateDomainCompleteState(validateFundraisingRecordCompleteState, createData);
    return runDomainInvariantWrite(() => this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, organisationId);
      const row = await tx.fundraisingRecord.create({ data: createData });
      await this.recordRegisterChange(tx, {
        organisationId, recordKind: 'FUNDRAISING', recordId: row.id, actorUserId, action: 'CREATE',
        nextStatus: row.status, changedFields: Object.keys(data),
      });
      return row;
    }));
  }

  async updateFundraising(
    organisationId: string,
    id: string,
    data: Partial<CreateFundraisingRecordRequest>,
    expectedUpdatedAt: string | undefined,
    actorUserId: string,
  ) {
    return runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const record = await transaction.fundraisingRecord.findFirst({
          where: { id, organisationId },
        });
        if (!record) {
          throw new AppError(404, 'FUNDRAISING_NOT_FOUND', 'Governance register record not found');
        }
        assertUnchanged(record, expectedUpdatedAt, 'REGISTER_UPDATE_CONFLICT');

        const updateData = {
          name: data.name,
          activityType: data.activityType,
          startDate: data.startDate === undefined ? undefined : toDate(data.startDate),
          endDate: data.endDate === undefined ? undefined : toDate(data.endDate),
          publicFacing: data.publicFacing,
          thirdPartyFundraiser: data.thirdPartyFundraiser,
          controls: data.controls,
          complaintsReceived: data.complaintsReceived,
          reviewOutcome: data.reviewOutcome,
          status: data.status,
          boardMinuteReference: data.boardMinuteReference,
        };
        validateDomainCompleteState(validateFundraisingRecordCompleteState, {
          startDate: updateData.startDate === undefined ? record.startDate : updateData.startDate,
          endDate: updateData.endDate === undefined ? record.endDate : updateData.endDate,
        });

        const row = await transaction.fundraisingRecord.update({
          where: { id },
          data: updateData,
        });
        await this.recordRegisterChange(transaction, {
          organisationId, recordKind: 'FUNDRAISING', recordId: id, actorUserId, action: 'UPDATE',
          previousStatus: record.status, nextStatus: row.status,
          changedFields: Object.entries(data).filter(([, value]) => value !== undefined).map(([field]) => field),
        });
        return row;
      }),
      {
        recordNotFound: {
          code: 'FUNDRAISING_NOT_FOUND',
          message: 'Governance register record not found',
        },
      },
    );
  }

  async removeFundraising(organisationId: string, id: string, actorUserId: string) {
    await runDomainInvariantWrite(
      () => this.prisma.$transaction(async (transaction) => {
        await lockOrganisationForUpdate(transaction, organisationId);
        const record = await transaction.fundraisingRecord.findFirst({
          where: { id, organisationId },
          select: { id: true, status: true },
        });
        if (!record) {
          throw new AppError(404, 'FUNDRAISING_NOT_FOUND', 'Governance register record not found');
        }
        await transaction.fundraisingRecord.delete({ where: { id } });
        await this.recordRegisterChange(transaction, {
          organisationId, recordKind: 'FUNDRAISING', recordId: id, actorUserId, action: 'DELETE',
          previousStatus: record.status, changedFields: [],
        });
      }),
      {
        recordNotFound: {
          code: 'FUNDRAISING_NOT_FOUND',
          message: 'Governance register record not found',
        },
      },
    );
  }

  async getAnnualReportReadiness(
    organisationId: string,
    reportingYear: number,
  ): Promise<AnnualReportReadinessResponse> {
    const record = await this.prisma.annualReportReadiness.findUnique({
      where: { organisationId_reportingYear: { organisationId, reportingYear } },
    });
    if (!record) {
      return {
        id: null,
        organisationId,
        reportingYear,
        activitiesNarrative: null,
        publicBenefitStatement: null,
        beneficiariesSummary: null,
        financialStatementsApproved: false,
        annualReportUploaded: false,
        trusteeDetailsReviewed: false,
        fundraisingReviewed: false,
        complaintsReviewed: false,
        boardApprovalDate: null,
        filingStatus: AnnualReportFilingStatus.NOT_STARTED,
        filedDate: null,
        notes: null,
        updatedAt: null,
      };
    }
    return annualReportReadinessResponse(record);
  }

  async getMemberAnnualReportReadiness(
    organisationId: string,
    reportingYear: number,
  ): Promise<AnnualReportReadinessResponse> {
    const record = await this.prisma.annualReportReadiness.findUnique({
      where: { organisationId_reportingYear: { organisationId, reportingYear } },
      select: memberAnnualReadinessSelect,
    });
    return {
      id: record?.id ?? null,
      organisationId,
      reportingYear,
      activitiesNarrative: null,
      publicBenefitStatement: null,
      beneficiariesSummary: null,
      financialStatementsApproved: record?.financialStatementsApproved ?? false,
      annualReportUploaded: record?.annualReportUploaded ?? false,
      trusteeDetailsReviewed: record?.trusteeDetailsReviewed ?? false,
      fundraisingReviewed: record?.fundraisingReviewed ?? false,
      complaintsReviewed: record?.complaintsReviewed ?? false,
      boardApprovalDate: record?.boardApprovalDate?.toISOString() ?? null,
      filingStatus: record ? record.filingStatus as AnnualReportFilingStatus : AnnualReportFilingStatus.NOT_STARTED,
      filedDate: record?.filedDate?.toISOString() ?? null,
      notes: null,
      updatedAt: record?.updatedAt.toISOString() ?? null,
    };
  }

  async upsertAnnualReportReadiness(
    organisationId: string,
    data: UpsertAnnualReportReadinessRequest,
    actorUserId: string,
  ): Promise<AnnualReportReadinessResponse> {
    return runDomainInvariantWrite(() => this.prisma.$transaction(async (transaction) => {
      await lockOrganisationForUpdate(transaction, organisationId);
      const existing = await transaction.annualReportReadiness.findUnique({
        where: { organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear } },
      });
      validateDomainCompleteState(validateAnnualReportReadinessCompleteState, {
        filingStatus: data.filingStatus ?? existing?.filingStatus ?? AnnualReportFilingStatus.NOT_STARTED,
        filedDate: data.filedDate === undefined ? existing?.filedDate ?? null : toDate(data.filedDate),
      });

      const saved = await transaction.annualReportReadiness.upsert({
        where: { organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear } },
        create: {
          organisationId,
          reportingYear: data.reportingYear,
          activitiesNarrative: data.activitiesNarrative,
          publicBenefitStatement: data.publicBenefitStatement,
          beneficiariesSummary: data.beneficiariesSummary,
          financialStatementsApproved: data.financialStatementsApproved ?? false,
          annualReportUploaded: data.annualReportUploaded ?? false,
          trusteeDetailsReviewed: data.trusteeDetailsReviewed ?? false,
          fundraisingReviewed: data.fundraisingReviewed ?? false,
          complaintsReviewed: data.complaintsReviewed ?? false,
          boardApprovalDate: toDate(data.boardApprovalDate),
          filingStatus: data.filingStatus ?? AnnualReportFilingStatus.NOT_STARTED,
          filedDate: toDate(data.filedDate),
          notes: data.notes,
        },
        update: {
          activitiesNarrative: data.activitiesNarrative,
          publicBenefitStatement: data.publicBenefitStatement,
          beneficiariesSummary: data.beneficiariesSummary,
          financialStatementsApproved: data.financialStatementsApproved,
          annualReportUploaded: data.annualReportUploaded,
          trusteeDetailsReviewed: data.trusteeDetailsReviewed,
          fundraisingReviewed: data.fundraisingReviewed,
          complaintsReviewed: data.complaintsReviewed,
          boardApprovalDate: data.boardApprovalDate === undefined ? undefined : toDate(data.boardApprovalDate),
          filingStatus: data.filingStatus,
          filedDate: data.filedDate === undefined ? undefined : toDate(data.filedDate),
          notes: data.notes,
        },
      });
      await this.recordRegisterChange(transaction, {
        organisationId, recordKind: 'ANNUAL_REPORT', recordId: saved.id, actorUserId,
        action: existing ? 'UPDATE' : 'CREATE',
        previousStatus: existing?.filingStatus ?? null, nextStatus: saved.filingStatus,
        changedFields: Object.entries(data).filter(([field, value]) => field !== 'reportingYear' && value !== undefined).map(([field]) => field),
      });
      return annualReportReadinessResponse(saved);
    }));
  }

  async getFinancialControlReview(
    organisationId: string,
    reportingYear: number,
  ): Promise<FinancialControlReviewResponse> {
    const record = await this.prisma.financialControlReview.findUnique({
      where: { organisationId_reportingYear: { organisationId, reportingYear } },
    });
    if (!record) {
      return {
        id: null,
        organisationId,
        reportingYear,
        bankReconciliationsReviewed: false,
        dualAuthorisation: false,
        budgetApproved: false,
        managementAccountsReviewed: false,
        reservesReviewed: false,
        restrictedFundsReviewed: false,
        assetsInsuranceReviewed: false,
        payrollControlsReviewed: false,
        fundraisingControlsReviewed: false,
        reviewedBy: null,
        reviewDate: null,
        minuteReference: null,
        actions: null,
        updatedAt: null,
      };
    }
    return {
      id: record.id,
      organisationId: record.organisationId,
      reportingYear: record.reportingYear,
      bankReconciliationsReviewed: record.bankReconciliationsReviewed,
      dualAuthorisation: record.dualAuthorisation,
      budgetApproved: record.budgetApproved,
      managementAccountsReviewed: record.managementAccountsReviewed,
      reservesReviewed: record.reservesReviewed,
      restrictedFundsReviewed: record.restrictedFundsReviewed,
      assetsInsuranceReviewed: record.assetsInsuranceReviewed,
      payrollControlsReviewed: record.payrollControlsReviewed,
      fundraisingControlsReviewed: record.fundraisingControlsReviewed,
      reviewedBy: record.reviewedBy,
      reviewDate: record.reviewDate?.toISOString() ?? null,
      minuteReference: record.minuteReference,
      actions: record.actions,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getMemberFinancialControlReview(
    organisationId: string,
    reportingYear: number,
  ): Promise<FinancialControlReviewResponse> {
    const record = await this.prisma.financialControlReview.findUnique({
      where: { organisationId_reportingYear: { organisationId, reportingYear } },
      select: memberFinancialReviewSelect,
    });
    return {
      id: record?.id ?? null,
      organisationId,
      reportingYear,
      bankReconciliationsReviewed: record?.bankReconciliationsReviewed ?? false,
      dualAuthorisation: record?.dualAuthorisation ?? false,
      budgetApproved: record?.budgetApproved ?? false,
      managementAccountsReviewed: record?.managementAccountsReviewed ?? false,
      reservesReviewed: record?.reservesReviewed ?? false,
      restrictedFundsReviewed: record?.restrictedFundsReviewed ?? false,
      assetsInsuranceReviewed: record?.assetsInsuranceReviewed ?? false,
      payrollControlsReviewed: record?.payrollControlsReviewed ?? false,
      fundraisingControlsReviewed: record?.fundraisingControlsReviewed ?? false,
      reviewedBy: null,
      reviewDate: record?.reviewDate?.toISOString() ?? null,
      minuteReference: null,
      actions: null,
      updatedAt: record?.updatedAt.toISOString() ?? null,
    };
  }

  async upsertFinancialControlReview(
    organisationId: string,
    data: UpsertFinancialControlReviewRequest,
    actorUserId: string,
  ): Promise<FinancialControlReviewResponse> {
    const saved = await this.prisma.$transaction(async (tx) => {
      await lockOrganisationForUpdate(tx, organisationId);
      const existing = await tx.financialControlReview.findUnique({
        where: { organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear } },
      });
      const row = await tx.financialControlReview.upsert({
      where: { organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear } },
      create: {
        organisationId,
        reportingYear: data.reportingYear,
        bankReconciliationsReviewed: data.bankReconciliationsReviewed ?? false,
        dualAuthorisation: data.dualAuthorisation ?? false,
        budgetApproved: data.budgetApproved ?? false,
        managementAccountsReviewed: data.managementAccountsReviewed ?? false,
        reservesReviewed: data.reservesReviewed ?? false,
        restrictedFundsReviewed: data.restrictedFundsReviewed ?? false,
        assetsInsuranceReviewed: data.assetsInsuranceReviewed ?? false,
        payrollControlsReviewed: data.payrollControlsReviewed ?? false,
        fundraisingControlsReviewed: data.fundraisingControlsReviewed ?? false,
        reviewedBy: data.reviewedBy,
        reviewDate: toDate(data.reviewDate),
        minuteReference: data.minuteReference,
        actions: data.actions,
      },
      update: {
        bankReconciliationsReviewed: data.bankReconciliationsReviewed,
        dualAuthorisation: data.dualAuthorisation,
        budgetApproved: data.budgetApproved,
        managementAccountsReviewed: data.managementAccountsReviewed,
        reservesReviewed: data.reservesReviewed,
        restrictedFundsReviewed: data.restrictedFundsReviewed,
        assetsInsuranceReviewed: data.assetsInsuranceReviewed,
        payrollControlsReviewed: data.payrollControlsReviewed,
        fundraisingControlsReviewed: data.fundraisingControlsReviewed,
        reviewedBy: data.reviewedBy,
        reviewDate: data.reviewDate === undefined ? undefined : toDate(data.reviewDate),
        minuteReference: data.minuteReference,
        actions: data.actions,
      },
      });
      await this.recordRegisterChange(tx, {
        organisationId, recordKind: 'FINANCIAL_CONTROL', recordId: row.id, actorUserId,
        action: existing ? 'UPDATE' : 'CREATE',
        changedFields: Object.entries(data).filter(([field, value]) => field !== 'reportingYear' && value !== undefined).map(([field]) => field),
      });
      return row;
    });
    return this.getFinancialControlReview(saved.organisationId, saved.reportingYear);
  }

  private async ensureBoardMember(
    client: PrismaClient | Prisma.TransactionClient,
    organisationId: string,
    boardMemberId?: string | null,
  ) {
    if (!boardMemberId) {
      return;
    }

    const boardMember = await client.boardMember.findFirst({
      where: { id: boardMemberId, organisationId },
      select: { id: true },
    });

    if (!boardMember) {
      throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
    }
  }
}

function annualReadinessPercent(record: AnnualReportReadinessResponse): number {
  const checks = [
    Boolean(record.activitiesNarrative),
    Boolean(record.publicBenefitStatement),
    Boolean(record.beneficiariesSummary),
    record.financialStatementsApproved,
    record.annualReportUploaded,
    record.trusteeDetailsReviewed,
    record.fundraisingReviewed,
    record.complaintsReviewed,
    Boolean(record.boardApprovalDate),
    record.filingStatus === AnnualReportFilingStatus.FILED,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function financialControlsPercent(record: FinancialControlReviewResponse): number {
  const checks = [
    record.bankReconciliationsReviewed,
    record.dualAuthorisation,
    record.budgetApproved,
    record.managementAccountsReviewed,
    record.reservesReviewed,
    record.restrictedFundsReviewed,
    record.assetsInsuranceReviewed,
    record.payrollControlsReviewed,
    record.fundraisingControlsReviewed,
    Boolean(record.reviewDate),
    Boolean(record.minuteReference),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
