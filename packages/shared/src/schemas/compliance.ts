import { z } from 'zod';

const complianceStatusValues = [
  'COMPLIANT',
  'WORKING_TOWARDS',
  'NOT_STARTED',
  'NOT_APPLICABLE',
  'EXPLAIN',
] as const;

const complianceSignoffStatusValues = ['DRAFT', 'BOARD_REVIEW', 'APPROVED'] as const;

const nullableTrimmedString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

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

export const upsertComplianceRecordSchema = z.object({
  reportingYear: z.number().int().min(2018).max(2100),
  status: z.enum(complianceStatusValues).optional(),
  actionTaken: z.string().max(5000).nullable().optional(),
  evidence: z.string().max(5000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  explanationIfNA: z.string().max(5000).nullable().optional(),
});

export const complianceQuerySchema = z.object({
  year: z.coerce.number().int().min(2018).max(2100),
});

export const upsertComplianceSignoffSchema = z
  .object({
    reportingYear: z.number().int().min(2018).max(2100),
    status: z.enum(complianceSignoffStatusValues),
    boardMeetingDate: nullableDateInputSchema,
    minuteReference: nullableTrimmedString(200),
    approvedByName: nullableTrimmedString(200),
    approvedByRole: nullableTrimmedString(120),
    approvalNotes: nullableTrimmedString(2000),
  })
  .superRefine((value, ctx) => {
    if (value.status !== 'APPROVED') return;

    for (const field of ['boardMeetingDate', 'minuteReference', 'approvedByName'] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Required when marking the Compliance Record as approved',
        });
      }
    }
  });
