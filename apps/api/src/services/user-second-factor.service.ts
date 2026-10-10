import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { generateTotpSecret, matchingTotpStep, totpEnrolmentUri } from '../utils/totp.js';
import { openUserTotpSecret, sealUserTotpSecret, userTotpSecretIsCurrent } from './user-totp-crypto.js';
import type { SecondFactorResealPage } from './totp-secret-envelope.js';

type Tx = Prisma.TransactionClient;
export type OfferedSecondFactor = { code?: string | undefined; recoveryCode?: string | undefined };
type FactorRow = {
  userId: string;
  secret: unknown;
  pendingAt: Date | null;
  enrolledAt: Date | null;
  lastUsedStep: number | null;
  failedAttempts: number;
  failedWindowAt: Date | null;
  blockedUntil: Date | null;
};

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PENDING_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const RECOVERY_SIGN_IN_REASON = 'A one-time recovery code was used for sign-in.';

function recoveryCode(): string {
  const body = [...randomBytes(12)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `${body.slice(0, 6)}-${body.slice(6)}`;
}

function hashRecoveryCode(value: string): string {
  return createHash('sha256').update(value.replace(/[^0-9A-Za-z]/g, '').toUpperCase()).digest('hex');
}

function codeError(): AppError {
  return new AppError(401, 'SECOND_FACTOR_REQUIRED', 'Enter a current authenticator code or one of your saved recovery codes.');
}

function rateError(): AppError {
  return new AppError(429, 'SECOND_FACTOR_RATE_LIMITED', 'Too many code attempts. Wait 15 minutes before trying again.');
}

async function lockedFactor(tx: Tx, userId: string): Promise<FactorRow | undefined> {
  const rows = await tx.$queryRaw<FactorRow[]>`
    SELECT "userId", "secret", "pendingAt", "enrolledAt", "lastUsedStep",
           "failedAttempts", "failedWindowAt", "blockedUntil"
    FROM "UserSecondFactor" WHERE "userId" = ${userId} FOR UPDATE
  `;
  return rows[0];
}

async function audit(tx: Tx, user: { id: string; organisationId: string; name: string },
  type: 'SECOND_FACTOR_ENROLLED' | 'SECOND_FACTOR_REMOVED' | 'SECOND_FACTOR_RECOVERY_USED',
  reason: string, sessionFamilyId?: string): Promise<void> {
  await tx.securityAuditEvent.create({ data: {
    organisationId: user.organisationId,
    type,
    actorKind: 'USER',
    actorUserId: user.id,
    actorLabel: user.name,
    subjectUserId: user.id,
    subjectSessionId: sessionFamilyId,
    subjectLabel: user.name,
    reason,
  } });
}

async function currentUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, organisationId: true,
      passwordHash: true, lifecycleStatus: true,
      organisation: { select: { lifecycleStatus: true } } },
  });
  if (!user || user.lifecycleStatus !== 'ACTIVE' || user.organisation.lifecycleStatus !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
  }
  return user;
}

async function requirePassword(prisma: PrismaClient, userId: string, password: string) {
  const user = await currentUser(prisma, userId);
  if (!await bcrypt.compare(password, user.passwordHash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'The account password did not match.');
  }
  return user;
}

export async function userSecondFactorState(prisma: PrismaClient, userId: string) {
  const factor = await prisma.userSecondFactor.findUnique({
    where: { userId }, select: { enrolledAt: true, pendingAt: true },
  });
  return {
    enrolled: !!factor?.enrolledAt,
    enrolmentPending: !!factor?.pendingAt,
    recoveryCodesRemaining: factor?.enrolledAt
      ? await prisma.userSecondFactorRecoveryCode.count({ where: { userId, usedAt: null } })
      : 0,
  };
}

export async function beginUserSecondFactor(prisma: PrismaClient, userId: string, password: string) {
  const user = await requirePassword(prisma, userId, password);
  const secret = generateTotpSecret();
  const pendingAt = new Date();
  await prisma.$transaction(async (tx) => {
    const existing = await lockedFactor(tx, userId);
    if (existing?.enrolledAt) {
      throw new AppError(409, 'SECOND_FACTOR_ALREADY_ENROLLED', 'A second factor is already active.');
    }
    if (existing) {
      await tx.userSecondFactor.update({ where: { userId }, data: {
        secret: sealUserTotpSecret(secret), pendingAt, lastUsedStep: null,
      } });
    } else {
      await tx.userSecondFactor.create({ data: {
        userId, secret: sealUserTotpSecret(secret), pendingAt,
      } });
    }
  });
  return { secret, uri: totpEnrolmentUri({ secret, account: user.email, issuer: 'CharityPilot' }) };
}

export async function completeUserSecondFactor(prisma: PrismaClient, userId: string, code: string) {
  const user = await currentUser(prisma, userId);
  const recoveryCodes = Array.from({ length: 10 }, recoveryCode);
  await prisma.$transaction(async (tx) => {
    const factor = await lockedFactor(tx, userId);
    if (!factor?.pendingAt || factor.enrolledAt) {
      throw new AppError(409, 'SECOND_FACTOR_NOT_STARTED', 'Start authenticator setup again.');
    }
    if (Date.now() - factor.pendingAt.getTime() > PENDING_MS) {
      throw new AppError(409, 'SECOND_FACTOR_SETUP_EXPIRED', 'Setup expired. Start again.');
    }
    const step = matchingTotpStep(openUserTotpSecret(factor.secret), code);
    if (step === null) throw codeError();
    await tx.userSecondFactor.update({ where: { userId }, data: {
      enrolledAt: new Date(), pendingAt: null, lastUsedStep: step,
      failedAttempts: 0, failedWindowAt: null, blockedUntil: null,
    } });
    await tx.userSecondFactorRecoveryCode.createMany({ data: recoveryCodes.map((value) => ({
      userId, codeHash: hashRecoveryCode(value),
    })) });
    await audit(tx, user, 'SECOND_FACTOR_ENROLLED', 'Authenticator setup completed and recovery codes issued.');
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: {
      revokedAt: new Date(), revocationReason: 'USER_ALL_SESSIONS_REVOKED',
    } });
  });
  return { recoveryCodes };
}

async function verifyLockedFactorProof(tx: Tx, user: {
  id: string; organisationId: string; name: string;
}, factor: FactorRow, offered: OfferedSecondFactor,
  purpose: 'sign-in' | 'removal' | 'password change', sessionFamilyId?: string): Promise<AppError | null> {
  const now = new Date();
  if (factor.blockedUntil && factor.blockedUntil > now) return rateError();
  if (!offered.code && !offered.recoveryCode) return codeError();
  if (offered.recoveryCode) {
    const normalised = offered.recoveryCode.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (normalised.length === 12) {
      const spent = await tx.userSecondFactorRecoveryCode.updateMany({
        where: { userId: user.id, codeHash: hashRecoveryCode(normalised), usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count === 1) {
        await tx.userSecondFactor.update({ where: { userId: user.id }, data: {
          failedAttempts: 0, failedWindowAt: null, blockedUntil: null,
        } });
        await audit(tx, user, 'SECOND_FACTOR_RECOVERY_USED',
          purpose === 'sign-in' ? RECOVERY_SIGN_IN_REASON
            : `A one-time recovery code was used for ${purpose}.`, sessionFamilyId);
        return null;
      }
    }
  }
  if (offered.code) {
    const secret = openUserTotpSecret(factor.secret);
    const step = matchingTotpStep(secret, offered.code);
    if (step !== null && (factor.lastUsedStep === null || step > factor.lastUsedStep)) {
      await tx.userSecondFactor.update({ where: { userId: user.id }, data: {
        lastUsedStep: step, failedAttempts: 0, failedWindowAt: null, blockedUntil: null,
        // A secret still sealed under a previous JWT_SECRET moves to the
        // current one on its first successful use after a rotation.
        ...(userTotpSecretIsCurrent(factor.secret) ? {} : { secret: sealUserTotpSecret(secret) }),
      } });
      return null;
    }
  }
  const windowAt = factor.failedWindowAt && now.getTime() - factor.failedWindowAt.getTime() < ATTEMPT_WINDOW_MS
    ? factor.failedWindowAt : now;
  const attempts = windowAt === factor.failedWindowAt
    ? Math.min(MAX_FAILED_ATTEMPTS, factor.failedAttempts + 1) : 1;
  await tx.userSecondFactor.update({ where: { userId: user.id }, data: {
    failedAttempts: attempts,
    failedWindowAt: windowAt,
    blockedUntil: attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(now.getTime() + ATTEMPT_WINDOW_MS) : null,
  } });
  return attempts >= MAX_FAILED_ATTEMPTS ? rateError() : codeError();
}

/** A failed proof returns an error so its account-wide attempt count can commit. */
export async function verifyUserLoginSecondFactor(tx: Tx, user: {
  id: string; organisationId: string; name: string;
}, offered: OfferedSecondFactor, sessionFamilyId?: string,
  enrolmentRequired = false): Promise<AppError | null> {
  const factor = await lockedFactor(tx, user.id);
  if (!factor?.enrolledAt) return enrolmentRequired
    ? new AppError(403, 'PRIVILEGED_MFA_ENROLMENT_REQUIRED',
      'Enroll an authenticator in a browser before using a privileged connector.')
    : null;
  return verifyLockedFactorProof(tx, user, factor, offered, 'sign-in', sessionFamilyId);
}

export async function verifyUserPasswordChangeSecondFactor(tx: Tx, user: {
  id: string; organisationId: string; name: string;
}, offered: OfferedSecondFactor, sessionFamilyId: string): Promise<AppError | null> {
  const factor = await lockedFactor(tx, user.id);
  if (!factor?.enrolledAt) return null;
  return verifyLockedFactorProof(tx, user, factor, offered, 'password change', sessionFamilyId);
}

export async function removeUserSecondFactor(prisma: PrismaClient, userId: string,
  password: string, offered: OfferedSecondFactor, sessionFamilyId: string) {
  const user = await requirePassword(prisma, userId, password);
  const outcome = await prisma.$transaction(async (tx) => {
    const factor = await lockedFactor(tx, userId);
    if (!factor?.enrolledAt) {
      throw new AppError(409, 'SECOND_FACTOR_NOT_ENROLLED', 'No second factor is active.');
    }
    let failure: AppError | null;
    if (!offered.code && !offered.recoveryCode) {
      const recentRecovery = await tx.securityAuditEvent.findFirst({
        where: {
          organisationId: user.organisationId,
          subjectUserId: userId,
          subjectSessionId: sessionFamilyId,
          type: 'SECOND_FACTOR_RECOVERY_USED',
          reason: RECOVERY_SIGN_IN_REASON,
          occurredAt: { gte: new Date(Date.now() - ATTEMPT_WINDOW_MS) },
        },
        select: { id: true },
      });
      failure = recentRecovery ? null : codeError();
    } else {
      failure = await verifyLockedFactorProof(tx, user, factor, offered, 'removal');
    }
    if (failure) return failure;
    await tx.userSecondFactor.delete({ where: { userId } });
    await audit(tx, user, 'SECOND_FACTOR_REMOVED', 'Authenticator removed after password and second-factor proof.');
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: {
      revokedAt: new Date(), revocationReason: 'USER_ALL_SESSIONS_REVOKED',
    } });
  });
  if (outcome instanceof AppError) throw outcome;
}

/**
 * Re-seal, under the current JWT_SECRET, every stored authenticator secret
 * still sealed under a previous one, so JWT_SECRET_PREVIOUS can be removed
 * without locking anyone out. A row that changed since it was read is skipped
 * for the next run; one that cannot be opened is reported by user id only.
 * Decrypts in memory; returns counts and ids, never a secret.
 */
export async function resealUserSecondFactorSecrets(prisma: Pick<PrismaClient, 'userSecondFactor'>,
  batch = 100, after?: string): Promise<SecondFactorResealPage> {
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000) {
    throw new AppError(400, 'SECOND_FACTOR_RESEAL_BATCH_INVALID', 'Batch size must be between 1 and 1000');
  }
  // One bounded page in id order. `next` moves the caller past this page,
  // including any row that failed, so a bad row never blocks the rest.
  const rows = await prisma.userSecondFactor.findMany({
    ...(after === undefined ? {} : { where: { userId: { gt: after } } }),
    select: { userId: true, secret: true, updatedAt: true },
    orderBy: { userId: 'asc' },
    take: batch,
  });
  const stale = rows.filter((row) => !userTotpSecretIsCurrent(row.secret));
  let resealed = 0;
  let skippedChanged = 0;
  const failed: string[] = [];
  for (const row of stale) {
    let plaintext: string;
    try {
      plaintext = openUserTotpSecret(row.secret);
    } catch {
      failed.push(row.userId);
      continue;
    }
    const written = await prisma.userSecondFactor.updateMany({
      where: { userId: row.userId, updatedAt: row.updatedAt },
      data: { secret: sealUserTotpSecret(plaintext) },
    });
    if (written.count === 1) resealed += 1;
    else skippedChanged += 1;
  }
  return { scanned: rows.length, stale: stale.length, resealed, skippedChanged, failed,
    next: rows.length === batch ? rows[rows.length - 1]!.userId : null };
}

