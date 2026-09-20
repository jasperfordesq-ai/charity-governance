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

/**
 * Changing a document's card, never its file.
 *
 * The stored file, its size, its type and its version number are settled at
 * upload and are absent here on purpose: replacing a file is a new upload, so
 * the storage path and the version stay honest about what is actually stored.
 *
 * Approval is absent for a different reason. `approvalAsserted` is a claim
 * that a named board resolution approved this document, and only the
 * governing-acts route can check that the resolution exists, so that is the
 * only place allowed to set it.
 *
 * A rename does not re-title a mirrored Confluence page. The mirror keeps its
 * own `pageTitle`, so the two names differing is recorded rather than hidden,
 * and re-titling a published page is a decision for the publish pipeline
 * rather than a side effect of an edit here.
 */
export const updateDocumentSchema = uploadDocumentSchema
  .partial()
  .extend({
    // Widened to nullable on the way in, because clearing a field a document
    // no longer has is the other half of being able to set it. `name` and
    // `category` stay non-nullable: a document with no name is a document
    // nobody can find again.
    description: z.string().max(1000).nullable().optional(),
    owner: z.string().trim().max(200).nullable().optional(),
    approvedDate: dateInputSchema.nullable().optional(),
    nextReviewDate: dateInputSchema.nullable().optional(),
    boardMinuteReference: z.string().trim().max(200).nullable().optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, ctx) => {
    // An empty body would otherwise be a successful request that changed
    // nothing, which an agent retrying a failed edit cannot tell from a
    // successful one.
    const changed = Object.keys(value).filter((key) => key !== 'expectedUpdatedAt');
    if (changed.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Name at least one field to change.',
        path: [],
      });
    }
  });
