import { z } from 'zod';
import { dateInputSchema } from './date.js';

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
