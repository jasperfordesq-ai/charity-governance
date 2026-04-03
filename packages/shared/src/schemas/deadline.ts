import { z } from 'zod';

export const createDeadlineSchema = z.object({
  title: z.string().min(1, 'Title is required').max(300),
  description: z.string().max(1000).optional(),
  dueDate: z.string().datetime(),
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
});

export const updateDeadlineSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(1000).nullable().optional(),
  dueDate: z.string().datetime().optional(),
  isComplete: z.boolean().optional(),
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
});
