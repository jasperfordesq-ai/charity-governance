import { Prisma, type PrismaClient } from '@prisma/client';
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
  type ComplianceApprovalSnapshotPayload,
  type ComplianceApprovalSnapshotSummary,
  type ConditionalObligationProfile,
  type ComplianceEvidenceSnapshotPayload,
  type ComplianceSignoffResponse,
  type ComplianceSummary,
  type PrincipleComplianceSummary,
  type UpsertComplianceRecordRequest,
  type UpsertComplianceSignoffRequest,
} from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { hashComplianceSnapshot } from './compliance-snapshot.js';

type OrganisationComplianceScope = {
  id: string;
  name: string;
  rcnNumber: string | null;
  complexity: 'SIMPLE' | 'COMPLEX';
  plan: 'ESSENTIALS' | 'COMPLETE';
  conditionalObligationProfile: ConditionalObligationProfile | null;
};

type ComplianceTransaction = Prisma.TransactionClient;
type ComplianceSignoffWithSnapshot = Prisma.ComplianceSignoffGetPayload<{
  include: { currentApprovalSnapshot: true };
}>;
type ComplianceApprovalSnapshotRow = Prisma.ComplianceApprovalSnapshotGetPayload<{}>;

type ApprovalReadinessWithoutHash = Omit<ComplianceApprovalReadinessResponse, 'evidenceHash'>;

type ApprovalEvidenceState = {
  readiness: ApprovalReadinessWithoutHash;
  evidence: ComplianceEvidenceSnapshotPayload;
  evidenceHash: string;
};

type RecordState = {
  revision: number;
  status: string;
  actionTaken: string | null;
  evidence: string | null;
  notes: string | null;
  explanationIfNA: string | null;
  updatedById: string | null;
  updatedAt: string;
};

const SERIALIZABLE_RETRY_LIMIT = 3;

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

function prismaErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

const RETRYABLE_COMPLIANCE_UNIQUE_TARGETS = new Set([
  ['organisationId', 'standardId', 'reportingYear'].sort().join(','),
  ['organisationId', 'reportingYear'].sort().join(','),
  ['organisationId', 'reportingYear', 'approvalSequence'].sort().join(','),
  ['complianceRecordId', 'toRevision'].sort().join(','),
  ['signoffId', 'toRevision'].sort().join(','),
  ['currentApprovalSnapshotId'].join(','),
]);

function isRetryableComplianceTransactionError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (code === 'P2034') return true;
  if (code !== 'P2002' || !error || typeof error !== 'object') return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (!Array.isArray(target) || !target.every((field) => typeof field === 'string')) {
    return false;
  }
  return RETRYABLE_COMPLIANCE_UNIQUE_TARGETS.has([...target].sort().join(','));
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toPlainSnapshotJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordState(record: {
  revision: number;
  status: string;
  actionTaken: string | null;
  evidence: string | null;
  notes: string | null;
  explanationIfNA: string | null;
  updatedById: string | null;
  updatedAt: Date;
}): RecordState {
  return {
    revision: record.revision,
    status: record.status,
    actionTaken: record.actionTaken,
    evidence: record.evidence,
    notes: record.notes,
    explanationIfNA: record.explanationIfNA,
    updatedById: record.updatedById,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function sameRecordContent(
  current: Pick<RecordState, 'status' | 'actionTaken' | 'evidence' | 'notes' | 'explanationIfNA'>,
  desired: Pick<RecordState, 'status' | 'actionTaken' | 'evidence' | 'notes' | 'explanationIfNA'>,
): boolean {
  return current.status === desired.status
    && current.actionTaken === desired.actionTaken
    && current.evidence === desired.evidence
    && current.notes === desired.notes
    && current.explanationIfNA === desired.explanationIfNA;
}

function approvalSnapshotSummary(snapshot: {
  id: string;
  approvalSequence: number;
  evidenceHash: string;
  snapshotHash: string;
  approvedAt: Date;
} | null): ComplianceApprovalSnapshotSummary | null {
  return snapshot
    ? {
        id: snapshot.id,
        approvalSequence: snapshot.approvalSequence,
        evidenceHash: snapshot.evidenceHash,
        snapshotHash: snapshot.snapshotHash,
        approvedAt: snapshot.approvedAt.toISOString(),
      }
    : null;
}

type SignoffAuditSource = {
  id: string;
  organisationId: string;
  reportingYear: number;
  status: string;
  boardMeetingDate: Date | null;
  minuteReference: string | null;
  approvedByName: string | null;
  approvedByRole: string | null;
  approvalNotes: string | null;
  approvedAt: Date | null;
  revision: number;
  approvalSequence: number;
  currentApprovalSnapshotId: string | null;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
  invalidatedById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function signoffAuditState(signoff: SignoffAuditSource) {
  return {
    id: signoff.id,
    organisationId: signoff.organisationId,
    reportingYear: signoff.reportingYear,
    status: signoff.status,
    boardMeetingDate: signoff.boardMeetingDate?.toISOString() ?? null,
    minuteReference: signoff.minuteReference,
    approvedByName: signoff.approvedByName,
    approvedByRole: signoff.approvedByRole,
    approvalNotes: signoff.approvalNotes,
    approvedAt: signoff.approvedAt?.toISOString() ?? null,
    revision: signoff.revision,
    approvalSequence: signoff.approvalSequence,
    currentApprovalSnapshotId: signoff.currentApprovalSnapshotId,
    invalidatedAt: signoff.invalidatedAt?.toISOString() ?? null,
    invalidationReason: signoff.invalidationReason,
    invalidatedById: signoff.invalidatedById,
    updatedById: signoff.updatedById,
    createdAt: signoff.createdAt.toISOString(),
    updatedAt: signoff.updatedAt.toISOString(),
  };
}

function formatSignoffResponse(
  organisationId: string,
  reportingYear: number,
  signoff: ComplianceSignoffWithSnapshot | null,
  latestApproval: ComplianceApprovalSnapshotRow | null,
  currentEvidenceHash: string | null,
): ComplianceSignoffResponse {
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
      revision: 0,
      approvalSequence: 0,
      approvalCurrent: false,
      currentApprovalSnapshotId: null,
      currentApproval: null,
      latestApproval: approvalSnapshotSummary(latestApproval),
      invalidatedAt: null,
      invalidationReason: null,
      invalidatedById: null,
      updatedById: null,
      updatedAt: null,
    };
  }

  const currentApproval = approvalSnapshotSummary(signoff.currentApprovalSnapshot);
  const approvalCurrent = signoff.status === 'APPROVED'
    && signoff.currentApprovalSnapshotId !== null
    && currentApproval !== null
    && currentEvidenceHash !== null
    && signoff.currentApprovalSnapshot?.evidenceHash === currentEvidenceHash;
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
    revision: signoff.revision,
    approvalSequence: signoff.approvalSequence,
    approvalCurrent,
    currentApprovalSnapshotId: signoff.currentApprovalSnapshotId,
    currentApproval,
    latestApproval: approvalSnapshotSummary(latestApproval),
    invalidatedAt: signoff.invalidatedAt?.toISOString() ?? null,
    invalidationReason: signoff.invalidationReason,
    invalidatedById: signoff.invalidatedById,
    updatedById: signoff.updatedById,
    updatedAt: signoff.updatedAt.toISOString(),
  };
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

  private async withSerializableOrganisationLock<T>(
    organisationId: string,
    operation: (tx: ComplianceTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "Organisation"
            WHERE "id" = ${organisationId}
            FOR UPDATE
          `;
          return operation(tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isRetryableComplianceTransactionError(error)) {
          if (attempt < SERIALIZABLE_RETRY_LIMIT - 1) {
            continue;
          }
          throw new AppError(
            409,
            'COMPLIANCE_WRITE_CONFLICT',
            'Compliance data changed concurrently. Reload before trying again.',
          );
        }
        throw error;
      }
    }

    throw new AppError(
      409,
      'COMPLIANCE_WRITE_CONFLICT',
      'Compliance data changed concurrently. Reload before trying again.',
    );
  }

  private async getOrganisationComplianceScope(
    organisationId: string,
    client: PrismaClient | ComplianceTransaction = this.prisma,
  ): Promise<OrganisationComplianceScope> {
    const [organisation, subscription] = await Promise.all([
      client.organisation.findUniqueOrThrow({
        where: { id: organisationId },
        select: {
          id: true,
          name: true,
          rcnNumber: true,
          complexity: true,
          conditionalObligationProfile: true,
        },
      }),
      client.subscription.findUnique({
        where: { organisationId },
        select: { plan: true },
      }),
    ]);

    if (!subscription) {
      throw new AppError(403, 'NO_SUBSCRIPTION', 'No active subscription. Please subscribe to continue.');
    }

    return {
      id: organisation.id,
      name: organisation.name,
      rcnNumber: organisation.rcnNumber,
      complexity: organisation.complexity as OrganisationComplianceScope['complexity'],
      plan: subscription.plan as OrganisationComplianceScope['plan'],
      conditionalObligationProfile: parseConditionalObligationProfile(organisation.conditionalObligationProfile),
    };
  }

  private async ensureStandardIncludedInPlan(
    organisationId: string,
    standardId: string,
    client: PrismaClient | ComplianceTransaction = this.prisma,
  ) {
    const [scope, standard] = await Promise.all([
      this.getOrganisationComplianceScope(organisationId, client),
      client.governanceStandard.findUnique({
        where: { id: standardId },
        include: { principle: true },
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

    return standard;
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

  private async buildApprovalEvidenceState(
    organisationId: string,
    reportingYear: number,
    client: PrismaClient | ComplianceTransaction,
  ): Promise<ApprovalEvidenceState> {
    const scope = await this.getOrganisationComplianceScope(organisationId, client);
    const [standards, records] = await Promise.all([
      client.governanceStandard.findMany({
        where: standardsWhere(scope),
        include: { principle: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      client.complianceRecord.findMany({
        where: {
          organisationId,
          reportingYear,
          standard: standardsWhere(scope),
        },
        orderBy: [{ standardId: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const orderedStandards = [...standards].sort(
      (left, right) =>
        left.principle.sortOrder - right.principle.sortOrder
        || left.sortOrder - right.sortOrder
        || left.code.localeCompare(right.code)
        || left.id.localeCompare(right.id),
    );
    const recordMap = new Map(records.map((record) => [record.standardId, record]));
    const missingRecords: ComplianceApprovalReadiness['missingRecords'] = [];
    const missingEvidence: ComplianceApprovalReadiness['missingEvidence'] = [];
    const missingExplanations: ComplianceApprovalReadiness['missingExplanations'] = [];
    const matrixReviewItems: ComplianceApprovalReadiness['matrixReviewItems'] = [];

    for (const standard of orderedStandards) {
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

    const readiness: ApprovalReadinessWithoutHash = {
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

    const evidence = toPlainSnapshotJson<ComplianceEvidenceSnapshotPayload>({
      organisation: {
        id: scope.id,
        name: scope.name,
        rcnNumber: scope.rcnNumber,
      },
      reportingYear,
      scope: {
        complexity: scope.complexity,
        plan: scope.plan,
        conditionalObligationProfile: scope.conditionalObligationProfile,
      },
      matrixLastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
      standards: orderedStandards.map((standard) => {
        const record = recordMap.get(standard.id);
        return {
          principle: {
            id: standard.principle.id,
            number: standard.principle.number,
            title: standard.principle.title,
            sortOrder: standard.principle.sortOrder,
          },
          standard: {
            id: standard.id,
            code: standard.code,
            title: standard.title,
            isCore: standard.isCore,
            isAdditional: standard.isAdditional,
            sortOrder: standard.sortOrder,
          },
          record: record
            ? {
                id: record.id,
                revision: record.revision,
                status: record.status,
                actionTaken: record.actionTaken,
                evidence: record.evidence,
                notes: record.notes,
                explanationIfNA: record.explanationIfNA,
                updatedById: record.updatedById,
                updatedAt: record.updatedAt.toISOString(),
              }
            : null,
        };
      }),
      readiness,
    });

    return {
      readiness,
      evidence,
      evidenceHash: hashComplianceSnapshot(evidence),
    };
  }

  private async getCurrentEvidenceHashForSignoff(
    organisationId: string,
    reportingYear: number,
    signoff: Pick<ComplianceSignoffWithSnapshot, 'status' | 'currentApprovalSnapshot'> | null,
    client: PrismaClient | ComplianceTransaction,
  ): Promise<string | null> {
    if (signoff?.status !== 'APPROVED' || !signoff.currentApprovalSnapshot) {
      return null;
    }
    return (await this.buildApprovalEvidenceState(organisationId, reportingYear, client)).evidenceHash;
  }

  async getApprovalReadiness(organisationId: string, reportingYear: number): Promise<ComplianceApprovalReadiness> {
    const state = await this.buildApprovalEvidenceState(organisationId, reportingYear, this.prisma);
    return { ...state.readiness, evidenceHash: state.evidenceHash };
  }

  async getRecord(organisationId: string, standardId: string, year: number) {
    const standard = await this.ensureStandardIncludedInPlan(organisationId, standardId);
    const record = await this.prisma.complianceRecord.findUnique({
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

    if (record) return record;

    return {
      id: null,
      organisationId,
      standardId,
      standard,
      reportingYear: year,
      status: 'NOT_STARTED' as const,
      actionTaken: null,
      evidence: null,
      notes: null,
      explanationIfNA: null,
      revision: 0,
      updatedById: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  async upsertRecord(
    organisationId: string,
    standardId: string,
    userId: string,
    data: UpsertComplianceRecordRequest,
  ) {
    if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0) {
      throw new AppError(
        428,
        'COMPLIANCE_RECORD_REVISION_REQUIRED',
        'Reload this compliance record before saving it.',
      );
    }

    return this.withSerializableOrganisationLock(organisationId, async (tx) => {
      await this.ensureStandardIncludedInPlan(organisationId, standardId, tx);

      const where = {
        organisationId_standardId_reportingYear: {
          organisationId,
          standardId,
          reportingYear: data.reportingYear,
        },
      };
      const include = {
        standard: true,
        updatedBy: { select: { id: true, name: true } },
      };
      const [current, actor] = await Promise.all([
        tx.complianceRecord.findUnique({ where, include }),
        tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
      ]);
      const currentRevision = current?.revision ?? 0;
      const desired = {
        status: data.status ?? current?.status ?? 'NOT_STARTED',
        actionTaken: data.actionTaken === undefined ? current?.actionTaken ?? null : data.actionTaken,
        evidence: data.evidence === undefined ? current?.evidence ?? null : data.evidence,
        notes: data.notes === undefined ? current?.notes ?? null : data.notes,
        explanationIfNA:
          data.explanationIfNA === undefined ? current?.explanationIfNA ?? null : data.explanationIfNA,
      };

      if (currentRevision !== data.expectedRevision) {
        if (current && sameRecordContent(current, desired)) {
          return current;
        }
        throw new AppError(
          409,
          'COMPLIANCE_RECORD_REVISION_CONFLICT',
          'This compliance record changed after it was loaded. Reload it before saving again.',
          { standardId, reportingYear: data.reportingYear, expectedRevision: data.expectedRevision, currentRevision },
        );
      }

      if (current && sameRecordContent(current, desired)) {
        return current;
      }

      const saved = current
        ? await (async () => {
            const updated = await tx.complianceRecord.updateMany({
              where: { id: current.id, organisationId, revision: data.expectedRevision },
              data: {
                ...desired,
                revision: { increment: 1 },
                updatedById: userId,
              },
            });
            if (updated.count !== 1) {
              throw new AppError(
                409,
                'COMPLIANCE_RECORD_REVISION_CONFLICT',
                'This compliance record changed after it was loaded. Reload it before saving again.',
                {
                  standardId,
                  reportingYear: data.reportingYear,
                  expectedRevision: data.expectedRevision,
                  currentRevision,
                },
              );
            }
            return tx.complianceRecord.findUniqueOrThrow({ where, include });
          })()
        : await tx.complianceRecord.create({
            data: {
              organisationId,
              standardId,
              reportingYear: data.reportingYear,
              ...desired,
              revision: 1,
              updatedById: userId,
            },
            include,
          });

      await tx.complianceAuditEvent.create({
        data: {
          organisationId,
          reportingYear: data.reportingYear,
          type: current ? 'RECORD_UPDATED' : 'RECORD_CREATED',
          standardId,
          complianceRecordId: saved.id,
          actorUserId: userId,
          actorName: actor?.name ?? null,
          fromRevision: current?.revision,
          toRevision: saved.revision,
          ...(current ? { beforeState: toInputJson(recordState(current)) } : {}),
          afterState: toInputJson(recordState(saved)),
        },
      });

      const signoff = await tx.complianceSignoff.findUnique({
        where: {
          organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear },
        },
      });
      if (signoff && (signoff.status === 'APPROVED' || signoff.status === 'BOARD_REVIEW')) {
        const approvedWasCurrent = signoff.status === 'APPROVED';
        const nextRevision = signoff.revision + 1;
        const resetSignoff = await tx.complianceSignoff.update({
          where: { id: signoff.id },
          data: {
            status: 'DRAFT',
            boardMeetingDate: null,
            minuteReference: null,
            approvedByName: null,
            approvedByRole: null,
            approvalNotes: null,
            approvedAt: null,
            revision: nextRevision,
            currentApprovalSnapshotId: null,
            invalidatedAt: approvedWasCurrent ? new Date() : signoff.invalidatedAt,
            invalidationReason: approvedWasCurrent ? 'RECORD_CHANGED' : signoff.invalidationReason,
            invalidatedById: approvedWasCurrent ? userId : signoff.invalidatedById,
            updatedById: userId,
          },
        });
        await tx.complianceAuditEvent.create({
          data: {
            organisationId,
            reportingYear: data.reportingYear,
            type: approvedWasCurrent ? 'APPROVAL_INVALIDATED' : 'SIGNOFF_UPDATED',
            signoffId: signoff.id,
            approvalSnapshotId: approvedWasCurrent ? signoff.currentApprovalSnapshotId : null,
            actorUserId: userId,
            actorName: actor?.name ?? null,
            fromRevision: signoff.revision,
            toRevision: nextRevision,
            ...(approvedWasCurrent ? { reason: 'RECORD_CHANGED' as const } : {}),
            beforeState: toInputJson(signoffAuditState(signoff)),
            afterState: toInputJson({
              ...signoffAuditState(resetSignoff),
              triggeringRecordId: saved.id,
              triggeringRecordRevision: saved.revision,
            }),
          },
        });
      }

      return saved;
    });
  }

  async getSignoff(organisationId: string, reportingYear: number): Promise<ComplianceSignoffResponse> {
    const [signoff, latestApproval] = await Promise.all([
      this.prisma.complianceSignoff.findUnique({
        where: {
          organisationId_reportingYear: { organisationId, reportingYear },
        },
        include: { currentApprovalSnapshot: true },
      }),
      this.prisma.complianceApprovalSnapshot.findFirst({
        where: { organisationId, reportingYear },
        orderBy: { approvalSequence: 'desc' },
      }),
    ]);

    const currentEvidenceHash = await this.getCurrentEvidenceHashForSignoff(
      organisationId,
      reportingYear,
      signoff,
      this.prisma,
    );

    return formatSignoffResponse(
      organisationId,
      reportingYear,
      signoff,
      latestApproval,
      currentEvidenceHash,
    );
  }

  async upsertSignoff(
    organisationId: string,
    userId: string,
    data: UpsertComplianceSignoffRequest,
  ): Promise<ComplianceSignoffResponse> {
    if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0) {
      throw new AppError(
        428,
        'COMPLIANCE_SIGNOFF_REVISION_REQUIRED',
        'Reload the board signoff before saving it.',
      );
    }

    return this.withSerializableOrganisationLock(organisationId, async (tx) => {
      const where = {
        organisationId_reportingYear: { organisationId, reportingYear: data.reportingYear },
      };
      const [current, actor] = await Promise.all([
        tx.complianceSignoff.findUnique({
          where,
          include: { currentApprovalSnapshot: true },
        }),
        tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
      ]);
      const currentRevision = current?.revision ?? 0;
      const desired = {
        status: data.status,
        boardMeetingDate:
          data.boardMeetingDate === undefined
            ? current?.boardMeetingDate ?? null
            : data.boardMeetingDate
              ? new Date(data.boardMeetingDate)
              : null,
        minuteReference: data.minuteReference === undefined ? current?.minuteReference ?? null : data.minuteReference,
        approvedByName: data.approvedByName === undefined ? current?.approvedByName ?? null : data.approvedByName,
        approvedByRole: data.approvedByRole === undefined ? current?.approvedByRole ?? null : data.approvedByRole,
        approvalNotes: data.approvalNotes === undefined ? current?.approvalNotes ?? null : data.approvalNotes,
      };
      const sameSignoffContent = Boolean(
        current
        && current.status === desired.status
        && (current.boardMeetingDate?.getTime() ?? null) === (desired.boardMeetingDate?.getTime() ?? null)
        && current.minuteReference === desired.minuteReference
        && current.approvedByName === desired.approvedByName
        && current.approvedByRole === desired.approvedByRole
        && current.approvalNotes === desired.approvalNotes,
      );
      const exactCurrentApproval = Boolean(
        sameSignoffContent
        && current?.status === 'APPROVED'
        && current.currentApprovalSnapshot
        && current.currentApprovalSnapshot.evidenceHash === data.expectedEvidenceHash,
      );

      if (currentRevision !== data.expectedRevision) {
        if (sameSignoffContent && (data.status !== 'APPROVED' || exactCurrentApproval)) {
          const latestApproval = await tx.complianceApprovalSnapshot.findFirst({
            where: { organisationId, reportingYear: data.reportingYear },
            orderBy: { approvalSequence: 'desc' },
          });
          const currentEvidenceHash = await this.getCurrentEvidenceHashForSignoff(
            organisationId,
            data.reportingYear,
            current,
            tx,
          );
          return formatSignoffResponse(
            organisationId,
            data.reportingYear,
            current,
            latestApproval,
            currentEvidenceHash,
          );
        }
        throw new AppError(
          409,
          'COMPLIANCE_SIGNOFF_REVISION_CONFLICT',
          'The board signoff changed after it was loaded. Reload it before saving again.',
          { reportingYear: data.reportingYear, expectedRevision: data.expectedRevision, currentRevision },
        );
      }

      if (data.status !== 'APPROVED') {
        if (sameSignoffContent && current?.status !== 'APPROVED') {
          const latestApproval = await tx.complianceApprovalSnapshot.findFirst({
            where: { organisationId, reportingYear: data.reportingYear },
            orderBy: { approvalSequence: 'desc' },
          });
          return formatSignoffResponse(organisationId, data.reportingYear, current, latestApproval, null);
        }

        const now = new Date();
        const manuallyInvalidated = current?.status === 'APPROVED';
        const nextRevision = currentRevision + 1;
        const write = {
          ...desired,
          approvedAt: null,
          revision: nextRevision,
          currentApprovalSnapshotId: null,
          invalidatedAt: manuallyInvalidated ? now : current?.invalidatedAt ?? null,
          invalidationReason: manuallyInvalidated
            ? 'MANUAL_STATUS_CHANGE' as const
            : current?.invalidationReason ?? null,
          invalidatedById: manuallyInvalidated ? userId : current?.invalidatedById ?? null,
          updatedById: userId,
        };
        const saved = current
          ? await tx.complianceSignoff.update({
              where: { id: current.id },
              data: write,
              include: { currentApprovalSnapshot: true },
            })
          : await tx.complianceSignoff.create({
              data: {
                organisationId,
                reportingYear: data.reportingYear,
                ...write,
                approvalSequence: 0,
              },
              include: { currentApprovalSnapshot: true },
            });

        await tx.complianceAuditEvent.create({
          data: {
            organisationId,
            reportingYear: data.reportingYear,
            type: manuallyInvalidated ? 'APPROVAL_INVALIDATED' : 'SIGNOFF_UPDATED',
            signoffId: saved.id,
            approvalSnapshotId: current?.currentApprovalSnapshotId,
            actorUserId: userId,
            actorName: actor?.name ?? null,
            fromRevision: current?.revision,
            toRevision: saved.revision,
            ...(manuallyInvalidated ? { reason: 'MANUAL_STATUS_CHANGE' as const } : {}),
            ...(current
              ? {
                  beforeState: toInputJson(signoffAuditState(current)),
                }
              : {}),
            afterState: toInputJson(signoffAuditState(saved)),
          },
        });

        const latestApproval = await tx.complianceApprovalSnapshot.findFirst({
          where: { organisationId, reportingYear: data.reportingYear },
          orderBy: { approvalSequence: 'desc' },
        });
        return formatSignoffResponse(organisationId, data.reportingYear, saved, latestApproval, null);
      }

      if (!data.expectedEvidenceHash) {
        throw new AppError(
          428,
          'COMPLIANCE_APPROVAL_EVIDENCE_REQUIRED',
          'Refresh approval readiness before recording board approval.',
        );
      }

      const evidenceState = await this.buildApprovalEvidenceState(organisationId, data.reportingYear, tx);
      if (!evidenceState.readiness.ready) {
        throw new AppError(
          400,
          'COMPLIANCE_APPROVAL_INCOMPLETE',
          'Resolve Compliance Record readiness blockers before board approval.',
        );
      }
      if (evidenceState.evidenceHash !== data.expectedEvidenceHash) {
        throw new AppError(
          409,
          'COMPLIANCE_APPROVAL_EVIDENCE_CHANGED',
          'Compliance evidence changed after it was reviewed. Refresh readiness and review it again.',
          { expectedEvidenceHash: data.expectedEvidenceHash, currentEvidenceHash: evidenceState.evidenceHash },
        );
      }
      if (exactCurrentApproval && current) {
        const latestApproval = await tx.complianceApprovalSnapshot.findFirst({
          where: { organisationId, reportingYear: data.reportingYear },
          orderBy: { approvalSequence: 'desc' },
        });
        return formatSignoffResponse(
          organisationId,
          data.reportingYear,
          current,
          latestApproval,
          evidenceState.evidenceHash,
        );
      }

      const approvedAt = new Date();
      const sequence = (current?.approvalSequence ?? 0) + 1;
      const payload: ComplianceApprovalSnapshotPayload = {
        kind: 'charitypilot.compliance-approval',
        formatVersion: 1,
        evidence: evidenceState.evidence,
        approval: {
          sequence,
          boardMeetingDate: desired.boardMeetingDate!.toISOString().slice(0, 10),
          minuteReference: desired.minuteReference!,
          approvedByName: desired.approvedByName!,
          approvedByRole: desired.approvedByRole,
          approvalNotes: desired.approvalNotes,
          recordedById: userId,
          recordedByName: actor?.name ?? null,
          approvedAt: approvedAt.toISOString(),
        },
      };
      const snapshotHash = hashComplianceSnapshot(payload);
      const snapshot = await tx.complianceApprovalSnapshot.create({
        data: {
          organisationId,
          reportingYear: data.reportingYear,
          approvalSequence: sequence,
          formatVersion: 1,
          evidenceHash: evidenceState.evidenceHash,
          snapshotHash,
          payload: toInputJson(payload),
          approvedAt,
          createdById: userId,
          createdByName: actor?.name ?? null,
        },
      });
      const nextRevision = currentRevision + 1;
      const approvalWrite = {
        ...desired,
        approvedAt,
        revision: nextRevision,
        approvalSequence: sequence,
        currentApprovalSnapshotId: snapshot.id,
        invalidatedAt: null,
        invalidationReason: null,
        invalidatedById: null,
        updatedById: userId,
      };
      const saved = current
        ? await tx.complianceSignoff.update({
            where: { id: current.id },
            data: approvalWrite,
            include: { currentApprovalSnapshot: true },
          })
        : await tx.complianceSignoff.create({
            data: { organisationId, reportingYear: data.reportingYear, ...approvalWrite },
            include: { currentApprovalSnapshot: true },
          });

      await tx.complianceAuditEvent.create({
        data: {
          organisationId,
          reportingYear: data.reportingYear,
          type: 'APPROVAL_GRANTED',
          signoffId: saved.id,
          approvalSnapshotId: snapshot.id,
          actorUserId: userId,
          actorName: actor?.name ?? null,
          fromRevision: current?.revision,
          toRevision: saved.revision,
          ...(current
            ? {
                beforeState: toInputJson(signoffAuditState(current)),
              }
            : {}),
          afterState: toInputJson({
            ...signoffAuditState(saved),
            evidenceHash: evidenceState.evidenceHash,
            snapshotHash,
          }),
        },
      });

      return formatSignoffResponse(
        organisationId,
        data.reportingYear,
        saved,
        snapshot,
        evidenceState.evidenceHash,
      );
    });
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
