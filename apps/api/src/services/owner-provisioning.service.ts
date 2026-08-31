import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { hashOpaqueToken } from './session-tokens.js';
import { EmailService } from './email.service.js';
import { SECURITY_EMAIL_TEMPLATE_VERSION } from './security-email-templates.js';
import { emailDeliveryMode, manualAuthLinkUrl } from '../utils/deployment-profile.js';

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
    // Route schema (routes/owner/tenants.ts) enforces the pairing —
    // trialDays required iff billing === 'trial', forbidden for 'comped' —
    // before this service is ever reached. The service still guards the
    // 'trial' arm itself (INVALID_TRIAL_DAYS below) for any direct caller
    // that bypasses the route, e.g. this file's own tests.
    billing?: 'trial' | 'comped';
    trialDays?: number;
  },
  emailService: OwnerProvisioningEmailService = new EmailService(),
): Promise<{
  organisationId: string;
  userId: string;
  links?: { setPassword: string; verifyEmail: string };
}> {
  const billing = input.billing ?? 'trial';
  let trialEndsAt: Date | null = null;
  if (billing === 'trial') {
    if (!Number.isInteger(input.trialDays) || (input.trialDays as number) < 1) {
      throw new AppError(400, 'INVALID_TRIAL_DAYS', 'Trial length must be at least one day');
    }
    trialEndsAt = new Date(Date.now() + (input.trialDays as number) * 24 * 60 * 60 * 1000);
  }

  const email = input.ownerEmail.trim().toLowerCase();
  const ownerName = input.ownerName;
  const verifyToken = crypto.randomBytes(32).toString('base64url');
  const verifyTokenHash = hashOpaqueToken(verifyToken);

  // A second one-time token, alongside the verify token, that lets the
  // provisioned owner set a real password. Hash stored — only its digest is
  // ever persisted, same as the verify token above. Where the raw token goes
  // depends on emailDeliveryMode(): under provider it is emailed
  // (sendPasswordRecoveryEmail below); under manual-link there is no email
  // provider, so it is surfaced once as a URL in the response instead (see
  // manualLinks below). It resolves through the ordinary
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

  const verifyTokenExpiry = new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000);
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  // Under manual-link, no email provider exists on this deployment: the
  // links themselves ARE the delivery mechanism. If no safe origin is
  // configured, the links cannot be delivered at all, so no tenant may be
  // created — this check runs BEFORE the transaction, fail-closed, exactly
  // like the appliance's manual-invite links (manualLinkOrigin's contract).
  // Tokens already exist at this point (generated above) purely so the link
  // strings can be computed and validated up front; nothing is persisted
  // yet.
  let manualLinks: { setPassword: string; verifyEmail: string } | null = null;
  if (emailDeliveryMode() === 'manual-link') {
    const setPassword = manualAuthLinkUrl('/reset-password', resetToken);
    const verifyEmail = manualAuthLinkUrl('/verify-email', verifyToken);
    if (!setPassword || !verifyEmail) {
      throw new AppError(
        500,
        'MANUAL_LINK_ORIGIN_INVALID',
        'No safe origin is configured for manual links',
      );
    }
    manualLinks = { setPassword, verifyEmail };
  }

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
      data: billing === 'comped'
        // The appliance's own shape for a non-expiring subscription: ACTIVE
        // with no trial end. subscriptionGuard honours the data as-is.
        ? { organisationId: organisation.id, plan: input.plan, status: 'ACTIVE', trialEndsAt: null }
        : { organisationId: organisation.id, plan: input.plan, status: 'TRIALING', trialEndsAt },
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

  if (manualLinks) {
    // No email provider exists on this deployment. The links are surfaced
    // ONCE to the authenticated platform operator in the 201 response — the
    // same trust decision as the appliance's manual invite links. Tokens
    // ride the URL fragment, which never reaches server logs or proxies.
    return { organisationId: created.organisationId, userId: created.userId, links: manualLinks };
  }

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

  return { organisationId: created.organisationId, userId: created.userId };
}
