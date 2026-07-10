import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { SubscriptionPlan, complianceQuerySchema } from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import { ZodError, z } from 'zod';
import {
  buildApprovedComplianceReportHtml,
  buildComplianceReportHtml,
  type GovernanceRegistersForExport,
} from './compliance-report-html.js';
import {
  ComplianceSnapshotIntegrityError,
  parseAndVerifyStoredComplianceSnapshot,
  type StoredComplianceApprovalSnapshot,
} from '../../services/compliance-snapshot.js';

const complianceExportQuerySchema = complianceQuerySchema.extend({
  version: z.enum(['current', 'approved']).default('current'),
  snapshotId: z.string().trim().min(1).max(128).optional(),
});

type ComplianceApprovalSnapshotModel = {
  findFirst(args: unknown): Promise<StoredComplianceApprovalSnapshot | null>;
};

export async function exportRoutes(app: FastifyInstance) {
  const complianceService = new ComplianceService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  const sendComplianceReport = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { year, version, snapshotId } = complianceExportQuerySchema.parse(request.query);
      if (version === 'approved' || snapshotId) {
        return await sendApprovedComplianceSnapshot(
          app,
          request,
          reply,
          year,
          snapshotId,
        );
      }

      const org = await app.prisma.organisation.findUniqueOrThrow({
        where: { id: request.user.organisationId },
      });

      const principles = await complianceService.getPrinciplesForOrganisation(request.user.organisationId);
      const records = await complianceService.getRecords(request.user.organisationId, year);
      const signoff = await complianceService.getSignoff(request.user.organisationId, year);
      const approvalReadiness = await complianceService.getApprovalReadiness(request.user.organisationId, year);
      const subscription = await app.prisma.subscription.findUnique({
        where: { organisationId: request.user.organisationId },
        select: { plan: true },
      });
      const registers =
        subscription?.plan === SubscriptionPlan.COMPLETE
          ? await loadGovernanceRegisters(app, request.user.organisationId, year)
          : null;
      const recordMap = new Map(records.map((r) => [r.standardId, r]));
      const currentApprovalEvidenceMatches = Boolean(
        signoff.status === 'APPROVED' &&
        signoff.approvalCurrent &&
        signoff.currentApproval?.evidenceHash &&
        signoff.currentApproval.evidenceHash === approvalReadiness.evidenceHash,
      );
      const reportSignoff = {
        ...signoff,
        approvalCurrent: currentApprovalEvidenceMatches,
        invalidationReason:
          signoff.status === 'APPROVED' && !currentApprovalEvidenceMatches
            ? signoff.invalidationReason ?? 'CURRENT_EVIDENCE_CHANGED'
            : signoff.invalidationReason,
      };

      // Build a printable HTML report that the browser can save as PDF.
      const html = buildComplianceReportHtml(
        org,
        principles,
        recordMap,
        reportSignoff,
        approvalReadiness,
        registers,
        year,
      );

      setReportHeaders(reply);
      reply.header(
        'Content-Disposition',
        `inline; filename="charitypilot-compliance-report-${year}.html"`,
      );
      return html;
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  };

  // GET /compliance-record?year=2026&format=pdf
  app.get('/compliance-record', sendComplianceReport);

  // GET /compliance-report?year=2026 - alias used by the web app
  app.get('/compliance-report', sendComplianceReport);
}

async function sendApprovedComplianceSnapshot(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  year: number,
  snapshotId?: string,
) {
  const snapshotModel = (app.prisma as unknown as {
    complianceApprovalSnapshot?: ComplianceApprovalSnapshotModel;
  }).complianceApprovalSnapshot;

  if (!snapshotModel) {
    throw new AppError(
      500,
      'COMPLIANCE_SNAPSHOT_INTEGRITY_FAILED',
      'Approved compliance snapshot could not be verified',
    );
  }

  // The tenant and reporting year are part of the same lookup as the optional
  // opaque id, so cross-tenant ids are indistinguishable from missing ids.
  const snapshot = await snapshotModel.findFirst({
    where: {
      organisationId: request.user.organisationId,
      reportingYear: year,
      ...(snapshotId ? { id: snapshotId } : {}),
    },
    orderBy: snapshotId ? undefined : { approvalSequence: 'desc' },
    select: {
      id: true,
      organisationId: true,
      reportingYear: true,
      approvalSequence: true,
      formatVersion: true,
      evidenceHash: true,
      snapshotHash: true,
      payload: true,
      approvedAt: true,
      createdById: true,
      createdByName: true,
    },
  });

  if (!snapshot) {
    throw new AppError(
      404,
      'COMPLIANCE_APPROVAL_SNAPSHOT_NOT_FOUND',
      'Approved compliance snapshot not found for this reporting year',
    );
  }

  let payload;
  try {
    payload = parseAndVerifyStoredComplianceSnapshot(snapshot);
  } catch (error) {
    if (error instanceof ComplianceSnapshotIntegrityError) {
      throw new AppError(
        500,
        'COMPLIANCE_SNAPSHOT_INTEGRITY_FAILED',
        'Approved compliance snapshot could not be verified',
      );
    }
    throw error;
  }

  const html = buildApprovedComplianceReportHtml(payload, {
    snapshotId: snapshot.id,
    evidenceHash: snapshot.evidenceHash,
    snapshotHash: snapshot.snapshotHash,
  });

  setReportHeaders(reply);
  reply.header(
    'Content-Disposition',
    `inline; filename="charitypilot-approved-compliance-snapshot-${year}-${snapshot.approvalSequence}.html"`,
  );
  return html;
}

function setReportHeaders(reply: FastifyReply): void {
  reply.header('Content-Type', 'text/html');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
}

async function loadGovernanceRegisters(
  app: FastifyInstance,
  organisationId: string,
  year: number,
): Promise<GovernanceRegistersForExport> {
  const [conflicts, risks, complaints, fundraising, annualReport, financialControls] = await Promise.all([
    app.prisma.conflictRecord.findMany({ where: { organisationId }, orderBy: { dateDeclared: 'desc' } }),
    app.prisma.riskRecord.findMany({ where: { organisationId }, orderBy: { updatedAt: 'desc' } }),
    app.prisma.complaintRecord.findMany({ where: { organisationId }, orderBy: { receivedDate: 'desc' } }),
    app.prisma.fundraisingRecord.findMany({ where: { organisationId }, orderBy: { updatedAt: 'desc' } }),
    app.prisma.annualReportReadiness.findUnique({ where: { organisationId_reportingYear: { organisationId, reportingYear: year } } }),
    app.prisma.financialControlReview.findUnique({ where: { organisationId_reportingYear: { organisationId, reportingYear: year } } }),
  ]);

  return { conflicts, risks, complaints, fundraising, annualReport, financialControls };
}

