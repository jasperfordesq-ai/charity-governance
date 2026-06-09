import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ComplianceService } from '../../services/compliance.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { SubscriptionPlan, complianceQuerySchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { ZodError } from 'zod';

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

type GovernanceRegistersForExport = {
  conflicts: Array<{ trusteeName: string; matter: string; status: string; dateDeclared: Date; actionTaken: string; minuteReference: string | null }>;
  risks: Array<{ title: string; category: string; likelihood: number; impact: number; mitigation: string; status: string; owner: string | null; reviewDate: Date | null }>;
  complaints: Array<{ receivedDate: Date; summary: string; status: string; reviewedByBoard: boolean; outcome: string | null }>;
  fundraising: Array<{ name: string; activityType: string; status: string; controls: string | null; complaintsReceived: boolean }>;
  annualReport: null | {
    filingStatus: string;
    financialStatementsApproved: boolean;
    annualReportUploaded: boolean;
    trusteeDetailsReviewed: boolean;
    fundraisingReviewed: boolean;
    complaintsReviewed: boolean;
    boardApprovalDate: Date | null;
    filedDate: Date | null;
  };
  financialControls: null | {
    bankReconciliationsReviewed: boolean;
    dualAuthorisation: boolean;
    budgetApproved: boolean;
    managementAccountsReviewed: boolean;
    reservesReviewed: boolean;
    restrictedFundsReviewed: boolean;
    assetsInsuranceReviewed: boolean;
    payrollControlsReviewed: boolean;
    fundraisingControlsReviewed: boolean;
    reviewDate: Date | null;
    minuteReference: string | null;
  };
};

function buildComplianceReportHtml(
  org: { name: string; rcnNumber: string | null },
  principles: Array<{
    number: number;
    title: string;
    standards: Array<{ id: string; code: string; title: string; isCore: boolean }>;
  }>,
  recordMap: Map<string, { status: string; actionTaken: string | null; evidence: string | null; explanationIfNA: string | null }>,
  signoff: {
    status: string;
    boardMeetingDate: string | null;
    minuteReference: string | null;
    approvedByName: string | null;
    approvedByRole: string | null;
    approvalNotes: string | null;
    approvedAt: string | null;
  },
  registers: GovernanceRegistersForExport | null,
  year: number,
): string {
  const standardRows = principles
    .map(
      (p) => `
      <h2>Principle ${p.number}: ${p.title}</h2>
      <table>
        <thead>
          <tr>
            <th>Standard</th>
            <th>Type</th>
            <th>Status</th>
            <th>Actions Taken</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          ${p.standards
            .map((s) => {
              const r = recordMap.get(s.id);
              return `
              <tr>
                <td><strong>${s.code}</strong> ${escapeHtml(s.title)}</td>
                <td>${s.isCore ? 'Core' : 'Additional'}</td>
                <td>${r?.status?.replace(/_/g, ' ') ?? 'NOT STARTED'}</td>
                <td>${escapeHtml(r?.actionTaken ?? '')}</td>
                <td>${escapeHtml(r?.evidence ?? '')}${r?.explanationIfNA ? '<br><em>Explanation: ' + escapeHtml(r.explanationIfNA) + '</em>' : ''}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`,
    )
    .join('');

  const governanceRegisterRows = registers
    ? `
      <h2>Governance registers</h2>
      <h3>Conflicts of interest</h3>
      ${simpleTable(
        ['Trustee', 'Matter', 'Status', 'Declared', 'Action taken', 'Minute'],
        registers.conflicts.map((item) => [
          item.trusteeName,
          item.matter,
          item.status,
          formatDate(item.dateDeclared.toISOString()),
          item.actionTaken,
          item.minuteReference ?? '',
        ]),
      )}
      <h3>Risk register</h3>
      ${simpleTable(
        ['Risk', 'Category', 'Score', 'Status', 'Owner', 'Mitigation'],
        registers.risks.map((item) => [
          item.title,
          item.category,
          String(item.likelihood * item.impact),
          item.status,
          item.owner ?? '',
          item.mitigation,
        ]),
      )}
      <h3>Complaints</h3>
      ${simpleTable(
        ['Received', 'Summary', 'Status', 'Board review', 'Outcome'],
        registers.complaints.map((item) => [
          formatDate(item.receivedDate.toISOString()),
          item.summary,
          item.status,
          item.reviewedByBoard ? 'Yes' : 'No',
          item.outcome ?? '',
        ]),
      )}
      <h3>Fundraising</h3>
      ${simpleTable(
        ['Activity', 'Type', 'Status', 'Complaints', 'Controls'],
        registers.fundraising.map((item) => [
          item.name,
          item.activityType,
          item.status,
          item.complaintsReceived ? 'Yes' : 'No',
          item.controls ?? '',
        ]),
      )}
      <h3>Annual Report and financial controls</h3>
      ${simpleTable(
        ['Area', 'Current position'],
        [
          ['Annual Report filing status', registers.annualReport?.filingStatus ?? 'Not started'],
          ['Financial statements approved', yesNo(registers.annualReport?.financialStatementsApproved)],
          ['Annual Report uploaded', yesNo(registers.annualReport?.annualReportUploaded)],
          ['Trustee details reviewed', yesNo(registers.annualReport?.trusteeDetailsReviewed)],
          ['Financial controls review date', registers.financialControls?.reviewDate ? formatDate(registers.financialControls.reviewDate.toISOString()) : 'Not recorded'],
          ['Financial controls minute reference', registers.financialControls?.minuteReference ?? 'Not recorded'],
          ['Bank reconciliations reviewed', yesNo(registers.financialControls?.bankReconciliationsReviewed)],
          ['Dual authorisation in place', yesNo(registers.financialControls?.dualAuthorisation)],
          ['Budget approved', yesNo(registers.financialControls?.budgetApproved)],
          ['Management accounts reviewed', yesNo(registers.financialControls?.managementAccountsReviewed)],
        ],
      )}`
    : '';

  const signoffLabel =
    signoff.status === 'APPROVED'
      ? 'Approved'
      : signoff.status === 'BOARD_REVIEW'
        ? 'Ready for board review'
        : 'Draft';

  const signoffHtml =
    signoff.status === 'APPROVED'
      ? `
        <p><strong>Status:</strong> ${signoffLabel}</p>
        <p><strong>Approved at Board Meeting on:</strong> ${formatDate(signoff.boardMeetingDate)}</p>
        <p><strong>Board minute reference:</strong> ${escapeHtml(signoff.minuteReference ?? '')}</p>
        <p><strong>Approved by:</strong> ${escapeHtml(signoff.approvedByName ?? '')}${signoff.approvedByRole ? ', ' + escapeHtml(signoff.approvedByRole) : ''}</p>
        <p><strong>Recorded in CharityPilot on:</strong> ${formatDate(signoff.approvedAt)}</p>
        ${signoff.approvalNotes ? `<p><strong>Approval notes:</strong> ${escapeHtml(signoff.approvalNotes)}</p>` : ''}`
      : `
        <p><strong>Status:</strong> ${signoffLabel}</p>
        <p><strong>Approved at Board Meeting on:</strong> ____________________</p>
        <p><strong>Board minute reference:</strong> ____________________</p>
        <p><strong>Signed by Chairperson:</strong> ____________________</p>
        <p><strong>Date:</strong> ____________________</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Compliance Record Form — ${escapeHtml(org.name)} — ${year}</title>
  <style>
    body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 1100px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; }
    h1 { color: #0D7377; border-bottom: 3px solid #0D7377; padding-bottom: 8px; }
    h2 { color: #0D7377; margin-top: 32px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background-color: #f0fdfa; font-weight: 600; }
    .header-info { margin-bottom: 32px; }
    .header-info p { margin: 4px 0; }
    @media print { body { padding: 0; } h1 { font-size: 20px; } table { font-size: 11px; } }
  </style>
</head>
<body>
  <h1>Charities Governance Code — Compliance Record Form</h1>
  <div class="header-info">
    <p><strong>Charity Name:</strong> ${escapeHtml(org.name)}</p>
    <p><strong>Registered Charity Number:</strong> ${escapeHtml(org.rcnNumber ?? 'N/A')}</p>
    <p><strong>Reporting Year:</strong> ${year}</p>
    <p><strong>Date Generated:</strong> ${new Date().toLocaleDateString('en-IE')}</p>
  </div>
  ${standardRows}
  ${governanceRegisterRows}
  <div style="margin-top: 48px; border-top: 2px solid #0D7377; padding-top: 16px;">
    <h2>Board approval</h2>
    <p style="font-size: 13px; color: #4b5563;">The Charities Governance Code says the Compliance Record Form should be approved at a board meeting before reporting compliance to the Charities Regulator.</p>
    ${signoffHtml}
  </div>
  <footer style="margin-top: 32px; font-size: 11px; color: #6b7280;">
    Generated by CharityPilot.ie — Charity governance made simple.
  </footer>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(value: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-IE');
}

function yesNo(value: boolean | null | undefined): string {
  return value ? 'Yes' : 'No';
}

function simpleTable(headers: string[], rows: string[][]): string {
  if (!rows.length) {
    return '<p style="font-size: 13px; color: #6b7280;">No records captured.</p>';
  }

  return `<table>
    <thead>
      <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('')}
    </tbody>
  </table>`;
}
