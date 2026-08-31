import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { hashOpaqueToken } from './session-tokens.js';
import { EmailService } from './email.service.js';
import { SECURITY_EMAIL_TEMPLATE_VERSION } from './security-email-templates.js';

const VERIFY_TOKEN_HOURS = 48;
// PasswordRecoveryRequest_timeline_check (migrations/20260712013000_add_password_recovery_integrity)
// caps every recovery row's expiresAt at createdAt + 1 hour, matching
// RESET_EXPIRY_MS in password-recovery.service.ts. If this link expires before
// the new owner opens it, the existing self-service "Forgot password" flow at
// /forgot-password works for this account the same as any other.
const RESET_TOKEN_HOURS = 1;

// The subset of EmailService this module calls. Kept narrow and structural
// (not `EmailService` itself) so tests can inject a plain stub without
// constructing the real class.
export type OwnerProvisioningEmailService = Pick<
  EmailService,
  'sendWelcomeEmail' | 'sendEmailVerification' | 'sendPasswordRecoveryEmail'
>;

// auth.service.ts has an equivalent isUniqueConstraintError(), but it is not
// exported, so this mirrors its implementation rather than reaching into that
// module's private surface.
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function provisionTenant(
  prisma: PrismaClient,
  input: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    trialDays: number;
  },
  emailService: OwnerProvisioningEmailService = new EmailService(),
): Promise<{ organisationId: string; userId: string }> {
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) {
    throw new AppError(400, 'INVALID_TRIAL_DAYS', 'Trial length must be at least one day');
  }

  const email = input.ownerEmail.trim().toLowerCase();
  const ownerName = input.ownerName;
  const verifyToken = crypto.randomBytes(32).toString('base64url');
  const verifyTokenHash = hashOpaqueToken(verifyToken);

  // A second one-time token, alongside the verify token, that lets the
  // provisioned owner set a real password. Hash stored, raw emailed — the
  // same shape as the verify token above. It resolves through the ordinary
  // /reset-password page (services/password-recovery.service.ts's
  // resetPassword, which looks a PasswordRecoveryRequest row up by the sha256
  // of the presented token — hashOpaqueToken and that lookup's
  // hashPasswordRecoveryToken are the same sha256-hex digest). This bypasses
  // the self-service request-a-reset rate-limited entry point on purpose:
  // there is no anonymous-attacker enumeration risk to defend against when a
  // trusted, authenticated operator is issuing a link for an account it just
  // created, and jobs/personal-server-account.ts's issuePersonalServerResetLink
  // establishes the same direct-insert pattern for an equivalent operator-only
  // case.
  const resetToken = crypto.randomBytes(32).toString('base64url');
  const resetTokenHash = hashOpaqueToken(resetToken);

  // The operator never chooses another person's credential: a random secret is
  // hashed and discarded, and the owner sets a real password via the link.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');
  const passwordHash = await bcrypt.hash(unusablePassword, 10);

  const trialEndsAt = new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000);
  const verifyTokenExpiry = new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000);
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  const created = await prisma.$transaction(async (tx) => {
    // The duplicate check happens INSIDE the transaction, alongside the
    // organisation/user/subscription writes, so a concurrent provision of the
    // same email cannot race past this check and leave a partial organisation
    // behind: register() elsewhere silently no-ops on a taken email to avoid
    // enumeration, but a trusted operator must see a real 409 instead.
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'That email already belongs to an account');
    }

    const organisation = await tx.organisation.create({ data: { name: input.organisationName } });

    // The pre-check above narrows the common case, but under READ COMMITTED
    // two concurrent provisionTenant calls for the same email can both pass
    // it before either commits. The loser's create then violates User.email's
    // unique constraint (P2002) — that must surface as the same 409 the
    // pre-check produces, not a raw 500, since the transaction still rolls
    // back cleanly and no partial organisation is left behind.
    let user: { id: string };
    try {
      user = await tx.user.create({
        data: {
          email,
          name: ownerName,
          passwordHash,
          role: 'OWNER',
          organisationId: organisation.id,
          emailVerified: false,
          verifyToken: verifyTokenHash,
          verifyTokenExpiry,
        },
        select: { id: true },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'That email already belongs to an account');
      }
      throw err;
    }

    await tx.subscription.create({
      data: { organisationId: organisation.id, plan: input.plan, status: 'TRIALING', trialEndsAt },
    });

    const now = new Date();
    await tx.passwordRecoveryRequest.create({
      data: {
        source: 'OWNER_PROVISIONED',
        organisationId: organisation.id,
        userId: user.id,
        tokenHash: resetTokenHash,
        recipientEmail: email,
        recipientName: ownerName,
        deliveryTemplateVersion: SECURITY_EMAIL_TEMPLATE_VERSION,
        deliveryState: 'ACCEPTED',
        deliveryFinalizedAt: now,
        deliveryAttemptCount: 0,
        expiresAt: resetTokenExpiry,
        createdAt: now,
        updatedAt: now,
      },
    });

    return { organisationId: organisation.id, userId: user.id };
  });

  // Sent only after the transaction commits: a rolled-back provision (a
  // concurrent duplicate email, for instance) must never trigger mail for an
  // organisation that does not exist. Fire-and-forget, matching
  // AuthService.register — email delivery failure must not fail provisioning,
  // which already succeeded and committed.
  void emailService.sendWelcomeEmail(email, ownerName, input.organisationName);
  void emailService.sendEmailVerification(email, ownerName, verifyToken);
  void emailService.sendPasswordRecoveryEmail(email, ownerName, resetToken, {
    idempotencyKey: crypto.randomUUID(),
    templateVersion: SECURITY_EMAIL_TEMPLATE_VERSION,
  });

  return created;
}
