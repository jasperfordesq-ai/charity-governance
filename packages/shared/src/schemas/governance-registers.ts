import { z } from 'zod';

const registerStatusValues = ['OPEN', 'MONITORING', 'CLOSED'] as const;
const conflictStatusValues = ['DECLARED', 'MANAGED', 'CLOSED'] as const;
const riskCategoryValues = [
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
const annualReportFilingStatusValues = ['NOT_STARTED', 'IN_PROGRESS', 'BOARD_APPROVED', 'FILED'] as const;

const dateInputSchema = z.string().refine(
  (value) =>
    (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) &&
    !Number.isNaN(Date.parse(value)),
  'Date must be an ISO date or datetime',
);

const nullableDateInputSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === '' ||
      ((/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) &&
        !Number.isNaN(Date.parse(value))),
    'Date must be an ISO date or datetime',
  )
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value));

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

export const createConflictRecordSchema = z.object({
  boardMemberId: nullableText(100),
  trusteeName: z.string().trim().min(1).max(200),
  matter: z.string().trim().min(1).max(300),
  nature: z.string().trim().min(1).max(3000),
  dateDeclared: dateInputSchema,
  meetingDate: nullableDateInputSchema,
  actionTaken: z.string().trim().min(1).max(3000),
  decision: nullableText(3000),
  status: z.enum(conflictStatusValues).optional(),
  minuteReference: nullableText(200),
  nextReviewDate: nullableDateInputSchema,
});

export const updateConflictRecordSchema = createConflictRecordSchema.partial();

export const createRiskRecordSchema = z.object({
  title: z.string().trim().min(1).max(300),
  category: z.enum(riskCategoryValues),
  description: z.string().trim().min(1).max(3000),
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  mitigation: z.string().trim().min(1).max(3000),
  owner: nullableText(200),
  reviewDate: nullableDateInputSchema,
  status: z.enum(registerStatusValues).optional(),
  boardMinuteReference: nullableText(200),
});

export const updateRiskRecordSchema = createRiskRecordSchema.partial();

export const createComplaintRecordSchema = z.object({
  receivedDate: dateInputSchema,
  source: nullableText(200),
  summary: z.string().trim().min(1).max(3000),
  actionTaken: nullableText(3000),
  outcome: nullableText(3000),
  status: z.enum(registerStatusValues).optional(),
  reviewedByBoard: z.boolean().optional(),
  boardMinuteReference: nullableText(200),
});

export const updateComplaintRecordSchema = createComplaintRecordSchema.partial();

export const createFundraisingRecordSchema = z.object({
  name: z.string().trim().min(1).max(300),
  activityType: z.string().trim().min(1).max(200),
  startDate: nullableDateInputSchema,
  endDate: nullableDateInputSchema,
  publicFacing: z.boolean().optional(),
  thirdPartyFundraiser: nullableText(300),
  controls: nullableText(3000),
  complaintsReceived: z.boolean().optional(),
  reviewOutcome: nullableText(3000),
  status: z.enum(registerStatusValues).optional(),
  boardMinuteReference: nullableText(200),
});

export const updateFundraisingRecordSchema = createFundraisingRecordSchema.partial();

export const upsertAnnualReportReadinessSchema = z.object({
  reportingYear: z.number().int().min(2018).max(2100),
  activitiesNarrative: nullableText(5000),
  publicBenefitStatement: nullableText(5000),
  beneficiariesSummary: nullableText(5000),
  financialStatementsApproved: z.boolean().optional(),
  annualReportUploaded: z.boolean().optional(),
  trusteeDetailsReviewed: z.boolean().optional(),
  fundraisingReviewed: z.boolean().optional(),
  complaintsReviewed: z.boolean().optional(),
  boardApprovalDate: nullableDateInputSchema,
  filingStatus: z.enum(annualReportFilingStatusValues).optional(),
  filedDate: nullableDateInputSchema,
  notes: nullableText(5000),
});

export const upsertFinancialControlReviewSchema = z.object({
  reportingYear: z.number().int().min(2018).max(2100),
  bankReconciliationsReviewed: z.boolean().optional(),
  dualAuthorisation: z.boolean().optional(),
  budgetApproved: z.boolean().optional(),
  managementAccountsReviewed: z.boolean().optional(),
  reservesReviewed: z.boolean().optional(),
  restrictedFundsReviewed: z.boolean().optional(),
  assetsInsuranceReviewed: z.boolean().optional(),
  payrollControlsReviewed: z.boolean().optional(),
  fundraisingControlsReviewed: z.boolean().optional(),
  reviewedBy: nullableText(200),
  reviewDate: nullableDateInputSchema,
  minuteReference: nullableText(200),
  actions: nullableText(5000),
});
