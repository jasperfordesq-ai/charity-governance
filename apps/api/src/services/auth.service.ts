import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';
import {
  hashOpaqueToken,
  issueSessionTokens,
  revokeSessionToken,
  rotateSessionTokens,
} from './session-tokens.js';
import { publicOrganisationSelect } from '../utils/public-dtos.js';

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
const REGISTRATION_ACCEPTED_MESSAGE = 'If this registration can be completed, check your email for next steps.';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createOneTimeToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

function registrationAccepted() {
  return { message: REGISTRATION_ACCEPTED_MESSAGE };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return registrationAccepted();
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    let organisation: { name: string };
    let user: { id: string; email: string; name: string };
    try {
      const created = await this.prisma.$transaction(async (tx) => {
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
          select: {
            id: true,
            email: true,
            name: true,
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

      organisation = created.organisation;
      user = created.user;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return registrationAccepted();
      }

      throw err;
    }

    const verify = createOneTimeToken();
    const verifyTokenExpiry = new Date();
    verifyTokenExpiry.setHours(verifyTokenExpiry.getHours() + VERIFY_TOKEN_EXPIRY_HOURS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { verifyToken: verify.hash, verifyTokenExpiry },
    });

    void this.emailService.sendWelcomeEmail(user.email, user.name, organisation.name);
    void this.emailService.sendEmailVerification(user.email, user.name, verify.token);

    return registrationAccepted();
  }

  async login(data: LoginData) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(data.email) },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        role: true,
        emailVerified: true,
        organisationId: true,
        organisation: { select: publicOrganisationSelect },
      },
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
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        organisationId: true,
        organisation: { select: publicOrganisationSelect },
      },
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

  async resendEmailVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    if (user.emailVerified) {
      return { message: 'Email is already verified.' };
    }

    const verify = createOneTimeToken();
    const verifyTokenExpiry = new Date();
    verifyTokenExpiry.setHours(verifyTokenExpiry.getHours() + VERIFY_TOKEN_EXPIRY_HOURS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { verifyToken: verify.hash, verifyTokenExpiry },
    });

    const sent = await this.emailService.sendEmailVerification(user.email, user.name, verify.token);
    if (!sent) {
      throw new AppError(503, 'EMAIL_DELIVERY_FAILED', 'Verification email could not be sent. Please try again later.');
    }

    return { message: 'Verification email sent.' };
  }

  async resetPassword(token: string, password: string) {
    const resetToken = hashOpaqueToken(token);
    const now = new Date();
    const user = await this.prisma.user.findFirst({
      where: {
        resetToken,
        resetTokenExpiry: { gt: now },
      },
      select: { id: true },
    });

    if (!user) {
      throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired. Please request a new one.');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.user.updateMany({
        where: {
          id: user.id,
          resetToken,
          resetTokenExpiry: { gt: now },
        },
        data: {
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });

      if (consumed.count !== 1) {
        throw new AppError(
          400,
          'INVALID_RESET_TOKEN',
          'This reset link is invalid or has expired. Please request a new one.',
        );
      }

      await tx.authSession.updateMany({
        where: {
          userId: user.id,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });
    });

    return { message: 'Password has been reset successfully.' };
  }

  async verifyEmail(token: string) {
    const verifyToken = hashOpaqueToken(token);
    const now = new Date();
    const user = await this.prisma.user.findFirst({
      where: {
        verifyToken,
        verifyTokenExpiry: { gt: now },
      },
      select: { id: true },
    });

    if (!user) {
      throw new AppError(400, 'INVALID_VERIFY_TOKEN', 'This verification link is invalid or has expired.');
    }

    const consumed = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        verifyToken,
        verifyTokenExpiry: { gt: now },
      },
      data: {
        emailVerified: true,
        verifyToken: null,
        verifyTokenExpiry: null,
      },
    });

    if (consumed.count !== 1) {
      throw new AppError(400, 'INVALID_VERIFY_TOKEN', 'This verification link is invalid or has expired.');
    }

    return { message: 'Email verified successfully.' };
  }
}
