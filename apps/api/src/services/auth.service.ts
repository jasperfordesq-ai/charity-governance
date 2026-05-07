import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';
import {
  hashOpaqueToken,
  issueSessionTokens,
  revokeSessionToken,
  revokeUserSessions,
  rotateSessionTokens,
} from './session-tokens.js';

interface RegisterData {
  email: string;
  password: string;
  name: string;
  organisationName: string;
}

interface LoginData {
  email: string;
  password: string;
}

const SALT_ROUNDS = 12;
const TRIAL_DAYS = 14;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const VERIFY_TOKEN_EXPIRY_HOURS = 24;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createOneTimeToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export class AuthService {
  private emailService: EmailService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
  ) {
    this.emailService = emailService ?? new EmailService();
  }

  async register(data: RegisterData) {
    const email = normalizeEmail(data.email);
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    const { organisation, user } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: {
          name: data.organisationName,
        },
      });

      const usr = await tx.user.create({
        data: {
          email,
          name: data.name,
          passwordHash,
          role: 'OWNER',
          organisationId: org.id,
        },
        include: {
          organisation: true,
        },
      });

      await tx.subscription.create({
        data: {
          organisationId: org.id,
          plan: 'ESSENTIALS',
          status: 'TRIALING',
          trialEndsAt,
        },
      });

      return { organisation: org, user: usr };
    });

    const tokens = await issueSessionTokens(this.prisma, user);

    const verify = createOneTimeToken();
    const verifyTokenExpiry = new Date();
    verifyTokenExpiry.setHours(verifyTokenExpiry.getHours() + VERIFY_TOKEN_EXPIRY_HOURS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { verifyToken: verify.hash, verifyTokenExpiry },
    });

    void this.emailService.sendWelcomeEmail(user.email, user.name, organisation.name);
    void this.emailService.sendEmailVerification(user.email, user.name, verify.token);

    return { user, ...tokens };
  }

  async login(data: LoginData) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(data.email) },
      include: { organisation: true },
    });

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await bcrypt.compare(data.password, user.passwordHash);

    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const tokens = await issueSessionTokens(this.prisma, user);

    return { user, ...tokens };
  }

  async refresh(refreshToken: string) {
    return rotateSessionTokens(this.prisma, refreshToken);
  }

  async logout(refreshToken: string) {
    await revokeSessionToken(this.prisma, refreshToken);
    return { message: 'Signed out successfully.' };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organisation: true },
    });

    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    return user;
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });

    if (user) {
      const reset = createOneTimeToken();
      const resetTokenExpiry = new Date();
      resetTokenExpiry.setHours(resetTokenExpiry.getHours() + RESET_TOKEN_EXPIRY_HOURS);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { resetToken: reset.hash, resetTokenExpiry },
      });

      void this.emailService.sendPasswordReset(user.email, user.name, reset.token);
    }

    return { message: 'If an account with that email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: hashOpaqueToken(token),
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired. Please request a new one.');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    await revokeUserSessions(this.prisma, user.id);

    return { message: 'Password has been reset successfully.' };
  }

  async verifyEmail(token: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        verifyToken: hashOpaqueToken(token),
        verifyTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      throw new AppError(400, 'INVALID_VERIFY_TOKEN', 'This verification link is invalid or has expired.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verifyToken: null,
        verifyTokenExpiry: null,
      },
    });

    return { message: 'Email verified successfully.' };
  }
}
