import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/errors.js';
import { EmailService } from './email.service.js';
import {
  hashOpaqueToken,
  issueLoginSessionTokens,
  revokeSessionToken,
  rotateSessionTokens,
} from './session-tokens.js';
import { publicOrganisationSelect } from '../utils/public-dtos.js';
import {
  PasswordRecoveryService,
  mapPasswordRecoveryInfrastructureError,
  type PasswordRecoveryRequestContext,
} from './password-recovery.service.js';

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
// A valid bcrypt hash (cost 12) of an unguessable value. It is never expected to
// match; its only purpose is to spend the same hashing time on the no-user login
// path as on the real path, so an attacker cannot enumerate accounts by comparing
// response latency (timing-based user enumeration). Mirrors register()'s balanced
// timing, which hashes before its existence check.
const DUMMY_PASSWORD_HASH = '$2b$12$5x1wZg/1s7XL/AUM6hR6OeX6zHNP.H0FgxiRa5EDVKtm6RFwhiVdK';
const TRIAL_DAYS = 14;
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

function hasActiveLifecycle(principal: {
  lifecycleStatus?: string;
  organisation?: { lifecycleStatus?: string };
}): boolean {
  // Prisma always returns both selected lifecycle fields. Optionality keeps
  // narrow service adapters and older test doubles source-compatible without
  // weakening the database query and transaction guards used in production.
  return (
    (principal.lifecycleStatus === undefined || principal.lifecycleStatus === 'ACTIVE') &&
    (principal.organisation?.lifecycleStatus === undefined ||
      principal.organisation.lifecycleStatus === 'ACTIVE')
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class AuthService {
  private emailService: EmailService;
  private passwordRecoveryService: PasswordRecoveryService;

  constructor(
    private prisma: PrismaClient,
    emailService?: EmailService,
    passwordRecoveryService?: PasswordRecoveryService,
  ) {
    this.emailService = emailService ?? new EmailService();
    this.passwordRecoveryService = passwordRecoveryService ?? new PasswordRecoveryService(prisma);
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
        lifecycleStatus: true,
        organisationId: true,
        organisation: {
          select: {
            ...publicOrganisationSelect,
            lifecycleStatus: true,
          },
        },
      },
    });

    if (!user) {
      // Spend the same bcrypt cost as the real path before failing, so the
      // response timing does not reveal whether the account exists.
      await bcrypt.compare(data.password, DUMMY_PASSWORD_HASH);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await bcrypt.compare(data.password, user.passwordHash);

    if (
      !valid ||
      !hasActiveLifecycle(user)
    ) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Bind issuance to the exact bcrypt credential checked above. The session
    // transaction rechecks it while holding the principal lock shared with
    // password-reset serialization, so an old password can never mint a live
    // session after a reset has committed.
    const tokens = await issueLoginSessionTokens(this.prisma, user);

    return { user, ...tokens };
  }

  async refresh(refreshToken: string) {
    return rotateSessionTokens(this.prisma, refreshToken);
  }

  async logout(refreshToken: string) {
    await revokeSessionToken(this.prisma, refreshToken, 'LOGOUT');
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
        lifecycleStatus: true,
        organisation: {
          select: {
            ...publicOrganisationSelect,
            lifecycleStatus: true,
          },
        },
      },
    });

    if (!user || !hasActiveLifecycle(user)) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    return user;
  }

  async forgotPassword(email: string, context: PasswordRecoveryRequestContext) {
    try {
      return await this.passwordRecoveryService.requestPasswordReset(email, context);
    } catch (error) {
      throw mapPasswordRecoveryInfrastructureError(error);
    }
  }

  async resendEmailVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        lifecycleStatus: true,
        organisation: { select: { lifecycleStatus: true } },
      },
    });

    if (!user || !hasActiveLifecycle(user)) {
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

  async resetPassword(
    token: string,
    password: string,
    context: PasswordRecoveryRequestContext,
  ) {
    try {
      return await this.passwordRecoveryService.resetPassword(token, password, context);
    } catch (error) {
      throw mapPasswordRecoveryInfrastructureError(error);
    }
  }

  async verifyEmail(token: string) {
    const verifyToken = hashOpaqueToken(token);
    const now = new Date();
    const user = await this.prisma.user.findFirst({
      where: {
        verifyToken,
        verifyTokenExpiry: { gt: now },
        lifecycleStatus: 'ACTIVE',
        organisation: { lifecycleStatus: 'ACTIVE' },
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
        lifecycleStatus: 'ACTIVE',
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
