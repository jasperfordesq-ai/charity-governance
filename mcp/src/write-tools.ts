import type { ToolDefinition } from './tools.js';
import {
  ANNUAL_REPORT_FILING_STATUSES,
  COMPLIANCE_SIGNOFF_STATUSES,
  COMPLIANCE_STATUSES,
  LEGAL_FORMS,
  ORGANISATION_COMPLEXITIES,
  CONFLICT_STATUSES,
  DIRECTOR_APPOINTMENT_KINDS,
  GOVERNING_ACT_KINDS,
  GOVERNING_ACT_STATUSES,
  REGISTER_STATUSES,
  RISK_CATEGORIES,
} from './enums.js';

/**
 * The tools that change things.
 *
 * Kept apart from the read tools because they are read under different
 * circumstances: someone checking what the connector can see reads the other
 * file, and someone checking what it can do to a charity's records reads this
 * one.
 *
 * Every field each tool accepts is declared. A field that is not declared is
 * refused rather than forwarded, so a model cannot reach a column the
 * connector never meant to expose by guessing its name. Personal-data fields
 * are deliberately absent from the write surface: a date of birth or a home
 * address is not something an agent should be putting into a register.
 *
 * The destructive tools at the end do not carry bodies. They exist so the
 * action can be asked for and refused in one place; the API answers each with
 * a request for a person to approve it in their own terminal.
 */
const CHANGES = ' Changes CharityPilot data. Say what you are changing and why before calling it.';

const APPROVAL_NOTE =
  ' You will be asked to approve this in your own terminal before it happens, '
  + 'and the approval covers only this one record.';

const CONCURRENCY =
  'The updatedAt value from the record as you read it. CharityPilot refuses the '
  + 'change if someone else altered the record in the meantime.';

export const WRITE_TOOLS: readonly ToolDefinition[] = [
  /* --- board register ---------------------------------------------------- */
  {
    name: 'board_member_create',
    description: 'Add a trustee or director to the board register.' + CHANGES,
    path: '/api/v1/board-members',
    method: 'POST',
    level: 'write',
    model: 'BoardMember',
    body: [
      { kind: 'string', name: 'name', max: 200, required: true },
      {
        kind: 'string',
        name: 'role',
        max: 100,
        required: true,
        describe: 'Their role on the board, such as Chair or Treasurer.',
      },
      { kind: 'date', name: 'appointedDate', required: true },
      { kind: 'date', name: 'termEndDate' },
      { kind: 'boolean', name: 'conductSigned' },
      { kind: 'date', name: 'conductSignedDate' },
      { kind: 'boolean', name: 'inductionCompleted' },
      { kind: 'date', name: 'inductionDate' },
      { kind: 'enum', name: 'appointmentKind', values: DIRECTOR_APPOINTMENT_KINDS },
    ],
  },
  {
    name: 'board_member_update',
    description: 'Change an entry in the board register.' + CHANGES,
    path: '/api/v1/board-members/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'BoardMember',
    body: [
      { kind: 'string', name: 'name', max: 200 },
      { kind: 'string', name: 'role', max: 100 },
      { kind: 'date', name: 'appointedDate' },
      { kind: 'date', name: 'termEndDate' },
      { kind: 'boolean', name: 'isActive' },
      { kind: 'boolean', name: 'conductSigned' },
      { kind: 'date', name: 'conductSignedDate' },
      { kind: 'boolean', name: 'inductionCompleted' },
      { kind: 'date', name: 'inductionDate' },
      { kind: 'enum', name: 'appointmentKind', values: DIRECTOR_APPOINTMENT_KINDS },
    ],
  },

  /* --- compliance -------------------------------------------------------- */
  {
    name: 'compliance_record_set',
    description:
      'Set this charity’s status, evidence and notes against one Governance Code standard.'
      + CHANGES,
    path: '/api/v1/compliance/records/:standardId',
    method: 'PUT',
    level: 'write',
    params: [{ kind: 'id', name: 'standardId' }],
    noRecordsBecause: 'The charity’s own position on a standard; no records about anyone.',
    body: [
      { kind: 'integer', name: 'reportingYear', min: 2018, max: 2100, required: true },
      {
        kind: 'integer',
        name: 'expectedRevision',
        control: true,
        min: 0,
        max: 1_000_000,
        required: true,
        describe:
          'The revision number you read, so a change made by someone else in the '
          + 'meantime is not silently overwritten.',
      },
      { kind: 'enum', name: 'status', values: COMPLIANCE_STATUSES },
      { kind: 'string', name: 'actionTaken', max: 5000 },
      { kind: 'string', name: 'evidence', max: 5000 },
      { kind: 'string', name: 'notes', max: 5000 },
      { kind: 'string', name: 'explanationIfNA', max: 5000 },
    ],
  },

  /* --- deadlines --------------------------------------------------------- */
  {
    name: 'deadline_create',
    description: 'Add a governance deadline to the calendar.' + CHANGES,
    path: '/api/v1/deadlines',
    method: 'POST',
    level: 'write',
    noRecordsBecause: 'A dated obligation; no records about anyone.',
    body: [
      { kind: 'string', name: 'title', max: 300, required: true },
      { kind: 'string', name: 'description', max: 1000 },
      { kind: 'date', name: 'dueDate', required: true },
      { kind: 'dayList', name: 'reminderDays' },
    ],
  },
  {
    name: 'deadline_update',
    description:
      'Change a deadline, including marking it complete or correcting a date that is '
      + 'wrong.' + CHANGES,
    path: '/api/v1/deadlines/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'A dated obligation; no records about anyone.',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'string', name: 'title', max: 300 },
      { kind: 'string', name: 'description', max: 1000 },
      { kind: 'date', name: 'dueDate' },
      { kind: 'boolean', name: 'isComplete' },
      { kind: 'dayList', name: 'reminderDays' },
    ],
  },

  /* --- registers --------------------------------------------------------- */
  {
    name: 'conflict_create',
    description: 'Record a declared conflict of interest.' + CHANGES,
    path: '/api/v1/governance-registers/conflicts',
    method: 'POST',
    level: 'write',
    model: 'ConflictRecord',
    body: [
      { kind: 'id', name: 'boardMemberId' },
      { kind: 'string', name: 'trusteeName', max: 200, required: true },
      { kind: 'string', name: 'matter', max: 300, required: true },
      { kind: 'string', name: 'nature', max: 3000, required: true },
      { kind: 'date', name: 'dateDeclared', required: true },
      { kind: 'date', name: 'meetingDate' },
      { kind: 'string', name: 'actionTaken', max: 3000, required: true },
      { kind: 'string', name: 'decision', max: 3000 },
      { kind: 'enum', name: 'status', values: CONFLICT_STATUSES },
      { kind: 'string', name: 'minuteReference', max: 200 },
      { kind: 'date', name: 'nextReviewDate' },
    ],
  },
  {
    name: 'risk_create',
    description: 'Add an entry to the risk register.' + CHANGES,
    path: '/api/v1/governance-registers/risks',
    method: 'POST',
    level: 'write',
    model: 'RiskRecord',
    body: [
      { kind: 'string', name: 'title', max: 300, required: true },
      { kind: 'enum', name: 'category', values: RISK_CATEGORIES, required: true },
      { kind: 'string', name: 'description', max: 3000, required: true },
      {
        kind: 'integer',
        name: 'likelihood',
        min: 1,
        max: 5,
        required: true,
        describe: 'How likely it is, from 1 to 5.',
      },
      {
        kind: 'integer',
        name: 'impact',
        min: 1,
        max: 5,
        required: true,
        describe: 'How serious it would be, from 1 to 5.',
      },
      { kind: 'string', name: 'mitigation', max: 3000, required: true },
      { kind: 'string', name: 'owner', max: 200 },
      { kind: 'date', name: 'reviewDate' },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },
  {
    name: 'complaint_create',
    description: 'Record a complaint in the complaints register.' + CHANGES,
    path: '/api/v1/governance-registers/complaints',
    method: 'POST',
    level: 'write',
    model: 'ComplaintRecord',
    body: [
      { kind: 'date', name: 'receivedDate', required: true },
      { kind: 'string', name: 'source', max: 200 },
      { kind: 'string', name: 'summary', max: 3000, required: true },
      { kind: 'string', name: 'actionTaken', max: 3000 },
      { kind: 'string', name: 'outcome', max: 3000 },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'boolean', name: 'reviewedByBoard' },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },
  {
    name: 'fundraising_create',
    description: 'Add an activity to the fundraising register.' + CHANGES,
    path: '/api/v1/governance-registers/fundraising',
    method: 'POST',
    level: 'write',
    model: 'FundraisingRecord',
    body: [
      { kind: 'string', name: 'name', max: 300, required: true },
      { kind: 'string', name: 'activityType', max: 200, required: true },
      { kind: 'date', name: 'startDate' },
      { kind: 'date', name: 'endDate' },
      { kind: 'boolean', name: 'publicFacing' },
      { kind: 'string', name: 'thirdPartyFundraiser', max: 300 },
      { kind: 'string', name: 'controls', max: 3000 },
      { kind: 'boolean', name: 'complaintsReceived' },
      { kind: 'string', name: 'reviewOutcome', max: 3000 },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },
  {
    name: 'financial_controls_set',
    description: 'Record the board’s financial controls review for a reporting year.' + CHANGES,
    path: '/api/v1/governance-registers/financial-controls',
    method: 'PUT',
    level: 'write',
    model: 'FinancialControlReview',
    body: [
      { kind: 'integer', name: 'reportingYear', min: 2018, max: 2100, required: true },
      { kind: 'boolean', name: 'bankReconciliationsReviewed' },
      { kind: 'boolean', name: 'dualAuthorisation' },
      { kind: 'boolean', name: 'budgetApproved' },
      { kind: 'boolean', name: 'managementAccountsReviewed' },
      { kind: 'boolean', name: 'reservesReviewed' },
      { kind: 'boolean', name: 'restrictedFundsReviewed' },
      { kind: 'boolean', name: 'assetsInsuranceReviewed' },
      { kind: 'boolean', name: 'payrollControlsReviewed' },
      { kind: 'boolean', name: 'fundraisingControlsReviewed' },
      { kind: 'string', name: 'reviewedBy', max: 200 },
      { kind: 'date', name: 'reviewDate' },
      { kind: 'string', name: 'minuteReference', max: 200 },
      { kind: 'string', name: 'actions', max: 5000 },
    ],
  },

  /* --- minute book -------------------------------------------------------- */
  {
    name: 'governing_act_create',
    description:
      'Record a board meeting, general meeting or written resolution in the minute book.'
      + CHANGES,
    path: '/api/v1/governing-acts',
    method: 'POST',
    level: 'write',
    model: 'GoverningAct',
    body: [
      { kind: 'enum', name: 'kind', values: GOVERNING_ACT_KINDS, required: true },
      { kind: 'enum', name: 'status', values: GOVERNING_ACT_STATUSES },
      { kind: 'date', name: 'actDate', required: true },
      {
        kind: 'string',
        name: 'reference',
        max: 100,
        required: true,
        describe: 'The minute reference, unique within this charity.',
      },
      { kind: 'string', name: 'title', max: 300, required: true },
      { kind: 'string', name: 'statutoryBasis', max: 300 },
      { kind: 'id', name: 'approvedAtActId' },
      { kind: 'date', name: 'approvedAt' },
      { kind: 'id', name: 'documentId' },
      { kind: 'string', name: 'notes', max: 5000 },
    ],
  },
  {
    name: 'governing_act_update',
    description: 'Change an entry in the minute book.' + CHANGES,
    path: '/api/v1/governing-acts/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'GoverningAct',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'enum', name: 'kind', values: GOVERNING_ACT_KINDS },
      { kind: 'enum', name: 'status', values: GOVERNING_ACT_STATUSES },
      { kind: 'date', name: 'actDate' },
      { kind: 'string', name: 'reference', max: 100 },
      { kind: 'string', name: 'title', max: 300 },
      { kind: 'string', name: 'statutoryBasis', max: 300 },
      { kind: 'id', name: 'approvedAtActId' },
      { kind: 'date', name: 'approvedAt' },
      { kind: 'id', name: 'documentId' },
      { kind: 'string', name: 'notes', max: 5000 },
    ],
  },

  /* --- destructive: each asks a person before it happens ------------------ */
  {
    name: 'board_member_delete',
    description: 'Permanently remove an entry from the board register.' + APPROVAL_NOTE,
    path: '/api/v1/board-members/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'conflict_delete',
    description:
      'Permanently remove an entry from the conflicts of interest register.' + APPROVAL_NOTE,
    path: '/api/v1/governance-registers/conflicts/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'risk_delete',
    description: 'Permanently remove an entry from the risk register.' + APPROVAL_NOTE,
    path: '/api/v1/governance-registers/risks/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'complaint_delete',
    description: 'Permanently remove an entry from the complaints register.' + APPROVAL_NOTE,
    path: '/api/v1/governance-registers/complaints/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'fundraising_delete',
    description: 'Permanently remove an entry from the fundraising register.' + APPROVAL_NOTE,
    path: '/api/v1/governance-registers/fundraising/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  /* --- register updates --------------------------------------------------- */
  {
    name: 'conflict_update',
    description: 'Change a declared conflict of interest.' + CHANGES,
    path: '/api/v1/governance-registers/conflicts/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'ConflictRecord',
    body: [
      { kind: 'id', name: 'boardMemberId' },
      { kind: 'string', name: 'trusteeName', max: 200 },
      { kind: 'string', name: 'matter', max: 300 },
      { kind: 'string', name: 'nature', max: 3000 },
      { kind: 'date', name: 'dateDeclared' },
      { kind: 'date', name: 'meetingDate' },
      { kind: 'string', name: 'actionTaken', max: 3000 },
      { kind: 'string', name: 'decision', max: 3000 },
      { kind: 'enum', name: 'status', values: CONFLICT_STATUSES },
      { kind: 'string', name: 'minuteReference', max: 200 },
      { kind: 'date', name: 'nextReviewDate' },
    ],
  },
  {
    name: 'risk_update',
    description: 'Change an entry in the risk register.' + CHANGES,
    path: '/api/v1/governance-registers/risks/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'RiskRecord',
    body: [
      { kind: 'string', name: 'title', max: 300 },
      { kind: 'enum', name: 'category', values: RISK_CATEGORIES },
      { kind: 'string', name: 'description', max: 3000 },
      { kind: 'integer', name: 'likelihood', min: 1, max: 5 },
      { kind: 'integer', name: 'impact', min: 1, max: 5 },
      { kind: 'string', name: 'mitigation', max: 3000 },
      { kind: 'string', name: 'owner', max: 200 },
      { kind: 'date', name: 'reviewDate' },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },
  {
    name: 'complaint_update',
    description: 'Change an entry in the complaints register.' + CHANGES,
    path: '/api/v1/governance-registers/complaints/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'ComplaintRecord',
    body: [
      { kind: 'date', name: 'receivedDate' },
      { kind: 'string', name: 'source', max: 200 },
      { kind: 'string', name: 'summary', max: 3000 },
      { kind: 'string', name: 'actionTaken', max: 3000 },
      { kind: 'string', name: 'outcome', max: 3000 },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'boolean', name: 'reviewedByBoard' },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },
  {
    name: 'fundraising_update',
    description: 'Change an activity in the fundraising register.' + CHANGES,
    path: '/api/v1/governance-registers/fundraising/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'FundraisingRecord',
    body: [
      { kind: 'string', name: 'name', max: 300 },
      { kind: 'string', name: 'activityType', max: 200 },
      { kind: 'date', name: 'startDate' },
      { kind: 'date', name: 'endDate' },
      { kind: 'boolean', name: 'publicFacing' },
      { kind: 'string', name: 'thirdPartyFundraiser', max: 300 },
      { kind: 'string', name: 'controls', max: 3000 },
      { kind: 'boolean', name: 'complaintsReceived' },
      { kind: 'string', name: 'reviewOutcome', max: 3000 },
      { kind: 'enum', name: 'status', values: REGISTER_STATUSES },
      { kind: 'string', name: 'boardMinuteReference', max: 200 },
    ],
  },

  /* --- the charity's own profile ------------------------------------------ */
  {
    name: 'organisation_update',
    description:
      'Change the charity’s own profile: its registration details, financial year end, '
      + 'and the dates the deadline calendar is generated from. Correcting a date here is how '
      + 'a deadline that is wrongly shown as late gets fixed.' + CHANGES,
    path: '/api/v1/organisation',
    method: 'PATCH',
    level: 'write',
    model: 'Organisation',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'string', name: 'name', max: 300 },
      { kind: 'string', name: 'rcnNumber', max: 20 },
      { kind: 'string', name: 'croNumber', max: 20 },
      { kind: 'enum', name: 'legalForm', values: LEGAL_FORMS },
      { kind: 'boolean', name: 'confirmLegalForm', control: true },
      { kind: 'enum', name: 'complexity', values: ORGANISATION_COMPLEXITIES },
      { kind: 'date', name: 'financialYearEnd' },
      { kind: 'date', name: 'dateRegistered' },
      { kind: 'date', name: 'incorporationDate' },
      { kind: 'date', name: 'croAnnualReturnDate' },
      { kind: 'boolean', name: 'confirmCroAnnualReturnDate', control: true },
      {
        kind: 'date',
        name: 'lastActualAgmDate',
        describe:
          'The date the last annual general meeting was actually held. The annual meeting '
          + 'deadline is generated from this, so a wrong value here is the usual cause of a '
          + 'deadline that looks overdue when it is not.',
      },
      { kind: 'date', name: 'lastUnanimousAnnualMemberResolutionDate' },
      { kind: 'integer', name: 'memberCount', min: 1, max: 100_000 },
      { kind: 'boolean', name: 'constitutionPermitsWrittenResolutions' },
    ],
  },

  /* --- compliance and the annual report ----------------------------------- */
  {
    name: 'compliance_signoff_set',
    description:
      'Record the board’s sign-off against the Governance Code for a reporting year.'
      + CHANGES,
    path: '/api/v1/compliance/signoff',
    method: 'PUT',
    level: 'write',
    shape: 'complianceSignoff',
    body: [
      { kind: 'integer', name: 'reportingYear', min: 2018, max: 2100, required: true },
      {
        kind: 'integer',
        name: 'expectedRevision',
        control: true,
        min: 0,
        max: 1_000_000,
        required: true,
        describe: 'The revision you read, so a change made by someone else is not overwritten.',
      },
      {
        kind: 'enum',
        name: 'status',
        values: COMPLIANCE_SIGNOFF_STATUSES,
        required: true,
      },
      { kind: 'date', name: 'boardMeetingDate' },
      { kind: 'string', name: 'minuteReference', max: 200 },
      { kind: 'string', name: 'approvedByName', max: 200 },
      { kind: 'string', name: 'approvedByRole', max: 120 },
      { kind: 'string', name: 'approvalNotes', max: 2000 },
    ],
  },
  {
    name: 'annual_report_set',
    description: 'Record how ready the annual report is for a reporting year.' + CHANGES,
    path: '/api/v1/governance-registers/annual-report',
    method: 'PUT',
    level: 'write',
    model: 'AnnualReportReadiness',
    body: [
      { kind: 'integer', name: 'reportingYear', min: 2018, max: 2100, required: true },
      { kind: 'string', name: 'activitiesNarrative', max: 5000 },
      { kind: 'string', name: 'publicBenefitStatement', max: 5000 },
      { kind: 'string', name: 'beneficiariesSummary', max: 5000 },
      { kind: 'boolean', name: 'financialStatementsApproved' },
      { kind: 'boolean', name: 'annualReportUploaded' },
      { kind: 'boolean', name: 'trusteeDetailsReviewed' },
      { kind: 'boolean', name: 'fundraisingReviewed' },
      { kind: 'boolean', name: 'complaintsReviewed' },
      { kind: 'date', name: 'boardApprovalDate' },
      { kind: 'enum', name: 'filingStatus', values: ANNUAL_REPORT_FILING_STATUSES },
      { kind: 'date', name: 'filedDate' },
      { kind: 'string', name: 'notes', max: 5000 },
    ],
  },

  /* --- the minute book ----------------------------------------------------- */
  {
    name: 'resolution_create',
    description: 'Add a resolution to a meeting or written resolution in the minute book.' + CHANGES,
    path: '/api/v1/governing-acts/:id/resolutions',
    method: 'POST',
    level: 'write',
    model: 'Resolution',
    body: [
      { kind: 'string', name: 'itemNumber', max: 20 },
      { kind: 'string', name: 'text', max: 10_000, required: true },
      { kind: 'boolean', name: 'carried' },
      { kind: 'string', name: 'abstentions', max: 1000 },
      { kind: 'id', name: 'conflictRecordId' },
    ],
    params: [{ kind: 'id', name: 'id' }],
  },
  {
    name: 'resolution_update',
    description: 'Change a resolution in the minute book.' + CHANGES,
    path: '/api/v1/governing-acts/resolutions/:id',
    method: 'PATCH',
    level: 'write',
    model: 'Resolution',
    params: [{ kind: 'id', name: 'id' }],
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'string', name: 'itemNumber', max: 20 },
      { kind: 'string', name: 'text', max: 10_000 },
      { kind: 'boolean', name: 'carried' },
      { kind: 'string', name: 'abstentions', max: 1000 },
      { kind: 'id', name: 'conflictRecordId' },
    ],
  },
  {
    name: 'document_approval_set',
    description:
      'Record which resolution approved a document, or assert that the board approved it.'
      + CHANGES,
    path: '/api/v1/governing-acts/documents/:documentId/approval',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'documentId' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'id', name: 'approvedByResolutionId' },
      { kind: 'boolean', name: 'approvalAsserted' },
    ],
  },

  /* --- documents and the standards they evidence --------------------------- */
  {
    name: 'document_link_standard',
    description: 'Link a document to a Governance Code standard as evidence for it.' + CHANGES,
    path: '/api/v1/documents/:id/standards',
    method: 'POST',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns the link, not a record about anyone.',
    body: [{ kind: 'id', name: 'standardId', required: true }],
  },

  /* --- further removals, each asking a person before it happens ------------ */
  {
    name: 'deadline_delete',
    description: 'Permanently remove a deadline from the calendar.' + APPROVAL_NOTE,
    path: '/api/v1/deadlines/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'document_delete',
    description:
      'Permanently remove a document and its stored file.' + APPROVAL_NOTE,
    path: '/api/v1/documents/:id',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'document_unlink_standard',
    description:
      'Remove the link between a document and a Governance Code standard. The document itself '
      + 'is kept.' + APPROVAL_NOTE,
    path: '/api/v1/documents/:id/standards/:standardId',
    method: 'DELETE',
    level: 'admin',
    destructive: true,
    params: [
      { kind: 'id', name: 'id' },
      { kind: 'id', name: 'standardId' },
    ],
    noRecordsBecause: 'Returns a confirmation, not a record.',
  },
  {
    name: 'governing_act_void',
    description:
      'Void an entry in the minute book. The entry is kept and marked void, with the reason '
      + 'recorded, because a minute book is a legal record and is never rewritten.'
      + APPROVAL_NOTE,
    path: '/api/v1/governing-acts/:id/void',
    method: 'POST',
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    model: 'GoverningActVoid',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      {
        kind: 'string',
        name: 'reason',
        max: 2000,
        required: true,
        describe: 'Why the entry is void. Recorded in the minute book beside it.',
      },
    ],
  },

  /* --- the member register ------------------------------------------------ */
  //
  // A member register is a list of named people and where they live, so both of
  // these are offered only when the personal-data gate is open. There is no
  // useful subset: a member with no name is not a member.
  {
    name: 'member_create',
    description: 'Add a person to the charity’s member register.' + CHANGES,
    path: '/api/v1/members',
    method: 'POST',
    level: 'write',
    model: 'Member',
    body: [
      { kind: 'string', name: 'name', max: 300, required: true },
      { kind: 'string', name: 'address', max: 500 },
      { kind: 'date', name: 'dateEntered', required: true },
    ],
  },
  {
    name: 'member_update',
    description:
      'Change an entry in the member register, including recording that someone ceased to '
      + 'be a member.' + CHANGES,
    path: '/api/v1/members/:id',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    model: 'Member',
    body: [
      { kind: 'timestamp', name: 'expectedUpdatedAt', required: true, control: true, describe: CONCURRENCY },
      { kind: 'string', name: 'name', max: 300 },
      { kind: 'string', name: 'address', max: 500 },
      { kind: 'date', name: 'dateEntered' },
      { kind: 'date', name: 'dateCeased' },
    ],
  },
];
