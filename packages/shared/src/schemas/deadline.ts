import { z } from 'zod';

const dateInputSchema = z.string().refine(
  (value) =>
    (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) &&
    !Number.isNaN(Date.parse(value)),
  'Date must be an ISO date or datetime',
);

export const createDeadlineSchema = z.object({
  title: z.string().min(1, 'Title is required').max(300),
  description: z.string().max(1000).optional(),
  dueDate: dateInputSchema,
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
});

export const updateDeadlineSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(1000).nullable().optional(),
  dueDate: dateInputSchema.optional(),
  isComplete: z.boolean().optional(),
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
});
