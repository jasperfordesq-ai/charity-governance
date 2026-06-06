import { z } from 'zod';

const documentCategoryValues = [
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

const dateInputSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
  'Date must be an ISO date or datetime',
);

export const uploadDocumentSchema = z.object({
  name: z.string().min(1, 'Document name is required').max(300),
  description: z.string().max(1000).optional(),
  category: z.enum(documentCategoryValues),
  owner: z.string().trim().max(200).optional(),
  approvedDate: dateInputSchema.optional(),
  nextReviewDate: dateInputSchema.optional(),
  boardMinuteReference: z.string().trim().max(200).optional(),
});

export const linkStandardSchema = z.object({
  standardId: z.string().min(1, 'Standard ID is required'),
});
