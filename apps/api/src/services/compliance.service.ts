import type { PrismaClient } from '@prisma/client';
import {
  ComplianceSignoffStatus,
  type ComplianceSignoffResponse,
  type ComplianceSummary,
  type PrincipleComplianceSummary,
  type UpsertComplianceRecordRequest,
  type UpsertComplianceSignoffRequest,
} from '@charitypilot/shared';

export class ComplianceService {
  constructor(private prisma: PrismaClient) {}

  async getPrinciples(organisationComplexity: string) {
    const principles = await this.prisma.governancePrinciple.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        standards: {
          orderBy: { sortOrder: 'asc' },
          where: organisationComplexity === 'SIMPLE' ? { isCore: true } : undefined,
        },
      },
    });

    return principles;
  }

  async getAllPrinciplesWithStandards() {
    return this.prisma.governancePrinciple.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        standards: { orderBy: { sortOrder: 'asc' } },
      },
    });
  }

  async getRecords(organisationId: string, year: number) {
    const records = await this.prisma.complianceRecord.findMany({
      where: { organisationId, reportingYear: year },
      include: {
        standard: {
          include: { principle: true },
        },
        updatedBy: { select: { id: true, name: true } },
      },
      orderBy: { standard: { sortOrder: 'asc' } },
    });

    return records;
  }

  async getRecord(organisationId: string, standardId: string, year: number) {
    return this.prisma.complianceRecord.findUnique({
      where: {
        organisationId_standardId_reportingYear: {
          organisationId,
          standardId,
          reportingYear: year,
        },
      },
      include: {
        standard: true,
        updatedBy: { select: { id: true, name: true } },
      },
    });
  }

  async upsertRecord(
    organisationId: string,
    standardId: string,
    userId: string,
    data: UpsertComplianceRecordRequest,
  ) {
    const record = await this.prisma.complianceRecord.upsert({
      where: {
        organisationId_standardId_reportingYear: {
          organisationId,
          standardId,
          reportingYear: data.reportingYear,
        },
      },
      create: {
        organisationId,
        standardId,
        reportingYear: data.reportingYear,
        status: data.status ?? 'NOT_STARTED',
        actionTaken: data.actionTaken,
        evidence: data.evidence,
        notes: data.notes,
        explanationIfNA: data.explanationIfNA,
        updatedById: userId,
      },
      update: {
        status: data.status,
        actionTaken: data.actionTaken,
        evidence: data.evidence,
        notes: data.notes,
        explanationIfNA: data.explanationIfNA,
        updatedById: userId,
      },
      include: {
        standard: true,
        updatedBy: { select: { id: true, name: true } },
      },
    });

    return record;
  }

  async getSignoff(organisationId: string, reportingYear: number): Promise<ComplianceSignoffResponse> {
    const signoff = await this.prisma.complianceSignoff.findUnique({
      where: {
        organisationId_reportingYear: {
          organisationId,
          reportingYear,
        },
      },
    });

    if (!signoff) {
      return {
        id: null,
        organisationId,
        reportingYear,
        status: ComplianceSignoffStatus.DRAFT,
        boardMeetingDate: null,
        minuteReference: null,
        approvedByName: null,
        approvedByRole: null,
        approvalNotes: null,
        approvedAt: null,
        updatedById: null,
        updatedAt: null,
      };
    }

    return {
      id: signoff.id,
      organisationId: signoff.organisationId,
      reportingYear: signoff.reportingYear,
      status: signoff.status as ComplianceSignoffStatus,
      boardMeetingDate: signoff.boardMeetingDate?.toISOString() ?? null,
      minuteReference: signoff.minuteReference,
      approvedByName: signoff.approvedByName,
      approvedByRole: signoff.approvedByRole,
      approvalNotes: signoff.approvalNotes,
      approvedAt: signoff.approvedAt?.toISOString() ?? null,
      updatedById: signoff.updatedById,
      updatedAt: signoff.updatedAt.toISOString(),
    };
  }

  async upsertSignoff(
    organisationId: string,
    userId: string,
    data: UpsertComplianceSignoffRequest,
  ): Promise<ComplianceSignoffResponse> {
    const isApproved = data.status === 'APPROVED';
    const saved = await this.prisma.complianceSignoff.upsert({
      where: {
        organisationId_reportingYear: {
          organisationId,
          reportingYear: data.reportingYear,
        },
      },
      create: {
        organisationId,
        reportingYear: data.reportingYear,
        status: data.status,
        boardMeetingDate: data.boardMeetingDate ? new Date(data.boardMeetingDate) : null,
        minuteReference: data.minuteReference,
        approvedByName: data.approvedByName,
        approvedByRole: data.approvedByRole,
        approvalNotes: data.approvalNotes,
        approvedAt: isApproved ? new Date() : null,
        updatedById: userId,
      },
      update: {
        status: data.status,
        boardMeetingDate: data.boardMeetingDate ? new Date(data.boardMeetingDate) : null,
        minuteReference: data.minuteReference,
        approvedByName: data.approvedByName,
        approvedByRole: data.approvedByRole,
        approvalNotes: data.approvalNotes,
        approvedAt: isApproved ? new Date() : null,
        updatedById: userId,
      },
    });

    return {
      id: saved.id,
      organisationId: saved.organisationId,
      reportingYear: saved.reportingYear,
      status: saved.status as ComplianceSignoffStatus,
      boardMeetingDate: saved.boardMeetingDate?.toISOString() ?? null,
      minuteReference: saved.minuteReference,
      approvedByName: saved.approvedByName,
      approvedByRole: saved.approvedByRole,
      approvalNotes: saved.approvalNotes,
      approvedAt: saved.approvedAt?.toISOString() ?? null,
      updatedById: saved.updatedById,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async getSummary(organisationId: string, year: number): Promise<ComplianceSummary> {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });

    const standards = await this.prisma.governanceStandard.findMany({
      where: org.complexity === 'SIMPLE' ? { isCore: true } : undefined,
      include: { principle: true },
    });

    const records = await this.prisma.complianceRecord.findMany({
      where: { organisationId, reportingYear: year },
    });

    const recordMap = new Map(records.map((r) => [r.standardId, r]));

    let compliant = 0;
    let workingTowards = 0;
    let notStarted = 0;
    let notApplicable = 0;
    let explain = 0;

    const principleMap = new Map<string, PrincipleComplianceSummary>();

    for (const standard of standards) {
      const record = recordMap.get(standard.id);
      const status = record?.status ?? 'NOT_STARTED';

      switch (status) {
        case 'COMPLIANT':
          compliant++;
          break;
        case 'WORKING_TOWARDS':
          workingTowards++;
          break;
        case 'NOT_STARTED':
          notStarted++;
          break;
        case 'NOT_APPLICABLE':
          notApplicable++;
          break;
        case 'EXPLAIN':
          explain++;
          break;
      }

      if (!principleMap.has(standard.principleId)) {
        principleMap.set(standard.principleId, {
          principleId: standard.principleId,
          principleNumber: standard.principle.number,
          principleTitle: standard.principle.title,
          totalApplicable: 0,
          compliant: 0,
          percentComplete: 0,
        });
      }

      const ps = principleMap.get(standard.principleId)!;
      if (status !== 'NOT_APPLICABLE') {
        ps.totalApplicable++;
        if (status === 'COMPLIANT') {
          ps.compliant++;
        }
      }
    }

    const totalApplicable = standards.length - notApplicable;

    for (const ps of principleMap.values()) {
      ps.percentComplete = ps.totalApplicable > 0 ? Math.round((ps.compliant / ps.totalApplicable) * 100) : 100;
    }

    return {
      reportingYear: year,
      totalApplicable,
      compliant,
      workingTowards,
      notStarted,
      notApplicable,
      explain,
      percentComplete: totalApplicable > 0 ? Math.round((compliant / totalApplicable) * 100) : 100,
      byPrinciple: Array.from(principleMap.values()).sort((a, b) => a.principleNumber - b.principleNumber),
    };
  }
}
