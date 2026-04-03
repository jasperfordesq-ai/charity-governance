import type { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type TokenPayload,
} from '../utils/jwt.js';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';

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

export class AuthService {
  private emailService: EmailService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
  ) {
    this.emailService = emailService ?? new EmailService();
  }

  async register(data: RegisterData) {
    const existing = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existing) {
      throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    // Transaction ensures org, user, and subscription are created atomically
    const { organisation, user } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: {
          name: data.organisationName,
        },
      });

      const usr = await tx.user.create({
        data: {
          email: data.email,
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

    const tokenPayload: TokenPayload = {
      userId: user.id,
      organisationId: organisation.id,
      role: user.role,
    };

    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    // Generate email verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenExpiry = new Date();
    verifyTokenExpiry.setHours(verifyTokenExpiry.getHours() + VERIFY_TOKEN_EXPIRY_HOURS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { verifyToken, verifyTokenExpiry },
    });

    // Fire-and-forget emails — do not await, failure must not block registration
    void this.emailService.sendWelcomeEmail(user.email, user.name, organisation.name);
    void this.emailService.sendEmailVerification(user.email, user.name, verifyToken);

    return { user, accessToken, refreshToken };
  }

  async login(data: LoginData) {
    const user = await this.prisma.user.findUnique({
      where: { email: data.email },
      include: { organisation: true },
    });

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await bcrypt.compare(data.password, user.passwordHash);

    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const tokenPayload: TokenPayload = {
      userId: user.id,
      organisationId: user.organisationId,
      role: user.role,
    };

    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return { user, accessToken, refreshToken };
  }

  async refresh(refreshToken: string) {
    let payload: TokenPayload;

    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }

    // Verify the user still exists
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      throw new AppError(401, 'USER_NOT_FOUND', 'User no longer exists');
    }

    const tokenPayload: TokenPayload = {
      userId: user.id,
      organisationId: user.organisationId,
      role: user.role,
    };

    const newAccessToken = signAccessToken(tokenPayload);
    const newRefreshToken = signRefreshToken(tokenPayload);

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
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
      where: { email },
    });

    // Always return success to prevent email enumeration
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date();
      resetTokenExpiry.setHours(resetTokenExpiry.getHours() + RESET_TOKEN_EXPIRY_HOURS);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { resetToken, resetTokenExpiry },
      });

      void this.emailService.sendPasswordReset(user.email, user.name, resetToken);
    }

    return { message: 'If an account with that email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: token,
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

    return { message: 'Password has been reset successfully.' };
  }

  async verifyEmail(token: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        verifyToken: token,
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
