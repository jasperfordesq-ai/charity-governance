import { z } from 'zod';

export const createBoardMemberSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  role: z.string().min(1, 'Role is required').max(100),
  email: z.string().email().optional(),
  appointedDate: z.string().datetime(),
  termEndDate: z.string().datetime().optional(),
  conductSigned: z.boolean().optional(),
  conductSignedDate: z.string().datetime().optional(),
  inductionCompleted: z.boolean().optional(),
  inductionDate: z.string().datetime().optional(),
});

export const updateBoardMemberSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  appointedDate: z.string().datetime().optional(),
  termEndDate: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
  conductSigned: z.boolean().optional(),
  conductSignedDate: z.string().datetime().nullable().optional(),
  inductionCompleted: z.boolean().optional(),
  inductionDate: z.string().datetime().nullable().optional(),
});
