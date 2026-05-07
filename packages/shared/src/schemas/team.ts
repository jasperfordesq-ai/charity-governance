import { z } from 'zod';

const roleValues = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export const inviteTeamMemberSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

export const acceptTeamInviteSchema = z.object({
  token: z.string().min(1, 'Invite token is required'),
  name: z.string().min(1, 'Name is required').max(200),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(roleValues),
});
