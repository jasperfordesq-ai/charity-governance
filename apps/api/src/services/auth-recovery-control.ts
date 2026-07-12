import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { authRecoverySecretFingerprint } from './password-recovery-crypto.js';

export const AUTH_RECOVERY_CONTROL_ERROR_CODE = 'AUTH_RECOVERY_CONTROL_UNAVAILABLE';

export type AuthRecoveryControlState = {
  id: number;
  blocked: boolean;
  generation: number;
  activeSecretFingerprint: string | null;
  retiredSecretFingerprint: string | null;
};

type TransactionClient = Prisma.TransactionClient;

function unavailable(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    name: 'AuthRecoveryControlUnavailable',
    code: AUTH_RECOVERY_CONTROL_ERROR_CODE,
  });
}

function fingerprintsEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function isRetiredFingerprint(
  tx: TransactionClient,
  fingerprint: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ retired: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "AuthRecoveryRetiredSecret"
      WHERE "fingerprint" = ${fingerprint}
    ) AS "retired"
  `;
  return rows[0]?.retired === true;
}

export async function lockAuthRecoveryControl(
  tx: TransactionClient,
): Promise<AuthRecoveryControlState> {
  const rows = await tx.$queryRaw<AuthRecoveryControlState[]>`
    SELECT
      "id", "blocked", "generation", "activeSecretFingerprint",
      "retiredSecretFingerprint"
    FROM "AuthRecoveryControl"
    WHERE "id" = 1
    FOR UPDATE
  `;
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].generation < 1) {
    throw unavailable('Authentication recovery control row is missing or invalid');
  }
  return rows[0];
}

export async function assertAuthRecoveryControlForCurrentSecret(
  tx: TransactionClient,
  secret = process.env.AUTH_RECOVERY_SECRET,
): Promise<AuthRecoveryControlState> {
  const fingerprint = authRecoverySecretFingerprint(secret);
  const control = await lockAuthRecoveryControl(tx);
  if (control.blocked) {
    throw unavailable('Authentication recovery is blocked pending controlled key activation');
  }

  if (control.activeSecretFingerprint === null) {
    if (
      control.generation !== 1 ||
      control.retiredSecretFingerprint !== null
    ) {
      throw unavailable('Authentication recovery control has no active key binding');
    }
    if (await isRetiredFingerprint(tx, fingerprint)) {
      throw unavailable('Authentication recovery root key was previously retired');
    }
    const initialized = await tx.$executeRaw`
      UPDATE "AuthRecoveryControl"
      SET
        "activeSecretFingerprint" = ${fingerprint},
        "activatedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 1
        AND NOT "blocked"
        AND "generation" = 1
        AND "activeSecretFingerprint" IS NULL
        AND "retiredSecretFingerprint" IS NULL
    `;
    if (initialized !== 1) {
      throw unavailable('Authentication recovery control initialization lost its lock');
    }
    return { ...control, activeSecretFingerprint: fingerprint };
  }

  if (!fingerprintsEqual(control.activeSecretFingerprint, fingerprint)) {
    throw unavailable('Authentication recovery process is using a non-active root key');
  }
  return control;
}

export async function requireAuthRecoveryControlForCurrentSecret(
  tx: TransactionClient,
  secret = process.env.AUTH_RECOVERY_SECRET,
): Promise<AuthRecoveryControlState> {
  const fingerprint = authRecoverySecretFingerprint(secret);
  const control = await lockAuthRecoveryControl(tx);
  if (control.blocked) {
    throw unavailable('Authentication recovery is blocked pending controlled key activation');
  }
  if (control.activeSecretFingerprint === null) {
    throw unavailable('Authentication recovery control has not been explicitly bound');
  }
  if (!fingerprintsEqual(control.activeSecretFingerprint, fingerprint)) {
    throw unavailable('Authentication recovery process is using a non-active root key');
  }
  return control;
}

export async function bindAuthRecoveryControlForRuntime(
  prisma: PrismaClient,
  secret = process.env.AUTH_RECOVERY_SECRET,
): Promise<AuthRecoveryControlState> {
  return prisma.$transaction(
    (tx) => assertAuthRecoveryControlForCurrentSecret(tx, secret),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
}

export async function requireAuthRecoveryControlForRuntime(
  prisma: PrismaClient,
  secret = process.env.AUTH_RECOVERY_SECRET,
): Promise<AuthRecoveryControlState> {
  return prisma.$transaction(
    (tx) => requireAuthRecoveryControlForCurrentSecret(tx, secret),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
}
