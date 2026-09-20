/**
 * Enumerations the API accepts, shared by the read and write tool lists.
 *
 * They live apart from both so neither has to import the other at run time.
 */
export const GOVERNING_ACT_KINDS = [
  'BOARD_MEETING',
  'DIRECTORS_WRITTEN_RESOLUTION',
  'MEMBER_WRITTEN_RESOLUTION',
  'ANNUAL_GENERAL_MEETING',
  'EXTRAORDINARY_GENERAL_MEETING',
] as const;

export const GOVERNING_ACT_STATUSES = [
  'SCHEDULED',
  'HELD',
  'DRAFT',
  'CIRCULATED',
  'APPROVED',
  'SUPERSEDED',
] as const;

export const REGISTER_STATUSES = ['OPEN', 'MONITORING', 'CLOSED'] as const;

export const CONFLICT_STATUSES = ['DECLARED', 'MANAGED', 'CLOSED'] as const;

export const RISK_CATEGORIES = [
  'GOVERNANCE',
  'FINANCIAL',
  'OPERATIONAL',
  'LEGAL',
  'SAFEGUARDING',
  'REPUTATIONAL',
  'FUNDRAISING',
  'DATA_PROTECTION',
  'OTHER',
] as const;

export const COMPLIANCE_STATUSES = [
  'COMPLIANT',
  'WORKING_TOWARDS',
  'NOT_STARTED',
  'NOT_APPLICABLE',
  'EXPLAIN',
] as const;

export const DIRECTOR_APPOINTMENT_KINDS = ['BOARD', 'MEMBERS'] as const;

export const DOCUMENT_CATEGORIES = [
  'CONSTITUTION',
  'POLICY',
  'BOARD_MINUTES',
  'FINANCIAL_STATEMENT',
  'INSURANCE',
  'ANNUAL_REPORT',
  'RISK_REGISTER',
  'CODE_OF_CONDUCT',
  'STRATEGIC_PLAN',
  'OTHER',
] as const;

export const COMPLIANCE_SIGNOFF_STATUSES = ['DRAFT', 'BOARD_REVIEW', 'APPROVED'] as const;

/** Mirrors the status filter the reminder-history route validates by hand. */
export const DEADLINE_REMINDER_STATUSES = [
  'RESERVED',
  'SENT',
  'SKIPPED',
  'FAILED',
  'SENDING',
  'UNCERTAIN',
] as const;

/** The two roles a colleague can be given. OWNER is transferred, never assigned. */
export const ASSIGNABLE_TEAM_ROLES = ['ADMIN', 'MEMBER'] as const;

export const ANNUAL_REPORT_FILING_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'BOARD_APPROVED',
  'FILED',
] as const;

export const LEGAL_FORMS = ['CLG', 'TRUST', 'UNINCORPORATED_ASSOCIATION', 'OTHER'] as const;

export const ORGANISATION_COMPLEXITIES = ['SIMPLE', 'COMPLEX'] as const;
