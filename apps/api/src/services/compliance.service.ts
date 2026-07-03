import type { PrismaClient } from '@prisma/client';
import {
  CONDITIONAL_OBLIGATION_REVIEW_RULES,
  ComplianceSignoffStatus,
  IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
  SubscriptionPlan,
  conditionalObligationProfileSchema,
  getMatrixEntriesForStandard,
  type ComplianceApprovalConditionalReviewItem,
  type ComplianceApprovalMatrixReviewItem,
  type ComplianceApprovalReadinessResponse,
  type ConditionalObligationProfile,
  type ComplianceSignoffResponse,
  type ComplianceSummary,
  type PrincipleComplianceSummary,
  type UpsertComplianceRecordRequest,
  type UpsertComplianceSignoffRequest,
} from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';

type OrganisationComplianceScope = {
  complexity: string;
  plan: string;
  conditionalObligationProfile: ConditionalObligationProfile | null;
};

type MissingComplianceExplanationStatus = 'NOT_APPLICABLE' | 'EXPLAIN';

export type ComplianceApprovalReadiness = ComplianceApprovalReadinessResponse;

type MissingComplianceEvidenceStatus = 'COMPLIANT' | 'WORKING_TOWARDS';

function includesAdditionalStandards(scope: OrganisationComplianceScope): boolean {
  return scope.complexity === 'COMPLEX' && scope.plan === SubscriptionPlan.COMPLETE;
}

function standardsWhere(scope: OrganisationComplianceScope): { isCore: true } | undefined {
  return includesAdditionalStandards(scope) ? undefined : { isCore: true };
}

function parseConditionalObligationProfile(value: unknown): ConditionalObligationProfile | null {
  const parsed = conditionalObligationProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function trimValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function matrixReviewItemsForStandard(standardCode: string): ComplianceApprovalMatrixReviewItem[] {
  return getMatrixEntriesForStandard(standardCode).map((entry) => ({
    standardCode,
    matrixEntryId: entry.id,
    commencementStatus: entry.commencementStatus,
    boardApproval: entry.boardApproval,
    professionalReview: entry.professionalReview,
    sourceRefs: entry.sourceRefs,
    applicabilityNote: entry.applicabilityNote,
    evidenceRequired: entry.evidenceRequired,
  }));
}

function conditionalReviewItemsForProfile(
  profile: ConditionalObligationProfile | null,
): ComplianceApprovalConditionalReviewItem[] {
  if (!profile) {
    return [];
  }

  return CONDITIONAL_OBLIGATION_REVIEW_RULES
    .filter((rule) => profile[rule.profileKey])
    .map((rule) => {
      const entries = rule.standardCodes.flatMap((code) => getMatrixEntriesForStandard(code));
      return {
        profileKey: rule.profileKey,
        label: rule.label,
        recommendedAction: rule.recommendedAction,
        standardCodes: [...new Set(rule.standardCodes)].sort(),
        commencementStatuses: [...new Set(entries.map((entry) => entry.commencementStatus))].sort(),
        professionalReview: [...new Set(entries.flatMap((entry) => entry.professionalReview))].sort(),
        sourceRefs: [
          ...new Map(
            entries.flatMap((entry) => entry.sourceRefs).map((sourceRef) => [sourceRef.url, sourceRef] as const),
          ).values(),
        ].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name)),
        applicabilityNotes: [...new Set(entries.map((entry) => entry.applicabilityNote))],
      };
    });
}

export class ComplianceService {
  constructor(private prisma: PrismaClient) {}

  private async getOrganisationComplianceScope(organisationId: string): Promise<OrganisationComplianceScope> {
    const [organisation, subscription] = await Promise.all([
      this.prisma.organisation.findUniqueOrThrow({
        where: { id: organisationId },
        select: { complexity: true, conditionalObligationProfile: true },
      }),
      this.prisma.subscription.findUnique({
        where: { organisationId },
        select: { plan: true },
      }),
    ]);

    if (!subscription) {
      throw new AppError(403, 'NO_SUBSCRIPTION', 'No active subscription. Please subscribe to continue.');
    }

    return {
      complexity: organisation.complexity,
      plan: subscription.plan,
      conditionalObligationProfile: parseConditionalObligationProfile(organisation.conditionalObligationProfile),
    };
  }

  private async ensureStandardIncludedInPlan(organisationId: string, standardId: string): Promise<void> {
    const [scope, standard] = await Promise.all([
      this.getOrganisationComplianceScope(organisationId),
      this.prisma.governanceStandard.findUnique({
        where: { id: standardId },
        select: { id: true, isCore: true },
      }),
    ]);

    if (!standard) {
      throw new AppError(404, 'STANDARD_NOT_FOUND', 'Governance standard not found');
    }

    if (!standard.isCore && !includesAdditionalStandards(scope)) {
      throw new AppError(
        403,
        'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
        'This governance standard requires the Complete plan and a complex organisation profile.',
      );
    }
  }

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

  async getPrinciplesForOrganisation(organisationId: string) {
    const scope = await this.getOrganisationComplianceScope(organisationId);

    return this.prisma.governancePrinciple.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        standards: {
          orderBy: { sortOrder: 'asc' },
          where: standardsWhere(scope),
        },
      },
    });
  }

  async getPrincipleForOrganisation(organisationId: string, principleId: string) {
    const scope = await this.getOrganisationComplianceScope(organisationId);

    return this.prisma.governancePrinciple.findUnique({
      where: { id: principleId },
      include: {
        standards: {
          orderBy: { sortOrder: 'asc' },
          where: standardsWhere(scope),
        },
      },
    });
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
    const scope = await this.getOrganisationComplianceScope(organisationId);
    const records = await this.prisma.complianceRecord.findMany({
      where: {
        organisationId,
        reportingYear: year,
        standard: standardsWhere(scope),
      },
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

  async getApprovalReadiness(organisationId: string, reportingYear: number): Promise<ComplianceApprovalReadiness> {
    const scope = await this.getOrganisationComplianceScope(organisationId);
    const [standards, records] = await Promise.all([
      this.prisma.governanceStandard.findMany({
        where: standardsWhere(scope),
        select: { id: true, code: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.complianceRecord.findMany({
        where: {
          organisationId,
          reportingYear,
          standard: standardsWhere(scope),
        },
        select: {
          standardId: true,
          status: true,
          actionTaken: true,
          evidence: true,
          explanationIfNA: true,
        },
      }),
    ]);

    const recordMap = new Map(records.map((record) => [record.standardId, record]));
    const missingRecords: ComplianceApprovalReadiness['missingRecords'] = [];
    const missingEvidence: ComplianceApprovalReadiness['missingEvidence'] = [];
    const missingExplanations: ComplianceApprovalReadiness['missingExplanations'] = [];
    const matrixReviewItems: ComplianceApprovalReadiness['matrixReviewItems'] = [];

    for (const standard of standards) {
      const record = recordMap.get(standard.id);
      matrixReviewItems.push(...matrixReviewItemsForStandard(standard.code));

      if (!record || record.status === 'NOT_STARTED') {
        missingRecords.push({
          standardId: standard.id,
          standardCode: standard.code,
          status: 'NOT_STARTED',
        });
        continue;
      }

      if (
        (record.status === 'NOT_APPLICABLE' || record.status === 'EXPLAIN') &&
        !trimValue(record.explanationIfNA)
      ) {
        missingExplanations.push({
          standardId: standard.id,
          standardCode: standard.code,
          status: record.status as MissingComplianceExplanationStatus,
        });
      }

      if (record.status === 'COMPLIANT' || record.status === 'WORKING_TOWARDS') {
        const missingActionTaken = !trimValue(record.actionTaken);
        const evidenceMissing = !trimValue(record.evidence);
        if (missingActionTaken || evidenceMissing) {
          missingEvidence.push({
            standardId: standard.id,
            standardCode: standard.code,
            status: record.status as MissingComplianceEvidenceStatus,
            missingActionTaken,
            missingEvidence: evidenceMissing,
          });
        }
      }
    }

    const profileIssues: ComplianceApprovalReadiness['profileIssues'] = scope.conditionalObligationProfile
      ? []
      : [
          {
            code: 'CONDITIONAL_OBLIGATION_PROFILE_MISSING',
            message: 'Capture the organisation conditional obligation profile before approving the annual Compliance Record.',
          },
        ];

    return {
      ready:
        missingRecords.length === 0 &&
        missingEvidence.length === 0 &&
        missingExplanations.length === 0 &&
        profileIssues.length === 0,
      missingRecords,
      missingEvidence,
      missingExplanations,
      profileIssues,
      conditionalReviewItems: conditionalReviewItemsForProfile(scope.conditionalObligationProfile),
      matrixReviewItems,
      matrixLastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
    };
  }

  async getRecord(organisationId: string, standardId: string, year: number) {
    await this.ensureStandardIncludedInPlan(organisationId, standardId);

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
    await this.ensureStandardIncludedInPlan(organisationId, standardId);

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
    if (isApproved) {
      const readiness = await this.getApprovalReadiness(organisationId, data.reportingYear);
      if (!readiness.ready) {
        throw new AppError(
          400,
          'COMPLIANCE_APPROVAL_INCOMPLETE',
          'Resolve Compliance Record readiness blockers before board approval.',
        );
      }
    }

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
    const scope = await this.getOrganisationComplianceScope(organisationId);

    const standards = await this.prisma.governanceStandard.findMany({
      where: standardsWhere(scope),
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
