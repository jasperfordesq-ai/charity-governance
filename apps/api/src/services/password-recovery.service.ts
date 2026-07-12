import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { MAX_ACCOUNT_EMAIL_LENGTH } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { getPrimaryFrontendOrigin } from '../utils/frontend-origin.js';
import { isPersonalServerDeployment } from '../utils/personal-server.js';
import {
  AUTH_RECOVERY_KEY_VERSION,
  canonicalizePasswordRecoveryAddress,
  createPasswordRecoveryTokenMaterial,
  derivePasswordRecoveryRateDigest,
  hashPasswordRecoveryToken,
} from './password-recovery-crypto.js';
import { SECURITY_EMAIL_TEMPLATE_VERSION } from './security-email-templates.js';
import {
  AUTH_RECOVERY_CONTROL_ERROR_CODE,
  assertAuthRecoveryControlForCurrentSecret,
} from './auth-recovery-control.js';

type TransactionClient = Prisma.TransactionClient;

export type PasswordRecoveryRequestContext = {
  ipAddress: string;
  requestId?: string;
};

export type PasswordRecoveryDeliveryWakeup = {
  wakePasswordRecoveryDelivery(requestId: string): void | Promise<void>;
};

export type PasswordRecoveryResponseTiming = {
  nowMs(): number;
  targetDurationMs(): number;
  delay(ms: number): Promise<void>;
};

type LockedOrganisation = {
  id: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
};

type LockedUser = {
  id: string;
  organisationId: string;
  email: string;
  name: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
};

type LockedRecoveryRequest = {
  id: string;
  source: 'SELF_SERVICE_EMAIL' | 'LEGACY_USER_SLOT' | 'PERSONAL_SERVER_OPERATOR';
  tokenHash: string | null;
  deliveryState: 'SUPPRESSED' | 'PENDING' | 'SENDING' | 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';
  expiresAt: Date | null;
  terminatedAt: Date | null;
};

type RateLimitRule = {
  scope:
    | 'FORGOT_IDENTIFIER_15M'
    | 'FORGOT_IDENTIFIER_24H'
    | 'FORGOT_NETWORK_15M'
    | 'FORGOT_NETWORK_24H'
    | 'RESET_TOKEN_15M'
    | 'RESET_TOKEN_24H'
    | 'RESET_NETWORK_15M'
    | 'RESET_NETWORK_24H';
  digest: string;
  windowSeconds: number;
  maximum: number;
};

const SALT_ROUNDS = 12;
const RESET_EXPIRY_MS = 60 * 60 * 1000;
const MAX_OUTSTANDING_REQUESTS = 3;
export const PASSWORD_RECOVERY_RESPONSE_MIN_MS = 350;
export const PASSWORD_RECOVERY_RESPONSE_MAX_MS = 550;
export const PASSWORD_RECOVERY_NEUTRAL_MESSAGE =
  'If an active account exists and another request is allowed, password-recovery instructions will arrive shortly.';
const CONSUMABLE_DELIVERY_STATES = new Set(['SENDING', 'ACCEPTED', 'UNCERTAIN']);
const NON_MATCHING_ORGANISATION_ID = '__password_recovery_no_organisation__';
const NON_MATCHING_USER_ID = '__password_recovery_no_user__';

const noDeliveryWakeup: PasswordRecoveryDeliveryWakeup = {
  wakePasswordRecoveryDelivery: () => undefined,
};

const defaultResponseTiming: PasswordRecoveryResponseTiming = {
  nowMs: () => performance.now(),
  targetDurationMs: () => crypto.randomInt(
    PASSWORD_RECOVERY_RESPONSE_MIN_MS,
    PASSWORD_RECOVERY_RESPONSE_MAX_MS + 1,
  ),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function boundedResponseTarget(value: number): number {
  if (!Number.isFinite(value)) return PASSWORD_RECOVERY_RESPONSE_MAX_MS;
  return Math.min(
    PASSWORD_RECOVERY_RESPONSE_MAX_MS,
    Math.max(PASSWORD_RECOVERY_RESPONSE_MIN_MS, Math.round(value)),
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isCanonicalAccountEmail(email: string): boolean {
  return email.length <= MAX_ACCOUNT_EMAIL_LENGTH &&
    email === normalizeEmail(email) &&
    !/[\u0000-\u001f\u007f]/u.test(email);
}

function boundedEvidence(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum).trim();
}

function displayName(user: { name: string; email: string }): string {
  return boundedEvidence(user.name, 200) || boundedEvidence(user.email, 200) || 'CharityPilot user';
}

function invalidResetToken(): AppError {
  return new AppError(
    400,
    'INVALID_RESET_TOKEN',
    'This reset link is invalid or has expired. Please request a new one.',
  );
}

function recoveryRateLimited(): AppError {
  return new AppError(
    429,
    'RECOVERY_RATE_LIMITED',
    'Too many recovery attempts. Please wait and try again.',
  );
}

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const RECOVERY_UNAVAILABLE_CODES = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
  AUTH_RECOVERY_CONTROL_ERROR_CODE,
]);

export function mapPasswordRecoveryInfrastructureError(error: unknown): unknown {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown; errorCode?: unknown }).code
      ?? (error as { errorCode?: unknown }).errorCode
    : undefined;
  if (typeof code === 'string' && RECOVERY_UNAVAILABLE_CODES.has(code)) {
    return new AppError(
      503,
      'PASSWORD_RECOVERY_UNAVAILABLE',
      'Password recovery is temporarily unavailable. Please try again later.',
    );
  }
  return error;
}

async function databaseNow(tx: TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP::timestamp(3) AS "now"
  `;
  if (!rows[0]) throw new Error('Password recovery database clock is unavailable');
  return rows[0].now;
}

async function incrementRateLimitBucket(
  tx: TransactionClient,
  rule: RateLimitRule,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    WITH window_bounds AS (
      SELECT
        (
          TIMESTAMP 'epoch'
          + FLOOR(
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
              / ${rule.windowSeconds}
            ) * ${rule.windowSeconds} * INTERVAL '1 second'
        )::timestamp(3) AS "windowStartedAt"
    )
    INSERT INTO "AuthRecoveryRateLimitBucket" (
      "scope", "keyVersion", "subjectDigest", "windowStartedAt", "count",
      "windowEndsAt", "expiresAt", "createdAt", "updatedAt"
    )
    SELECT
      ${rule.scope}::"AuthRecoveryRateLimitScope",
      ${AUTH_RECOVERY_KEY_VERSION},
      ${rule.digest},
      "windowStartedAt",
      1,
      "windowStartedAt" + ${rule.windowSeconds} * INTERVAL '1 second',
      "windowStartedAt" + ${rule.windowSeconds} * INTERVAL '1 second' + INTERVAL '24 hours',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM window_bounds
    ON CONFLICT ("scope", "keyVersion", "subjectDigest", "windowStartedAt")
    DO UPDATE SET
      "count" = LEAST(
        "AuthRecoveryRateLimitBucket"."count"::bigint + 1,
        2147483647
      )::integer,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "count"
  `);
  const count = Number(rows[0]?.count ?? Number.POSITIVE_INFINITY);
  return Number.isSafeInteger(count) && count <= rule.maximum;
}

async function consumeRules(tx: TransactionClient, rules: RateLimitRule[]): Promise<boolean> {
  const results: boolean[] = [];
  for (const rule of rules) {
    results.push(await incrementRateLimitBucket(tx, rule));
  }
  return results.every(Boolean);
}

async function lockOrganisation(
  tx: TransactionClient,
  organisationId: string,
  mode: 'SHARE' | 'UPDATE',
): Promise<LockedOrganisation | null> {
  const query = mode === 'UPDATE'
    ? Prisma.sql`
        SELECT "id", "lifecycleStatus"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR UPDATE
      `
    : Prisma.sql`
        SELECT "id", "lifecycleStatus"
        FROM "Organisation"
        WHERE "id" = ${organisationId}
        FOR SHARE
      `;
  const rows = await tx.$queryRaw<LockedOrganisation[]>(query);
  return rows[0] ?? null;
}

async function lockUser(
  tx: TransactionClient,
  organisationId: string,
  userId: string,
  mode: 'SHARE' | 'UPDATE',
): Promise<LockedUser | null> {
  const query = mode === 'UPDATE'
    ? Prisma.sql`
        SELECT "id", "organisationId", "email", "name", "lifecycleStatus"
        FROM "User"
        WHERE "id" = ${userId} AND "organisationId" = ${organisationId}
        FOR UPDATE
      `
    : Prisma.sql`
        SELECT "id", "organisationId", "email", "name", "lifecycleStatus"
        FROM "User"
        WHERE "id" = ${userId} AND "organisationId" = ${organisationId}
        FOR SHARE
      `;
  const rows = await tx.$queryRaw<LockedUser[]>(query);
  return rows[0] ?? null;
}

export class PasswordRecoveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly deliveryWakeup: PasswordRecoveryDeliveryWakeup = noDeliveryWakeup,
    private readonly responseTiming: PasswordRecoveryResponseTiming = defaultResponseTiming,
  ) {}

  private async equalizeSuccessfulForgotPasswordResponse(
    startedAtMs: number,
    targetDurationMs: number,
  ): Promise<void> {
    const elapsedMs = Math.max(0, this.responseTiming.nowMs() - startedAtMs);
    const remainingMs = Math.min(
      PASSWORD_RECOVERY_RESPONSE_MAX_MS,
      Math.max(0, targetDurationMs - elapsedMs),
    );
    if (remainingMs > 0) await this.responseTiming.delay(remainingMs);
  }

  async requestPasswordReset(
    emailInput: string,
    context: PasswordRecoveryRequestContext,
  ): Promise<{ message: string }> {
    const responseStartedAtMs = this.responseTiming.nowMs();
    const responseTargetDurationMs = boundedResponseTarget(
      this.responseTiming.targetDurationMs(),
    );
    const email = normalizeEmail(emailInput);
    const { exactAddress, networkAddress } = canonicalizePasswordRecoveryAddress(context.ipAddress);
    const identifierDigest = derivePasswordRecoveryRateDigest('forgot-identifier', email);
    const requestIpDigest = derivePasswordRecoveryRateDigest('forgot-ip', exactAddress);
    const requestNetworkDigest = derivePasswordRecoveryRateDigest('forgot-network', networkAddress);
    const frontendOrigin = getPrimaryFrontendOrigin();

    let deliveryRequestId: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = crypto.randomUUID();
      const tokenMaterial = createPasswordRecoveryTokenMaterial(requestId);
      try {
        deliveryRequestId = await this.prisma.$transaction(async (tx) => {
          await assertAuthRecoveryControlForCurrentSecret(tx);
          await tx.$queryRaw`
            SELECT 1 AS "acquired"
            FROM (
              SELECT pg_advisory_xact_lock(hashtextextended(${identifierDigest}, 0))
            ) AS recovery_identifier_lock
          `;

          const rateAllowed = await consumeRules(tx, [
            { scope: 'FORGOT_IDENTIFIER_15M', digest: identifierDigest, windowSeconds: 15 * 60, maximum: 3 },
            { scope: 'FORGOT_IDENTIFIER_24H', digest: identifierDigest, windowSeconds: 24 * 60 * 60, maximum: 5 },
            { scope: 'FORGOT_NETWORK_15M', digest: requestNetworkDigest, windowSeconds: 15 * 60, maximum: 20 },
            { scope: 'FORGOT_NETWORK_24H', digest: requestNetworkDigest, windowSeconds: 24 * 60 * 60, maximum: 100 },
          ]);

          const candidate = await tx.user.findUnique({
            where: { email },
            select: {
              id: true,
              organisationId: true,
              email: true,
              name: true,
              lifecycleStatus: true,
              organisation: { select: { lifecycleStatus: true } },
            },
          });

          let suppressionReason:
            | 'NO_ELIGIBLE_ACCOUNT'
            | 'RATE_LIMITED'
            | 'OUTSTANDING_LIMIT'
            | null = rateAllowed ? null : 'RATE_LIMITED';
          const lockOrganisationId = candidate?.organisationId ?? NON_MATCHING_ORGANISATION_ID;
          const lockUserId = candidate?.id ?? NON_MATCHING_USER_ID;
          // Keep the database operation shape fixed for known, unknown,
          // inactive, capped, and rate-suppressed identifiers. Non-matching
          // sentinel ids exercise the same ordered lock and count queries
          // without creating dummy principals or exposing account existence.
          const organisation = await lockOrganisation(tx, lockOrganisationId, 'SHARE');
          let lockedUser = await lockUser(tx, lockOrganisationId, lockUserId, 'UPDATE');
          const now = await databaseNow(tx);
          const outstanding = await tx.passwordRecoveryRequest.count({
            where: {
              userId: lockUserId,
              terminatedAt: null,
              expiresAt: { gt: now },
              deliveryState: { in: ['PENDING', 'SENDING', 'ACCEPTED', 'UNCERTAIN'] },
            },
          });

          if (
            !candidate || !organisation || organisation.lifecycleStatus !== 'ACTIVE' ||
            !lockedUser || lockedUser.lifecycleStatus !== 'ACTIVE' ||
            !isCanonicalAccountEmail(lockedUser.email)
          ) {
            suppressionReason ??= 'NO_ELIGIBLE_ACCOUNT';
            lockedUser = null;
          } else if (outstanding >= MAX_OUTSTANDING_REQUESTS) {
            suppressionReason ??= 'OUTSTANDING_LIMIT';
            lockedUser = null;
          } else if (suppressionReason !== null) {
            lockedUser = null;
          }

          const expiresAt = new Date(now.getTime() + RESET_EXPIRY_MS);
          if (!lockedUser || suppressionReason !== null) {
            await tx.passwordRecoveryRequest.create({
              data: {
                id: requestId,
                source: 'SELF_SERVICE_EMAIL',
                identifierDigest,
                requestIpDigest,
                requestNetworkDigest,
                rateKeyVersion: AUTH_RECOVERY_KEY_VERSION,
                deliveryState: 'SUPPRESSED',
                suppressionReason: suppressionReason ?? 'NO_ELIGIBLE_ACCOUNT',
                createdAt: now,
                updatedAt: now,
              },
            });
            return null;
          }

          await tx.passwordRecoveryRequest.create({
            data: {
              id: requestId,
              source: 'SELF_SERVICE_EMAIL',
              organisationId: lockedUser.organisationId,
              userId: lockedUser.id,
              identifierDigest,
              requestIpDigest,
              requestNetworkDigest,
              rateKeyVersion: AUTH_RECOVERY_KEY_VERSION,
              tokenHash: tokenMaterial.tokenHash,
              tokenNonce: tokenMaterial.tokenNonceHex,
              tokenKeyVersion: tokenMaterial.tokenKeyVersion,
              recipientEmail: lockedUser.email,
              recipientName: displayName(lockedUser),
              frontendOrigin,
              deliveryTemplateVersion: SECURITY_EMAIL_TEMPLATE_VERSION,
              deliveryState: 'PENDING',
              deliveryAttemptCount: 0,
              nextDeliveryAttemptAt: now,
              expiresAt,
              createdAt: now,
              updatedAt: now,
            },
          });
          return requestId;
        });
        break;
      } catch (error) {
        if (attempt === 0 && isUniqueCollision(error)) continue;
        throw error;
      }
    }

    if (deliveryRequestId) {
      try {
        await this.deliveryWakeup.wakePasswordRecoveryDelivery(deliveryRequestId);
      } catch {
        // The durable PENDING row is authoritative. A wake-up optimization must
        // never change the neutral public response or discard queued delivery.
      }
    }
    await this.equalizeSuccessfulForgotPasswordResponse(
      responseStartedAtMs,
      responseTargetDurationMs,
    );
    return { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE };
  }

  async resetPassword(
    token: string,
    password: string,
    context: PasswordRecoveryRequestContext,
  ): Promise<{ message: string }> {
    const tokenHash = hashPasswordRecoveryToken(token);
    const { networkAddress } = canonicalizePasswordRecoveryAddress(context.ipAddress);
    const tokenRateDigest = derivePasswordRecoveryRateDigest('reset-token', tokenHash);
    const networkRateDigest = derivePasswordRecoveryRateDigest('reset-network', networkAddress);

    const rateAllowed = await this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      return consumeRules(tx, [
        { scope: 'RESET_TOKEN_15M', digest: tokenRateDigest, windowSeconds: 15 * 60, maximum: 5 },
        { scope: 'RESET_TOKEN_24H', digest: tokenRateDigest, windowSeconds: 24 * 60 * 60, maximum: 20 },
        { scope: 'RESET_NETWORK_15M', digest: networkRateDigest, windowSeconds: 15 * 60, maximum: 30 },
        { scope: 'RESET_NETWORK_24H', digest: networkRateDigest, windowSeconds: 24 * 60 * 60, maximum: 200 },
      ]);
    });
    if (!rateAllowed) throw recoveryRateLimited();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidResetToken();

    const requestLocator = await this.prisma.passwordRecoveryRequest.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, organisationId: true },
    });
    if (!requestLocator?.userId || !requestLocator.organisationId) throw invalidResetToken();
    const locatorUserId = requestLocator.userId;
    const locatorOrganisationId = requestLocator.organisationId;

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const organisation = await lockOrganisation(tx, locatorOrganisationId, 'UPDATE');
      const user = await lockUser(tx, locatorOrganisationId, locatorUserId, 'UPDATE');
      const requests = await tx.$queryRaw<LockedRecoveryRequest[]>`
        SELECT "id", "source", "tokenHash", "deliveryState", "expiresAt", "terminatedAt"
        FROM "PasswordRecoveryRequest"
        WHERE "userId" = ${locatorUserId}
          AND "organisationId" = ${locatorOrganisationId}
        ORDER BY "id"
        FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "AuthSession"
        WHERE "userId" = ${locatorUserId}
          AND "revokedAt" IS NULL
        ORDER BY "id"
        FOR UPDATE
      `;
      const now = await databaseNow(tx);
      const presented = requests.find(
        (request) => request.id === requestLocator.id && request.tokenHash === tokenHash,
      );

      if (
        !organisation || organisation.lifecycleStatus !== 'ACTIVE' ||
        !user || user.lifecycleStatus !== 'ACTIVE' ||
        !isCanonicalAccountEmail(user.email) ||
        !presented || presented.terminatedAt !== null || !presented.expiresAt ||
        presented.expiresAt <= now || !CONSUMABLE_DELIVERY_STATES.has(presented.deliveryState)
      ) {
        throw invalidResetToken();
      }

      const terminated = await tx.passwordRecoveryRequest.updateMany({
        where: {
          userId: user.id,
          organisationId: user.organisationId,
          terminatedAt: null,
        },
        data: {
          terminatedAt: now,
          terminationReason: 'PASSWORD_RESET_COMPLETED',
          nextDeliveryAttemptAt: null,
        },
      });
      if (terminated.count < 1) throw invalidResetToken();

      const recoveryRequestId = presented.id;
      const terminatedRequestCount = terminated.count;

      const changed = await tx.user.updateMany({
        where: {
          id: user.id,
          organisationId: user.organisationId,
          lifecycleStatus: 'ACTIVE',
        },
        data: {
          passwordHash,
        },
      });
      if (changed.count !== 1) throw invalidResetToken();

      const revoked = await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revocationReason: 'PASSWORD_RESET' },
      });

      const personalServerReset = isPersonalServerDeployment();
      const audit = await tx.securityAuditEvent.create({
        data: {
          organisationId: user.organisationId,
          // Keep the stored Prisma enum compatible with the previous p109
          // runtime. The reset truthfully revokes every active session; the
          // append-only context gives current clients the more specific event.
          type: 'ALL_SESSIONS_REVOKED',
          actorKind: personalServerReset ? 'SUPPORT' : 'SYSTEM',
          actorLabel: personalServerReset
            ? 'Personal-server operator'
            : 'Self-service recovery',
          subjectLabel: displayName(user),
          subjectUserId: user.id,
          reason: personalServerReset
            ? 'Password reset completed through the restricted personal-server operator flow.'
            : 'Password reset completed using a one-time recovery link.',
          requestId: context.requestId ? boundedEvidence(context.requestId, 128) || undefined : undefined,
          context: {
            eventKind: 'PASSWORD_RESET_COMPLETED',
            method: personalServerReset
              ? 'PERSONAL_SERVER_OPERATOR'
              : 'PASSWORD_RECOVERY_LINK',
            recoveryRequestId,
            terminatedRequestCount,
            revokedSessionCount: revoked.count,
          } satisfies Prisma.InputJsonObject,
          occurredAt: now,
        },
        select: { id: true },
      });

      if (!personalServerReset) {
        await tx.authSecurityEmailOutbox.create({
          data: {
            kind: 'PASSWORD_RESET_COMPLETED_NOTICE',
            organisationId: user.organisationId,
            userId: user.id,
            auditEventId: audit.id,
            recipientEmail: user.email,
            recipientName: displayName(user),
            deliveryTemplateVersion: SECURITY_EMAIL_TEMPLATE_VERSION,
            deliveryState: 'PENDING',
            deliveryAttemptCount: 0,
            nextDeliveryAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
    });

    return { message: 'Password has been reset successfully.' };
  }
}
