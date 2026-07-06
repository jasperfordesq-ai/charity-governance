import type { ComplianceApprovalReadiness } from '../../services/compliance.service.js';
import { IRISH_COMPLIANCE_MATRIX, IRISH_COMPLIANCE_MATRIX_LAST_CHECKED } from '@charitypilot/shared';

export type GovernanceRegistersForExport = {
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

const annualReportSource = IRISH_COMPLIANCE_MATRIX
  .flatMap((entry) => entry.sourceRefs)
  .find((source) => source.name === 'Annual report - how to submit');

const annualReportDeadlineBasis = annualReportSource
  ? `10 months after financial year end. Source: ${annualReportSource.name} (${annualReportSource.url}, checked ${annualReportSource.lastChecked}). Review as a planning prompt, not legal advice.`
  : '10 months after financial year end. Review as a planning prompt, not legal advice.';

export function buildComplianceReportHtml(
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
  approvalReadiness: ComplianceApprovalReadiness,
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
          ['Annual Report deadline basis', annualReportDeadlineBasis],
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

  const readinessWarningHtml = buildReadinessWarningHtml(approvalReadiness);
  const conditionalReviewHtml = buildConditionalReviewHtml(approvalReadiness);
  const sourceReviewAppendixHtml = buildSourceReviewAppendixHtml();

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
  ${readinessWarningHtml}
  ${conditionalReviewHtml}
  ${sourceReviewAppendixHtml}
  <div style="margin-top: 48px; border-top: 2px solid #0D7377; padding-top: 16px;">
    <h2>Board approval</h2>
    <p style="font-size: 13px; color: #4b5563;">The Charities Governance Code says the Compliance Record Form should be approved at a board meeting before reporting compliance to the Charities Regulator.</p>
    ${signoffHtml}
  </div>
  <footer style="margin-top: 32px; font-size: 11px; color: #6b7280;">
    Generated by CharityPilot.ie. This report is a governance workflow record, not legal advice or a certificate of compliance.
  </footer>
</body>
</html>`;
}

function buildReadinessWarningHtml(approvalReadiness: ComplianceApprovalReadiness): string {
  if (approvalReadiness.ready) {
    return '';
  }

  const rows = [
    ...approvalReadiness.missingRecords.map((item) => [
      item.standardCode,
      'No Compliance Record status captured',
      'Open the standard and record the trustee-reviewed position before board approval.',
    ]),
    ...approvalReadiness.missingEvidence.map((item) => [
      item.standardCode,
      missingEvidenceLabel(item.missingActionTaken, item.missingEvidence),
      'Add the action taken and evidence fields needed for a review-ready Compliance Record.',
    ]),
    ...approvalReadiness.missingExplanations.map((item) => [
      item.standardCode,
      `${item.status.replace(/_/g, ' ')} explanation missing`,
      'Explain why the standard is not applicable or why the charity is explaining instead of marking compliant.',
    ]),
    ...approvalReadiness.profileIssues.map((item) => [
      'Organisation profile',
      item.code.replace(/_/g, ' '),
      item.message,
    ]),
  ];

  return `
    <section style="margin-top: 40px; border: 1px solid #f59e0b; background: #fffbeb; padding: 14px 16px;">
      <h2 style="margin-top: 0; color: #92400e;">Approval readiness warning</h2>
      <p style="font-size: 13px; color: #78350f;">
        This report is review-ready but not board-approval-ready until missing records, evidence fields,
        explanations and organisation-profile checks are completed. This is a workflow readiness check,
        not legal certification.
      </p>
      ${simpleTable(['Area', 'Readiness blocker', 'Next action'], rows)}
    </section>`;
}

function buildConditionalReviewHtml(approvalReadiness: ComplianceApprovalReadiness): string {
  if (approvalReadiness.conditionalReviewItems.length === 0) {
    return '';
  }

  return `
    <section style="margin-top: 40px; border: 1px solid #99f6e4; background: #f0fdfa; padding: 14px 16px;">
      <h2 style="margin-top: 0; color: #115e59;">Conditional obligation review prompts</h2>
      <p style="font-size: 13px; color: #134e4a;">
        These prompts come from the organisation profile. They identify areas for trustee and professional review;
        they do not certify that the listed obligation applies in every case.
      </p>
      ${simpleTable(
        ['Profile trigger', 'Relevant standards', 'Professional review', 'Recommended action'],
        approvalReadiness.conditionalReviewItems.map((item) => [
          item.label,
          item.standardCodes.join(', '),
          item.professionalReview.map((flag) => flag.replace(/_/g, ' ')).join(', ') || 'Trustee review',
          item.recommendedAction,
        ]),
      )}
    </section>`;
}

function missingEvidenceLabel(missingActionTaken: boolean, missingEvidence: boolean): string {
  if (missingActionTaken && missingEvidence) return 'Missing action taken and evidence';
  if (missingActionTaken) return 'Missing action taken';
  return 'Missing evidence';
}

function buildSourceReviewAppendixHtml(): string {
  const sourceMap = new Map<string, { name: string; owner: string; url: string; lastChecked: string }>();
  const statusCounts = new Map<string, number>();
  const reviewFlags = new Set<string>();

  for (const entry of IRISH_COMPLIANCE_MATRIX) {
    statusCounts.set(entry.commencementStatus, (statusCounts.get(entry.commencementStatus) ?? 0) + 1);
    for (const flag of entry.professionalReview) reviewFlags.add(flag.replace(/_/g, ' '));
    for (const source of entry.sourceRefs) {
      sourceMap.set(source.url, {
        name: source.name,
        owner: source.owner,
        url: source.url,
        lastChecked: source.lastChecked,
      });
    }
  }

  const statusRows = [...statusCounts.entries()].map(([status, count]) => [status.replace(/_/g, ' '), String(count)]);
  const sourceRows = [...sourceMap.values()]
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))
    .map((source) => [source.name, source.owner, source.lastChecked, source.url]);

  return `
    <section style="margin-top: 40px; border: 1px solid #d1d5db; background: #f9fafb; padding: 14px 16px;">
      <h2 style="margin-top: 0;">Source and professional-review appendix</h2>
      <p style="font-size: 13px; color: #374151;">
        CharityPilot maps records to source-cited Irish charity governance prompts. This export is not legal advice,
        not a substitute for solicitor, accountant, data-protection, employment, safeguarding, health-and-safety or
        governance review, and not a certificate that the charity is compliant.
      </p>
      <p style="font-size: 13px; color: #374151;">
        Matrix last checked: ${escapeHtml(IRISH_COMPLIANCE_MATRIX_LAST_CHECKED)}. Applicability depends on the charity's facts,
        activities, legal form, workforce, fundraising, services, and trustee judgement.
      </p>
      <h3>Commencement status summary</h3>
      ${simpleTable(['Status', 'Mapped prompts'], statusRows)}
      <h3>Professional review flags in this matrix</h3>
      <p style="font-size: 13px; color: #374151;">${escapeHtml([...reviewFlags].sort().join(', ') || 'None recorded')}</p>
      <h3>Official sources used by the matrix</h3>
      ${simpleTable(['Source', 'Owner', 'Last checked', 'URL'], sourceRows)}
    </section>`;
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
