import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { SubscriptionPlan, complianceQuerySchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { ZodError } from 'zod';
import { buildComplianceReportHtml, type GovernanceRegistersForExport } from './compliance-report-html.js';

export async function exportRoutes(app: FastifyInstance) {
  const complianceService = new ComplianceService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  const sendComplianceReport = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { year } = complianceQuerySchema.parse(request.query);
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

      // Build a printable HTML report that the browser can save as PDF.
      const html = buildComplianceReportHtml(
        org,
        principles,
        recordMap,
        signoff,
        approvalReadiness,
        registers,
        year,
      );

      reply.header('Content-Type', 'text/html');
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
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

