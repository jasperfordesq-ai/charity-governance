import { z } from 'zod';
import { dateInputSchema, nullableDateInputSchema } from './date.js';

const governingActKindValues = [
  'BOARD_MEETING',
  'DIRECTORS_WRITTEN_RESOLUTION',
  'MEMBER_WRITTEN_RESOLUTION',
  'ANNUAL_GENERAL_MEETING',
  'EXTRAORDINARY_GENERAL_MEETING',
] as const;

const governingActStatusValues = [
  'SCHEDULED',
  'HELD',
  'DRAFT',
  'CIRCULATED',
  'APPROVED',
  'SUPERSEDED',
] as const;

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

export const createGoverningActSchema = z.object({
  kind: z.enum(governingActKindValues),
  status: z.enum(governingActStatusValues).optional(),
  actDate: dateInputSchema,
  reference: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  statutoryBasis: nullableText(300),
  approvedAtActId: nullableText(100),
  approvedAt: nullableDateInputSchema,
  documentId: nullableText(100),
  notes: nullableText(5000),
});

export const updateGoverningActSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  kind: z.enum(governingActKindValues).optional(),
  status: z.enum(governingActStatusValues).optional(),
  actDate: dateInputSchema.optional(),
  reference: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  statutoryBasis: nullableText(300),
  approvedAtActId: nullableText(100),
  approvedAt: nullableDateInputSchema,
  documentId: nullableText(100),
  notes: nullableText(5000),
});

export const createResolutionSchema = z.object({
  itemNumber: nullableText(20),
  text: z.string().trim().min(1).max(10000),
  carried: z.boolean().optional(),
  abstentions: nullableText(1000),
  conflictRecordId: nullableText(100),
});

export const updateResolutionSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  itemNumber: nullableText(20),
  text: z.string().trim().min(1).max(10000).optional(),
  carried: z.boolean().optional(),
  abstentions: nullableText(1000),
  conflictRecordId: nullableText(100),
});

export const setDocumentApprovalSchema = z
  .object({
    approvedByResolutionId: z.string().nullable().optional(),
    approvalAsserted: z.boolean().optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    // Enforce rule 1: no approval without a resolution. The only safe path
    // without a resolution is approvalAsserted=true (which the UI shows as
    // "asserted, not evidenced"). approvedByResolutionId=null without
    // approvalAsserted is the unmodified state, not an approval.
    if (value.approvedByResolutionId === null && value.approvalAsserted !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedByResolutionId'],
        message:
          'A document cannot be marked approved without a Resolution. To record an unverified claim, set approvalAsserted to true instead.',
      });
    }
  });

export const governingActQuerySchema = z.object({
  // Omitted year means EVERY year. A minute book that silently shows only the
  // current year is how a false record goes unnoticed; callers that want one
  // year must ask for it.
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  kind: z.enum(governingActKindValues).optional(),
  status: z.enum(governingActStatusValues).optional(),
});

/**
 * Removing a governing act destroys a statutory record, so the reason is
 * mandatory and has to be a sentence someone can be held to - not "wrong" or
 * "oops". It is retained in the audit trail alongside a full snapshot.
 */
export const voidGoverningActSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  reason: z
    .string()
    .trim()
    .min(20, 'Give a reason of at least 20 characters explaining why this record is being removed')
    .max(2000),
});

export type CreateGoverningActRequest = z.infer<typeof createGoverningActSchema>;
export type UpdateGoverningActRequest = z.infer<typeof updateGoverningActSchema>;
export type CreateResolutionRequest = z.infer<typeof createResolutionSchema>;
export type UpdateResolutionRequest = z.infer<typeof updateResolutionSchema>;
export type SetDocumentApprovalRequest = z.infer<typeof setDocumentApprovalSchema>;
export type GoverningActQuery = z.infer<typeof governingActQuerySchema>;
export type VoidGoverningActRequest = z.infer<typeof voidGoverningActSchema>;
