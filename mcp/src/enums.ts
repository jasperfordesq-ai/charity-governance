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
