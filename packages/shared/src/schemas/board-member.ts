import { z } from 'zod';
import { dateInputSchema } from './date.js';

type CompleteDateInput = string | Date;

type BoardMemberInvariantState = {
  appointedDate: CompleteDateInput;
  termEndDate?: CompleteDateInput | null;
  conductSigned: boolean;
  conductSignedDate?: CompleteDateInput | null;
  inductionCompleted: boolean;
  inductionDate?: CompleteDateInput | null;
};

const completeDateInputSchema = z.union([dateInputSchema, z.date()]);

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function dateInputTime(value: CompleteDateInput) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function addBooleanDateInvariantIssue(
  value: BoardMemberInvariantState,
  booleanField: 'conductSigned' | 'inductionCompleted',
  dateField: 'conductSignedDate' | 'inductionDate',
  label: string,
  ctx: z.RefinementCtx,
) {
  if (value[booleanField] !== (value[dateField] != null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [dateField],
      message: `${label} must exactly match whether its date is present`,
    });
  }
}

function refineBoardMemberCompleteState(
  value: BoardMemberInvariantState,
  ctx: z.RefinementCtx,
) {
  if (
    value.termEndDate != null &&
    dateInputTime(value.termEndDate) < dateInputTime(value.appointedDate)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['termEndDate'],
      message: 'Term end date must be on or after the appointment date',
    });
  }

  addBooleanDateInvariantIssue(
    value,
    'conductSigned',
    'conductSignedDate',
    'Conduct signed status',
    ctx,
  );
  addBooleanDateInvariantIssue(
    value,
    'inductionCompleted',
    'inductionDate',
    'Induction completed status',
    ctx,
  );
}

export const boardMemberCompleteStateSchema = z
  .object({
    appointedDate: completeDateInputSchema,
    termEndDate: completeDateInputSchema.nullable().optional(),
    conductSigned: z.boolean().default(false),
    conductSignedDate: completeDateInputSchema.nullable().optional(),
    inductionCompleted: z.boolean().default(false),
    inductionDate: completeDateInputSchema.nullable().optional(),
  })
  .superRefine(refineBoardMemberCompleteState);

export function validateBoardMemberCompleteState(value: unknown) {
  return boardMemberCompleteStateSchema.parse(value);
}

const boardMemberInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  role: z.string().min(1, 'Role is required').max(100),
  email: z.string().email().optional(),
  appointedDate: dateInputSchema,
  termEndDate: dateInputSchema.optional(),
  conductSigned: z.boolean().optional(),
  conductSignedDate: dateInputSchema.optional(),
  inductionCompleted: z.boolean().optional(),
  inductionDate: dateInputSchema.optional(),
});

export const createBoardMemberSchema = boardMemberInputSchema.superRefine(
  (value, ctx) => {
    refineBoardMemberCompleteState(
      {
        ...value,
        conductSigned: value.conductSigned ?? false,
        inductionCompleted: value.inductionCompleted ?? false,
      },
      ctx,
    );
  },
);

const boardMemberPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  appointedDate: dateInputSchema.optional(),
  termEndDate: dateInputSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  conductSigned: z.boolean().optional(),
  conductSignedDate: dateInputSchema.nullable().optional(),
  inductionCompleted: z.boolean().optional(),
  inductionDate: dateInputSchema.nullable().optional(),
});

export const updateBoardMemberSchema = boardMemberPatchSchema.superRefine(
  (value, ctx) => {
    if (
      hasOwn(value, 'appointedDate') &&
      hasOwn(value, 'termEndDate') &&
      value.appointedDate !== undefined &&
      value.termEndDate != null &&
      dateInputTime(value.termEndDate) < dateInputTime(value.appointedDate)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['termEndDate'],
        message: 'Term end date must be on or after the appointment date',
      });
    }

    if (
      hasOwn(value, 'conductSigned') &&
      hasOwn(value, 'conductSignedDate') &&
      value.conductSigned !== undefined
    ) {
      addBooleanDateInvariantIssue(
        {
          appointedDate: '1970-01-01',
          conductSigned: value.conductSigned,
          conductSignedDate: value.conductSignedDate,
          inductionCompleted: false,
        },
        'conductSigned',
        'conductSignedDate',
        'Conduct signed status',
        ctx,
      );
    }

    if (
      hasOwn(value, 'inductionCompleted') &&
      hasOwn(value, 'inductionDate') &&
      value.inductionCompleted !== undefined
    ) {
      addBooleanDateInvariantIssue(
        {
          appointedDate: '1970-01-01',
          conductSigned: false,
          inductionCompleted: value.inductionCompleted,
          inductionDate: value.inductionDate,
        },
        'inductionCompleted',
        'inductionDate',
        'Induction completed status',
        ctx,
      );
    }
  },
);
