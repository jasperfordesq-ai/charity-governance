import { z } from 'zod';
import { withBcryptPasswordByteLimit } from './password.js';

export const MAX_ACCOUNT_EMAIL_LENGTH = 254;
export const accountEmailSchema = z
  .string()
  .max(MAX_ACCOUNT_EMAIL_LENGTH, 'Email address must be at most 254 characters')
  .email('Invalid email address');

export const registerSchema = z.object({
  email: accountEmailSchema,
  password: withBcryptPasswordByteLimit(
    z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be at most 128 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
  ),
  name: z.string().min(1, 'Name is required').max(200),
  organisationName: z.string().min(1, 'Organisation name is required').max(300),
});

export const loginSchema = z.object({
  email: accountEmailSchema,
  password: withBcryptPasswordByteLimit(z.string().min(1, 'Password is required')),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required').optional(),
});

export const forgotPasswordSchema = z.object({
  email: accountEmailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: withBcryptPasswordByteLimit(
    z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128)
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
  ),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});
