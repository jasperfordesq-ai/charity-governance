/**
 * A second factor for platform operator accounts.
 *
 * The threat is plain: one password can suspend every charity on the platform.
 * A stolen or reused operator password is the single worst credential in this
 * system, and it had nothing behind it.
 *
 * Enrolment is opt-in per operator. Requiring it is a later decision, because
 * turning it on for everybody in one deployment would lock out whoever had not
 * enrolled yet — including, quite possibly, the only person who could fix it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { generateTotpSecret, totpEnrolmentUri, verifyTotp } from '../utils/totp.js';
import { openTotpSecret, sealTotpSecret, type SealedTotpSecret } from './operator-totp-crypto.js';

// The sealing crypto lives in ./operator-totp-crypto.ts, which imports nothing
// but node:crypto, because the E2E harness has to seal a secret with exactly
// this code and cannot import a module that reaches @prisma/client or fastify.
// Re-exported here so existing importers of this service are unaffected.
export { openTotpSecret, sealTotpSecret, type SealedTotpSecret };

/** Recovery codes: ten of them, each with enough entropy to be unguessable. */
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;

/** Unambiguous: no I, L, O, U, or digits that look like letters. */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

/** Typed with or without the grouping dashes, in any case. */
function normaliseRecoveryCode(code: string): string {
  return code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  const body = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join('');
  // Grouped for reading aloud and typing back.
  return `${body.slice(0, 5)}-${body.slice(5)}`;
}

export type EnrolmentOffer = {
  secret: string;
  uri: string;
};

/**
 * Issues a new secret and returns what the operator needs to scan it.
 *
 * Replaces any pending, unverified secret. An operator who abandoned an
 * enrolment halfway and started again should get a working QR code rather than
 * a stale one, and the previous pending secret was never usable for anything.
 *
 * Refuses when already enrolled: changing a live second factor is a separate
 * action that must prove the current one first, and quietly overwriting it here
 * would let anyone holding a session replace the factor protecting it.
 */
export async function beginOperatorEnrolment(
  prisma: PrismaClient,
  operatorId: string,
  issuer = 'CharityPilot Platform',
): Promise<EnrolmentOffer> {
  const operator = await prisma.platformOperator.findUnique({
    where: { id: operatorId },
    select: { email: true, totpEnrolledAt: true },
  });
  if (!operator) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator not found');
  if (operator.totpEnrolledAt) {
    throw new AppError(
      409,
      'SECOND_FACTOR_ALREADY_ENROLLED',
      'This account already has a second factor. Remove the current one before adding another.',
    );
  }

  const secret = generateTotpSecret();
  await prisma.platformOperator.update({
    where: { id: operatorId },
    data: { totpSecret: sealTotpSecret(secret), totpPendingAt: new Date(), totpEnrolledAt: null },
  });

  return { secret, uri: totpEnrolmentUri({ secret, account: operator.email, issuer }) };
}

/**
 * Completes enrolment by proving a code can be generated, and hands back the
 * recovery codes.
 *
 * The proof matters. Without it, an operator who scanned a code into the wrong
 * application, or onto a phone they then dropped in a river, would be locked
 * out of the console with no way back — and on a single-operator deployment
 * there is nobody else to let them in.
 */
export async function completeOperatorEnrolment(
  prisma: PrismaClient,
  operatorId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const operator = await prisma.platformOperator.findUnique({
    where: { id: operatorId },
    select: { totpSecret: true, totpEnrolledAt: true },
  });
  if (!operator) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator not found');
  if (operator.totpEnrolledAt) {
    throw new AppError(409, 'SECOND_FACTOR_ALREADY_ENROLLED', 'This account is already enrolled.');
  }
  if (!operator.totpSecret) {
    throw new AppError(
      409,
      'SECOND_FACTOR_NOT_STARTED',
      'There is no enrolment in progress. Start one, then enter a code from the application.',
    );
  }

  if (!verifyTotp(openTotpSecret(operator.totpSecret), code)) {
    throw new AppError(
      400,
      'SECOND_FACTOR_CODE_INVALID',
      'That code did not match. Check the time on the device generating it, and try the next one.',
    );
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  await prisma.$transaction(async (tx) => {
    await tx.platformOperator.update({
      where: { id: operatorId },
      data: { totpEnrolledAt: new Date(), totpPendingAt: null },
    });
    // Any codes from a previous enrolment are meaningless now.
    await tx.platformOperatorRecoveryCode.deleteMany({ where: { operatorId } });
    await tx.platformOperatorRecoveryCode.createMany({
      data: recoveryCodes.map((recoveryCode) => ({
        operatorId,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    });
  });

  return { recoveryCodes };
}

export type SecondFactorState = {
  enrolled: boolean;
  enrolmentPending: boolean;
  recoveryCodesRemaining: number;
};

export async function operatorSecondFactorState(
  prisma: PrismaClient,
  operatorId: string,
): Promise<SecondFactorState> {
  const operator = await prisma.platformOperator.findUnique({
    where: { id: operatorId },
    select: { totpEnrolledAt: true, totpSecret: true },
  });
  if (!operator) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator not found');

  const recoveryCodesRemaining = operator.totpEnrolledAt
    ? await prisma.platformOperatorRecoveryCode.count({ where: { operatorId, usedAt: null } })
    : 0;

  return {
    enrolled: operator.totpEnrolledAt !== null,
    enrolmentPending: operator.totpEnrolledAt === null && operator.totpSecret !== null,
    recoveryCodesRemaining,
  };
}

export type SecondFactorOutcome =
  | { required: false }
  | { required: true; satisfied: true; usedRecoveryCode: boolean }
  | { required: true; satisfied: false };

/**
 * Whether this sign-in has satisfied the account's second factor.
 *
 * Called after the password has been checked and before a session is issued. An
 * account with no second factor returns `required: false`, which is what keeps
 * enrolment opt-in without a separate code path for it.
 */
export async function checkOperatorSecondFactor(
  prisma: PrismaClient,
  operatorId: string,
  offered: { code?: string | undefined; recoveryCode?: string | undefined },
): Promise<SecondFactorOutcome> {
  const operator = await prisma.platformOperator.findUnique({
    where: { id: operatorId },
    select: { totpSecret: true, totpEnrolledAt: true },
  });
  if (!operator?.totpEnrolledAt || !operator.totpSecret) return { required: false };

  if (offered.code && verifyTotp(openTotpSecret(operator.totpSecret), offered.code)) {
    return { required: true, satisfied: true, usedRecoveryCode: false };
  }

  if (offered.recoveryCode) {
    const normalised = normaliseRecoveryCode(offered.recoveryCode);
    if (normalised.length > 0) {
      // Spent by a conditional update rather than a read then a write, so two
      // simultaneous sign-ins cannot both spend the same code.
      const spent = await prisma.platformOperatorRecoveryCode.updateMany({
        where: { operatorId, codeHash: hashRecoveryCode(normalised), usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count === 1) {
        return { required: true, satisfied: true, usedRecoveryCode: true };
      }
    }
  }

  return { required: true, satisfied: false };
}

/**
 * Removes a second factor, after proving the current one.
 *
 * Proving it first is the point: a session is not enough, or anybody who
 * borrowed an unlocked screen could take the factor off and keep the account.
 */
export async function removeOperatorSecondFactor(
  prisma: PrismaClient,
  operatorId: string,
  offered: { code?: string | undefined; recoveryCode?: string | undefined },
): Promise<void> {
  const outcome = await checkOperatorSecondFactor(prisma, operatorId, offered);
  if (outcome.required === false) {
    throw new AppError(409, 'SECOND_FACTOR_NOT_ENROLLED', 'This account has no second factor.');
  }
  if (!outcome.satisfied) {
    throw new AppError(
      400,
      'SECOND_FACTOR_CODE_INVALID',
      'That code did not match, so the second factor was left in place.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.platformOperator.update({
      where: { id: operatorId },
      // Prisma.DbNull, not null: for a JSON column, `null` means "leave it"
      // and the database NULL has to be asked for by name.
      data: { totpSecret: Prisma.DbNull, totpEnrolledAt: null, totpPendingAt: null },
    });
    await tx.platformOperatorRecoveryCode.deleteMany({ where: { operatorId } });
  });
}

/** Exported for tests: the comparison a recovery code goes through. */
export function recoveryCodeMatches(stored: string, offered: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(hashRecoveryCode(offered), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
