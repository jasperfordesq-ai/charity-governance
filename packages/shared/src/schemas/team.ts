import { z } from 'zod';
import { withBcryptPasswordByteLimit } from './password.js';

const assignableRoleValues = ['ADMIN', 'MEMBER'] as const;

export function normalizeTeamGovernanceReason(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export const teamGovernanceReasonSchema = z
  .string()
  .transform(normalizeTeamGovernanceReason)
  .pipe(
    z
      .string()
      .min(10, 'Give a reason of at least 10 characters')
      .max(500, 'Reason must be at most 500 characters')
      .refine(
        (value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value),
        'Reason contains unsupported control characters',
      ),
  );
const membershipVersion = z.number().int().positive();

export const inviteTeamMemberSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

export const acceptTeamInviteSchema = z.object({
  token: z.string().min(1, 'Invite token is required'),
  name: z.string().min(1, 'Name is required').max(200),
  password: withBcryptPasswordByteLimit(
    z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be at most 128 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
  ),
});

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(assignableRoleValues),
  expectedMembershipVersion: membershipVersion,
  reason: teamGovernanceReasonSchema,
});

export const teamMemberLifecycleActionSchema = z.object({
  expectedMembershipVersion: membershipVersion,
  reason: teamGovernanceReasonSchema,
});

export const transferTeamOwnershipSchema = z.object({
  targetMemberId: z.string().min(1).max(160),
  expectedCurrentOwnerVersion: membershipVersion,
  expectedTargetVersion: membershipVersion,
  confirmation: z.literal('TRANSFER OWNERSHIP'),
  reason: teamGovernanceReasonSchema,
});

export const revokeTeamSessionSchema = z.object({
  expectedMembershipVersion: membershipVersion,
  reason: teamGovernanceReasonSchema,
});

export const revokeTeamInviteSchema = z.object({
  reason: teamGovernanceReasonSchema,
});
