import {
  AnnualReportFilingStatus,
  ConflictStatus,
  RegisterStatus,
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
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const toDate = (value?: string | null) => (value ? new Date(value) : null);

export class GovernanceRegisterService {
  constructor(private prisma: PrismaClient) {}

  async summary(organisationId: string, reportingYear: number): Promise<GovernanceRegistersSummary> {
    const [openConflicts, openRisks, openComplaints, activeFundraisingActivities, annual, financial] = await Promise.all([
      this.prisma.conflictRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
      this.prisma.riskRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
      this.prisma.complaintRecord.count({ where: { organisationId, status: { not: 'CLOSED' } } }),
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

  listConflicts(organisationId: string) {
    return this.prisma.conflictRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { dateDeclared: 'desc' }],
    });
  }

  async createConflict(organisationId: string, data: CreateConflictRecordRequest) {
    await this.ensureBoardMember(organisationId, data.boardMemberId);

    return this.prisma.conflictRecord.create({
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
  }

  async updateConflict(organisationId: string, id: string, data: Partial<CreateConflictRecordRequest>) {
    await this.ensureRecord('conflictRecord', organisationId, id, 'CONFLICT_NOT_FOUND');
    if (data.boardMemberId !== undefined) {
      await this.ensureBoardMember(organisationId, data.boardMemberId);
    }

    return this.prisma.conflictRecord.update({
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
  }

  async removeConflict(organisationId: string, id: string) {
    await this.ensureRecord('conflictRecord', organisationId, id, 'CONFLICT_NOT_FOUND');
    await this.prisma.conflictRecord.delete({ where: { id } });
  }

  listRisks(organisationId: string) {
    return this.prisma.riskRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { reviewDate: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  createRisk(organisationId: string, data: CreateRiskRecordRequest) {
    return this.prisma.riskRecord.create({
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
  }

  async updateRisk(organisationId: string, id: string, data: Partial<CreateRiskRecordRequest>) {
    await this.ensureRecord('riskRecord', organisationId, id, 'RISK_NOT_FOUND');
    return this.prisma.riskRecord.update({
      where: { id },
      data: {
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
  }

  async removeRisk(organisationId: string, id: string) {
    await this.ensureRecord('riskRecord', organisationId, id, 'RISK_NOT_FOUND');
    await this.prisma.riskRecord.delete({ where: { id } });
  }

  listComplaints(organisationId: string) {
    return this.prisma.complaintRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { receivedDate: 'desc' }],
    });
  }

  createComplaint(organisationId: string, data: CreateComplaintRecordRequest) {
    return this.prisma.complaintRecord.create({
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
  }

  async updateComplaint(organisationId: string, id: string, data: Partial<CreateComplaintRecordRequest>) {
    await this.ensureRecord('complaintRecord', organisationId, id, 'COMPLAINT_NOT_FOUND');
    return this.prisma.complaintRecord.update({
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
  }

  async removeComplaint(organisationId: string, id: string) {
    await this.ensureRecord('complaintRecord', organisationId, id, 'COMPLAINT_NOT_FOUND');
    await this.prisma.complaintRecord.delete({ where: { id } });
  }

  listFundraising(organisationId: string) {
    return this.prisma.fundraisingRecord.findMany({
      where: { organisationId },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  createFundraising(organisationId: string, data: CreateFundraisingRecordRequest) {
    return this.prisma.fundraisingRecord.create({
      data: {
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
      },
    });
  }

  async updateFundraising(organisationId: string, id: string, data: Partial<CreateFundraisingRecordRequest>) {
    await this.ensureRecord('fundraisingRecord', organisationId, id, 'FUNDRAISING_NOT_FOUND');
    return this.prisma.fundraisingRecord.update({
      where: { id },
      data: {
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
      },
    });
  }

  async removeFundraising(organisationId: string, id: string) {
    await this.ensureRecord('fundraisingRecord', organisationId, id, 'FUNDRAISING_NOT_FOUND');
    await this.prisma.fundraisingRecord.delete({ where: { id } });
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

  async upsertAnnualReportReadiness(
    organisationId: string,
    data: UpsertAnnualReportReadinessRequest,
  ): Promise<AnnualReportReadinessResponse> {
    const saved = await this.prisma.annualReportReadiness.upsert({
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
    return this.getAnnualReportReadiness(saved.organisationId, saved.reportingYear);
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

  async upsertFinancialControlReview(
    organisationId: string,
    data: UpsertFinancialControlReviewRequest,
  ): Promise<FinancialControlReviewResponse> {
    const saved = await this.prisma.financialControlReview.upsert({
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
    return this.getFinancialControlReview(saved.organisationId, saved.reportingYear);
  }

  private async ensureRecord(
    model: 'conflictRecord' | 'riskRecord' | 'complaintRecord' | 'fundraisingRecord',
    organisationId: string,
    id: string,
    code: string,
  ) {
    const record =
      model === 'conflictRecord'
        ? await this.prisma.conflictRecord.findFirst({ where: { id, organisationId } })
        : model === 'riskRecord'
          ? await this.prisma.riskRecord.findFirst({ where: { id, organisationId } })
          : model === 'complaintRecord'
            ? await this.prisma.complaintRecord.findFirst({ where: { id, organisationId } })
            : await this.prisma.fundraisingRecord.findFirst({ where: { id, organisationId } });
    if (!record) {
      throw new AppError(404, code, 'Governance register record not found');
    }
  }

  private async ensureBoardMember(organisationId: string, boardMemberId?: string | null) {
    if (!boardMemberId) {
      return;
    }

    const boardMember = await this.prisma.boardMember.findFirst({
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
