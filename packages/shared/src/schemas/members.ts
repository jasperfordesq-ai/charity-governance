import { z } from 'zod';
import { dateInputSchema } from './date.js';

export const createMemberSchema = z.object({
  name: z.string().min(1, 'Name is required').max(300),
  address: z.string().max(500).optional(),
  dateEntered: dateInputSchema,
});

export const updateMemberSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  name: z.string().min(1).max(300).optional(),
  address: z.string().max(500).nullable().optional(),
  dateEntered: dateInputSchema.optional(),
  dateCeased: dateInputSchema.nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.dateCeased && data.dateEntered && data.dateCeased < data.dateEntered) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dateCeased'],
      message: 'Date ceased must be on or after the date entered',
    });
  }
});
