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

const documentVisibilityValues = ['RESTRICTED', 'MEMBER_VISIBLE'] as const;
const documentContentAccessValues = ['UNASSESSED', 'MEMBER_SUITABLE', 'RESTRICTED_SENSITIVE'] as const;
const documentLifecycleValues = ['UNREVIEWED', 'DRAFT', 'CURRENT', 'SUPERSEDED', 'RETIRED', 'HISTORICAL'] as const;
const documentControlReason = z.string().trim().refine((reason) => {
  const length = Array.from(reason).length;
  return length >= 10 && length <= 500 && !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/u.test(reason);
}, 'Give a safe reason between 10 and 500 characters.');

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
    visibility: z.enum(documentVisibilityValues).optional(),
    visibilityReason: documentControlReason.optional(),
    contentAccessClass: z.enum(documentContentAccessValues).optional(),
    contentAccessReason: documentControlReason.optional(),
    lifecycleStatus: z.enum(documentLifecycleValues).optional(),
    replacementDocumentId: z.string().trim().min(1).max(100).optional(),
    lifecycleReason: documentControlReason.optional(),
    externalPublicationApproved: z.boolean().optional(),
    publicationApprovalReason: documentControlReason.optional(),
    reviewedPublicationSiteId: z.string().trim().min(1).max(200).optional(),
    reviewedPublicationSpaceId: z.string().trim().min(1).max(200).optional(),
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
    if (value.visibility && !value.visibilityReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give a reason for changing document visibility.', path: ['visibilityReason'] });
    }
    if (!value.visibility && value.visibilityReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Visibility reason requires a visibility change.', path: ['visibility'] });
    }
    if (value.contentAccessClass && !value.contentAccessReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give a reason for the content access assessment.', path: ['contentAccessReason'] });
    }
    if (!value.contentAccessClass && value.contentAccessReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Content access reason requires an assessment change.', path: ['contentAccessClass'] });
    }
    if (value.lifecycleStatus && !value.lifecycleReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give a reason for changing document lifecycle.', path: ['lifecycleReason'] });
    }
    if (!value.lifecycleStatus && value.lifecycleReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Lifecycle reason requires a lifecycle change.', path: ['lifecycleStatus'] });
    }
    if (value.lifecycleStatus === 'SUPERSEDED' && !value.replacementDocumentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose the current replacement document.', path: ['replacementDocumentId'] });
    }
    if (value.replacementDocumentId && value.lifecycleStatus !== 'SUPERSEDED') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A replacement is only set when superseding a document.', path: ['replacementDocumentId'] });
    }
    if (value.externalPublicationApproved !== undefined && !value.publicationApprovalReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give a reason for changing external publication approval.', path: ['publicationApprovalReason'] });
    }
    if (value.externalPublicationApproved === undefined && value.publicationApprovalReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Publication reason requires a publication approval change.', path: ['externalPublicationApproved'] });
    }
    if (value.externalPublicationApproved === true &&
      (!value.reviewedPublicationSiteId || !value.reviewedPublicationSpaceId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: 'Review the exact Confluence site and space before approving publication.',
        path: ['reviewedPublicationSpaceId'] });
    }
    if (value.externalPublicationApproved !== true &&
      (value.reviewedPublicationSiteId !== undefined || value.reviewedPublicationSpaceId !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: 'A reviewed destination is only supplied when approving publication.',
        path: ['reviewedPublicationSiteId'] });
    }
    // An empty body would otherwise be a successful request that changed
    // nothing, which an agent retrying a failed edit cannot tell from a
    // successful one.
    const changed = Object.keys(value).filter((key) => !['expectedUpdatedAt', 'visibilityReason', 'contentAccessReason', 'lifecycleReason', 'publicationApprovalReason', 'reviewedPublicationSiteId', 'reviewedPublicationSpaceId'].includes(key));
    if (changed.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Name at least one field to change.',
        path: [],
      });
    }
  });
