import { z } from 'zod';

const dateInputSchema = z.string().refine(
  (value) =>
    (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) &&
    !Number.isNaN(Date.parse(value)),
  'Date must be an ISO date or datetime',
);

export const createBoardMemberSchema = z.object({
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

export const updateBoardMemberSchema = z.object({
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
