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

export const uploadDocumentSchema = z.object({
  name: z.string().min(1, 'Document name is required').max(300),
  description: z.string().max(1000).optional(),
  category: z.enum(documentCategoryValues),
  owner: z.string().trim().max(200).optional(),
  approvedDate: z.string().optional(),
  nextReviewDate: z.string().optional(),
  boardMinuteReference: z.string().trim().max(200).optional(),
});

export const linkStandardSchema = z.object({
  standardId: z.string().min(1, 'Standard ID is required'),
});
