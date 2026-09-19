import { z } from 'zod';
import { dateInputSchema } from './date.js';

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
  // Trimmed, like its `owner` and `boardMinuteReference` siblings below. An
  // untrimmed name reaches Confluence as an untrimmed page title, and a title
  // a page store rewrites is a title the next publish attempt cannot find
  // again. This narrows the input; it does not close it (an embedded newline
  // still passes here), which is why `publicationTitle` normalises
  // independently and is where the guarantee actually lives.
  name: z.string().trim().min(1, 'Document name is required').max(300),
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
