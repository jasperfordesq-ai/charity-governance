import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { SubscriptionPlan, complianceQuerySchema } from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import { ZodError, z } from 'zod';
import {
  buildApprovedComplianceReportHtml,
  buildComplianceReportHtml,
  buildMinimisedComplianceReportHtml,
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
  audience: z.enum(['internal', 'minimised']).default('internal'),
});

type ComplianceApprovalSnapshotModel = {
  findFirst(args: unknown): Promise<StoredComplianceApprovalSnapshot | null>;
};

export async function exportRoutes(app: FastifyInstance) {
  const complianceService = new ComplianceService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);
  // Both audience variants require an Owner/Admin. The minimised variant is a
  // draft for external audience review, not an automatic disclosure channel.
  app.addHook('preHandler', requireAdmin);

  const sendComplianceReport = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = complianceExportQuerySchema.parse(request.query);
      const year = parsed.year ?? new Date().getFullYear();
      const { version, snapshotId, audience } = parsed;
      if (audience === 'minimised' && version !== 'approved') {
        throw new AppError(400, 'MINIMISED_EXPORT_REQUIRES_APPROVAL', 'A minimised export requires an approved snapshot');
      }
      if (request.authSession.clientKind === 'MCP_CONNECTOR' && request.authSession.accessLevel === 'READ') {
        throw new AppError(403, 'SESSION_LEVEL_TOO_LOW', 'A read-only connector session cannot download report files');
      }
      // An internal report contains free-text governance and personal data.
      // The connector's local file tool cannot redact downloaded HTML.
      if (audience === 'internal' && request.authSession.dataScope !== 'FULL') {
        throw new AppError(403, 'PERSONAL_DATA_SCOPE_REQUIRED', 'This report requires a full personal-data session');
      }
      if (version === 'approved' || snapshotId) {
        return await sendApprovedComplianceSnapshot(
          app,
          request,
          reply,
          year,
          snapshotId,
          audience,
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

      await recordReportPrepared(app, request, year, 'current', 'internal');

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
      return handleError(reply, err);
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
  audience: 'internal' | 'minimised' = 'internal',
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

  const metadata = {
    snapshotId: snapshot.id,
    evidenceHash: snapshot.evidenceHash,
    snapshotHash: snapshot.snapshotHash,
  };
  const html = audience === 'minimised'
    ? buildMinimisedComplianceReportHtml(payload)
    : buildApprovedComplianceReportHtml(payload, metadata);

  await recordReportPrepared(app, request, year, 'approved', audience, snapshot.id);

  setReportHeaders(reply);
  reply.header(
    'Content-Disposition',
    `inline; filename="charitypilot-${audience === 'minimised' ? 'minimised-draft' : 'approved-compliance-snapshot'}-${year}-${snapshot.approvalSequence}.html"`,
  );
  return html;
}

async function recordReportPrepared(
  app: FastifyInstance,
  request: FastifyRequest,
  year: number,
  version: 'current' | 'approved',
  audience: 'internal' | 'minimised',
  approvalSnapshotId?: string,
): Promise<void> {
  // Report assembly and snapshot verification can outlast a role change or
  // session revocation. Recheck the current account before preparing delivery.
  const activeSession = await app.prisma.authSession.findFirst({
    where: {
      id: request.user.sessionId,
      userId: request.user.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(request.authSession.clientKind === 'MCP_CONNECTOR' ? { accessLevel: { in: ['WRITE', 'ADMIN'] as const } } : {}),
      ...(audience === 'internal' ? { dataScope: 'FULL' as const } : {}),
      user: { is: {
        organisationId: request.user.organisationId,
        lifecycleStatus: 'ACTIVE',
        emailVerified: true,
        role: { in: ['OWNER', 'ADMIN'] },
        organisation: { is: { lifecycleStatus: 'ACTIVE' } },
      } },
    },
    select: { id: true },
  });
  if (!activeSession) {
    throw new AppError(401, 'UNAUTHORIZED', 'Your authenticated session is no longer authorised for this report');
  }

  // Record only the disclosure shape, never the report body or evidence.
  // A failed audit write prevents delivery of the generated HTML.
  await app.prisma.complianceReportPreparationAudit.create({
    data: {
      organisationId: request.user.organisationId,
      reportingYear: year,
      actorUserId: request.user.userId,
      reportVersion: version,
      audience,
      approvalSnapshotId,
    },
  });
}

function setReportHeaders(reply: FastifyReply): void {
  reply.header('Content-Type', 'text/html');
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
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
    app.prisma.complaintRecord.findMany({ where: { organisationId, removedAt: null }, orderBy: { receivedDate: 'desc' } }),
    app.prisma.fundraisingRecord.findMany({ where: { organisationId }, orderBy: { updatedAt: 'desc' } }),
    app.prisma.annualReportReadiness.findUnique({ where: { organisationId_reportingYear: { organisationId, reportingYear: year } } }),
    app.prisma.financialControlReview.findUnique({ where: { organisationId_reportingYear: { organisationId, reportingYear: year } } }),
  ]);

  return { conflicts, risks, complaints, fundraising, annualReport, financialControls };
}

