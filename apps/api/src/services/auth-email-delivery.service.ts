import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  EmailService,
  type SecurityEmailDeliveryResult,
} from './email.service.js';
import {
  derivePasswordRecoveryToken,
  hashPasswordRecoveryToken,
} from './password-recovery-crypto.js';
import { assertAuthRecoveryControlForCurrentSecret } from './auth-recovery-control.js';

const MAX_DELIVERY_ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 30 * 1000;
const SECOND_RETRY_DELAY_MS = 2 * 60 * 1000;
const DELIVERY_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_OPERATOR_REVIEW_ALERT_CLAIM_STALE_MS = 5 * 60 * 1000;

type TransactionClient = Prisma.TransactionClient;

export type AuthEmailDeliveryRunResult = {
  processed: number;
  accepted: number;
  rejected: number;
  uncertain: number;
  keyUnavailable: number;
  retryScheduled: number;
  staleQuarantined: number;
  cleaned: number;
};

export type AuthOperatorReviewAlertClaim = {
  claimToken: string;
  affectedCount: number;
};

type ClaimedPasswordRecovery = {
  id: string;
  claimToken: string;
  organisationId: string;
  userId: string;
  token: string;
  recipientEmail: string;
  recipientName: string;
  frontendOrigin: string;
  deliveryTemplateVersion: number;
  deliveryAttemptCount: number;
};

type PasswordRecoveryClaimResult =
  | { kind: 'CLAIMED'; claim: ClaimedPasswordRecovery }
  | { kind: 'KEY_UNAVAILABLE' };

type ClaimedSecurityNotice = {
  id: string;
  claimToken: string;
  organisationId: string;
  userId: string;
  recipientEmail: string;
  recipientName: string;
  changedAt: Date;
  deliveryTemplateVersion: number;
  deliveryAttemptCount: number;
};

type DeliveryFinalization = 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN' | 'RETRY_SCHEDULED';

export type AuthEmailDeliveryStore = {
  prepare(
    now: Date,
    staleSendingMs: number,
    limit: number,
  ): Promise<{ staleQuarantined: number }>;
  claimPasswordRecovery(now: Date): Promise<PasswordRecoveryClaimResult | null>;
  finalizePasswordRecovery(
    claim: ClaimedPasswordRecovery,
    outcome: SecurityEmailDeliveryResult,
    now: Date,
  ): Promise<DeliveryFinalization>;
  claimSecurityNotice(now: Date): Promise<ClaimedSecurityNotice | null>;
  finalizeSecurityNotice(
    claim: ClaimedSecurityNotice,
    outcome: SecurityEmailDeliveryResult,
    now: Date,
  ): Promise<DeliveryFinalization>;
  claimOperatorReviewAlert(
    now: Date,
    limit: number,
  ): Promise<AuthOperatorReviewAlertClaim | null>;
  markOperatorReviewAlertSent(
    claim: AuthOperatorReviewAlertClaim,
    now: Date,
  ): Promise<number>;
  releaseOperatorReviewAlertClaim(
    claim: AuthOperatorReviewAlertClaim,
  ): Promise<number>;
  cleanup(now: Date, limit: number): Promise<number>;
};

type CountRow = { count: bigint | number };

function rowCount(rows: CountRow[]): number {
  return Number(rows[0]?.count ?? 0);
}

function operatorReviewAlertBudgets(limit: number): {
  recovery: number;
  securityNotice: number;
} {
  if (!Number.isInteger(limit) || limit < 2 || limit > 1_000) {
    throw new TypeError('Authentication operator-review alert limit must be an integer from 2 to 1000');
  }
  return {
    recovery: Math.ceil(limit / 2),
    securityNotice: Math.floor(limit / 2),
  };
}

function retryAt(now: Date, attemptCount: number): Date {
  const delay = attemptCount <= 1 ? FIRST_RETRY_DELAY_MS : SECOND_RETRY_DELAY_MS;
  return new Date(now.getTime() + delay);
}

export function authEmailCleanupBudgets(limit: number): {
  recovery: number;
  securityNotice: number;
  rateBucket: number;
} {
  if (!Number.isInteger(limit) || limit < 3 || limit > 1_000) {
    throw new TypeError('Authentication email cleanup limit must be an integer from 3 to 1000');
  }
  const base = Math.floor(limit / 3);
  const remainder = limit % 3;
  return {
    recovery: base + (remainder >= 1 ? 1 : 0),
    securityNotice: base + (remainder >= 2 ? 1 : 0),
    rateBucket: base,
  };
}

export function shouldRetrySecurityEmailOutcome(
  outcome: SecurityEmailDeliveryResult,
): boolean {
  // Ambiguous acceptance is never retried. The original token remains usable
  // in UNCERTAIN state, and another provider call could duplicate delivery.
  return outcome.outcome === 'REJECTED' && outcome.retryable;
}

export function deriveVerifiedPasswordRecoveryToken(input: {
  requestId: string;
  tokenNonce: string;
  tokenKeyVersion: number;
  tokenHash: string;
}): string | null {
  let token: string;
  try {
    token = derivePasswordRecoveryToken({
      requestId: input.requestId,
      tokenNonceHex: input.tokenNonce,
      tokenKeyVersion: input.tokenKeyVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      message.startsWith('Unsupported password recovery token key version:') ||
      message === 'Password recovery request id must be a UUIDv4' ||
      message === 'Password recovery token nonce must be 32 lowercase hexadecimal bytes'
    ) {
      return null;
    }
    // Invalid/missing current root-key configuration is a runtime outage, not
    // evidence that this row's historical key is unavailable. Let the job fail
    // without terminating every queued request.
    throw error;
  }
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) return null;

  const derivedHash = Buffer.from(hashPasswordRecoveryToken(token), 'hex');
  const storedHash = Buffer.from(input.tokenHash, 'hex');
  return crypto.timingSafeEqual(derivedHash, storedHash) ? token : null;
}

export class PrismaAuthEmailDeliveryStore implements AuthEmailDeliveryStore {
  constructor(private prisma: PrismaClient) {}

  async prepare(
    now: Date,
    staleSendingMs: number,
    limit: number,
  ): Promise<{ staleQuarantined: number }> {
    const staleBefore = new Date(now.getTime() - staleSendingMs);
    const [recoveryStale, noticeStale] = await this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const recoveryRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "PasswordRecoveryRequest"
          WHERE "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
            AND "claimedAt" < ${staleBefore}
          ORDER BY "claimedAt", "id"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), quarantined AS (
          UPDATE "PasswordRecoveryRequest" AS request
          SET
            "deliveryState" = 'UNCERTAIN'::"PasswordRecoveryDeliveryState",
            "claimToken" = NULL,
            "deliveryFinalizedAt" = ${now},
            "nextDeliveryAttemptAt" = NULL,
            "updatedAt" = ${now}
          FROM selected
          WHERE request."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM quarantined
      `;
      const noticeRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "AuthSecurityEmailOutbox"
          WHERE "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
            AND "claimedAt" < ${staleBefore}
          ORDER BY "claimedAt", "id"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), quarantined AS (
          UPDATE "AuthSecurityEmailOutbox" AS outbox
          SET
            "deliveryState" = 'UNCERTAIN'::"AuthSecurityEmailDeliveryState",
            "claimToken" = NULL,
            "deliveryFinalizedAt" = ${now},
            "nextDeliveryAttemptAt" = NULL,
            "updatedAt" = ${now}
          FROM selected
          WHERE outbox."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM quarantined
      `;
      await tx.$executeRaw`
        WITH selected AS (
          SELECT request."id"
          FROM "PasswordRecoveryRequest" AS request
          JOIN "User" AS account
            ON account."id" = request."userId"
           AND account."organisationId" = request."organisationId"
          JOIN "Organisation" AS organisation
            ON organisation."id" = request."organisationId"
          WHERE request."terminatedAt" IS NULL
            AND (
              account."lifecycleStatus" <> 'ACTIVE'::"UserLifecycleStatus"
              OR organisation."lifecycleStatus" <> 'ACTIVE'::"OrganisationLifecycleStatus"
            )
          ORDER BY request."id"
          LIMIT ${limit}
          FOR UPDATE OF request SKIP LOCKED
        )
        UPDATE "PasswordRecoveryRequest" AS request
        SET
          "terminatedAt" = ${now},
          "terminationReason" = 'ACCOUNT_INACTIVE'::"PasswordRecoveryTerminationReason",
          "nextDeliveryAttemptAt" = NULL,
          "updatedAt" = ${now}
        FROM selected
        WHERE request."id" = selected."id"
      `;
      await tx.$executeRaw`
        WITH selected AS (
          SELECT "id"
          FROM "PasswordRecoveryRequest"
          WHERE "terminatedAt" IS NULL
            AND "expiresAt" <= ${now}
          ORDER BY "expiresAt", "id"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "PasswordRecoveryRequest" AS request
        SET
          "terminatedAt" = ${now},
          "terminationReason" = 'EXPIRED'::"PasswordRecoveryTerminationReason",
          "nextDeliveryAttemptAt" = NULL,
          "updatedAt" = ${now}
        FROM selected
        WHERE request."id" = selected."id"
      `;
      return [rowCount(recoveryRows), rowCount(noticeRows)] as const;
    });
    return { staleQuarantined: recoveryStale + noticeStale };
  }

  async claimPasswordRecovery(now: Date): Promise<PasswordRecoveryClaimResult | null> {
    const candidates = await this.prisma.$queryRaw<Array<{
      id: string;
      organisationId: string;
      userId: string;
    }>>`
      SELECT "id", "organisationId", "userId"
      FROM "PasswordRecoveryRequest"
      WHERE "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
        AND "terminatedAt" IS NULL
        AND "expiresAt" > ${now}
        AND "nextDeliveryAttemptAt" <= ${now}
        AND "deliveryAttemptCount" < ${MAX_DELIVERY_ATTEMPTS}
      ORDER BY "nextDeliveryAttemptAt", "id"
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const principalActive = await this.lockPrincipal(
        tx,
        candidate.organisationId,
        candidate.userId,
      );
      const rows = await tx.$queryRaw<Array<{
        id: string;
        organisationId: string;
        userId: string;
        tokenNonce: string;
        tokenKeyVersion: number;
        tokenHash: string;
        recipientEmail: string;
        recipientName: string;
        frontendOrigin: string;
        deliveryTemplateVersion: number;
        deliveryAttemptCount: number;
      }>>`
        SELECT
          "id", "organisationId", "userId", "tokenNonce", "tokenKeyVersion", "tokenHash",
          "recipientEmail", "recipientName", "frontendOrigin", "deliveryTemplateVersion",
          "deliveryAttemptCount"
        FROM "PasswordRecoveryRequest"
        WHERE "id" = ${candidate.id}::uuid
          AND "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
          AND "terminatedAt" IS NULL
          AND "expiresAt" > ${now}
          AND "nextDeliveryAttemptAt" <= ${now}
          AND "deliveryAttemptCount" < ${MAX_DELIVERY_ATTEMPTS}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return null;
      if (!principalActive) {
        await tx.$executeRaw`
          UPDATE "PasswordRecoveryRequest"
          SET
            "terminatedAt" = ${now},
            "terminationReason" = 'ACCOUNT_INACTIVE'::"PasswordRecoveryTerminationReason",
            "nextDeliveryAttemptAt" = NULL,
            "updatedAt" = ${now}
          WHERE "id" = ${row.id}::uuid
            AND "terminatedAt" IS NULL
        `;
        return null;
      }
      const token = deriveVerifiedPasswordRecoveryToken({
        requestId: row.id,
        tokenNonce: row.tokenNonce,
        tokenKeyVersion: row.tokenKeyVersion,
        tokenHash: row.tokenHash,
      });
      if (token === null) {
        const terminated = await tx.$executeRaw`
          UPDATE "PasswordRecoveryRequest"
          SET
            "terminatedAt" = ${now},
            "terminationReason" = 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason",
            "nextDeliveryAttemptAt" = NULL,
            "updatedAt" = ${now}
          WHERE "id" = ${row.id}::uuid
            AND "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
            AND "terminatedAt" IS NULL
        `;
        if (terminated !== 1) {
          throw new Error('Password recovery key-unavailable terminalization did not update one row');
        }
        return { kind: 'KEY_UNAVAILABLE' };
      }
      const claimToken = crypto.randomUUID();
      const changed = await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState",
          "claimToken" = ${claimToken}::uuid,
          "claimedAt" = ${now},
          "deliveryAttemptedAt" = ${now},
          "deliveryFinalizedAt" = NULL,
          "deliveryAttemptCount" = "deliveryAttemptCount" + 1,
          "nextDeliveryAttemptAt" = NULL,
          "providerMessageId" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${row.id}::uuid
          AND "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
      `;
      if (changed !== 1) return null;
      return {
        kind: 'CLAIMED',
        claim: {
          id: row.id,
          claimToken,
          organisationId: row.organisationId,
          userId: row.userId,
          token,
          recipientEmail: row.recipientEmail,
          recipientName: row.recipientName,
          frontendOrigin: row.frontendOrigin,
          deliveryTemplateVersion: row.deliveryTemplateVersion,
          deliveryAttemptCount: row.deliveryAttemptCount + 1,
        },
      };
    });
  }

  async finalizePasswordRecovery(
    claim: ClaimedPasswordRecovery,
    outcome: SecurityEmailDeliveryResult,
    now: Date,
  ): Promise<DeliveryFinalization> {
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const rows = await tx.$queryRaw<Array<{
        terminatedAt: Date | null;
        deliveryAttemptCount: number;
      }>>`
        SELECT "terminatedAt", "deliveryAttemptCount"
        FROM "PasswordRecoveryRequest"
        WHERE "id" = ${claim.id}::uuid
          AND "claimToken" = ${claim.claimToken}::uuid
          AND "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return 'UNCERTAIN';

      if (outcome.outcome === 'ACCEPTED') {
        await tx.$executeRaw`
          UPDATE "PasswordRecoveryRequest"
          SET
            "deliveryState" = 'ACCEPTED'::"PasswordRecoveryDeliveryState",
            "claimToken" = NULL,
            "deliveryFinalizedAt" = ${now},
            "nextDeliveryAttemptAt" = NULL,
            "providerMessageId" = ${outcome.providerMessageId},
            "updatedAt" = ${now}
          WHERE "id" = ${claim.id}::uuid
            AND "claimToken" = ${claim.claimToken}::uuid
            AND "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
        `;
        return 'ACCEPTED';
      }

      if (
        row.terminatedAt === null &&
        row.deliveryAttemptCount < MAX_DELIVERY_ATTEMPTS &&
        shouldRetrySecurityEmailOutcome(outcome)
      ) {
        const nextAttemptAt = retryAt(now, row.deliveryAttemptCount);
        await tx.$executeRaw`
          UPDATE "PasswordRecoveryRequest"
          SET
            "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState",
            "claimToken" = NULL,
            "claimedAt" = NULL,
            "deliveryAttemptedAt" = NULL,
            "deliveryFinalizedAt" = NULL,
            "nextDeliveryAttemptAt" = ${nextAttemptAt},
            "providerMessageId" = NULL,
            "updatedAt" = ${now}
          WHERE "id" = ${claim.id}::uuid
            AND "claimToken" = ${claim.claimToken}::uuid
            AND "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
        `;
        return 'RETRY_SCHEDULED';
      }

      if (outcome.outcome === 'REJECTED') {
        await tx.$executeRaw`
          UPDATE "PasswordRecoveryRequest"
          SET
            "deliveryState" = 'REJECTED'::"PasswordRecoveryDeliveryState",
            "claimToken" = NULL,
            "deliveryFinalizedAt" = ${now},
            "nextDeliveryAttemptAt" = NULL,
            "terminatedAt" = COALESCE("terminatedAt", ${now}),
            "terminationReason" = COALESCE(
              "terminationReason",
              'DELIVERY_REJECTED'::"PasswordRecoveryTerminationReason"
            ),
            "updatedAt" = ${now}
          WHERE "id" = ${claim.id}::uuid
            AND "claimToken" = ${claim.claimToken}::uuid
            AND "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
        `;
        return 'REJECTED';
      }

      await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "deliveryState" = 'UNCERTAIN'::"PasswordRecoveryDeliveryState",
          "claimToken" = NULL,
          "deliveryFinalizedAt" = ${now},
          "nextDeliveryAttemptAt" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${claim.id}::uuid
          AND "claimToken" = ${claim.claimToken}::uuid
          AND "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
      `;
      return 'UNCERTAIN';
    });
  }

  async claimSecurityNotice(now: Date): Promise<ClaimedSecurityNotice | null> {
    const candidates = await this.prisma.$queryRaw<Array<{
      id: string;
      organisationId: string;
      userId: string;
    }>>`
      SELECT "id", "organisationId", "userId"
      FROM "AuthSecurityEmailOutbox"
      WHERE "deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
        AND "nextDeliveryAttemptAt" <= ${now}
        AND "deliveryAttemptCount" < ${MAX_DELIVERY_ATTEMPTS}
      ORDER BY "nextDeliveryAttemptAt", "id"
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      await this.lockPrincipal(tx, candidate.organisationId, candidate.userId, false);
      const rows = await tx.$queryRaw<Array<{
        id: string;
        organisationId: string;
        userId: string;
        recipientEmail: string;
        recipientName: string;
        changedAt: Date;
        deliveryTemplateVersion: number;
        deliveryAttemptCount: number;
      }>>`
        SELECT
          outbox."id", outbox."organisationId", outbox."userId",
          outbox."recipientEmail", outbox."recipientName",
          audit."occurredAt" AS "changedAt", outbox."deliveryTemplateVersion",
          outbox."deliveryAttemptCount"
        FROM "AuthSecurityEmailOutbox" AS outbox
        JOIN "SecurityAuditEvent" AS audit ON audit."id" = outbox."auditEventId"
        WHERE outbox."id" = ${candidate.id}::uuid
          AND outbox."deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
          AND outbox."nextDeliveryAttemptAt" <= ${now}
          AND outbox."deliveryAttemptCount" < ${MAX_DELIVERY_ATTEMPTS}
        FOR UPDATE OF outbox
      `;
      const row = rows[0];
      if (!row) return null;
      const claimToken = crypto.randomUUID();
      const changed = await tx.$executeRaw`
        UPDATE "AuthSecurityEmailOutbox"
        SET
          "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState",
          "claimToken" = ${claimToken}::uuid,
          "claimedAt" = ${now},
          "deliveryAttemptedAt" = ${now},
          "deliveryFinalizedAt" = NULL,
          "deliveryAttemptCount" = "deliveryAttemptCount" + 1,
          "nextDeliveryAttemptAt" = NULL,
          "providerMessageId" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${row.id}::uuid
          AND "deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
      `;
      if (changed !== 1) return null;
      return {
        ...row,
        claimToken,
        deliveryAttemptCount: row.deliveryAttemptCount + 1,
      };
    });
  }

  async finalizeSecurityNotice(
    claim: ClaimedSecurityNotice,
    outcome: SecurityEmailDeliveryResult,
    now: Date,
  ): Promise<DeliveryFinalization> {
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const rows = await tx.$queryRaw<Array<{ deliveryAttemptCount: number }>>`
        SELECT "deliveryAttemptCount"
        FROM "AuthSecurityEmailOutbox"
        WHERE "id" = ${claim.id}::uuid
          AND "claimToken" = ${claim.claimToken}::uuid
          AND "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return 'UNCERTAIN';

      if (outcome.outcome === 'ACCEPTED') {
        await tx.$executeRaw`
          UPDATE "AuthSecurityEmailOutbox"
          SET
            "deliveryState" = 'ACCEPTED'::"AuthSecurityEmailDeliveryState",
            "claimToken" = NULL,
            "deliveryFinalizedAt" = ${now},
            "nextDeliveryAttemptAt" = NULL,
            "providerMessageId" = ${outcome.providerMessageId},
            "updatedAt" = ${now}
          WHERE "id" = ${claim.id}::uuid
            AND "claimToken" = ${claim.claimToken}::uuid
            AND "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
        `;
        return 'ACCEPTED';
      }

      if (
        row.deliveryAttemptCount < MAX_DELIVERY_ATTEMPTS &&
        shouldRetrySecurityEmailOutcome(outcome)
      ) {
        const nextAttemptAt = retryAt(now, row.deliveryAttemptCount);
        await tx.$executeRaw`
          UPDATE "AuthSecurityEmailOutbox"
          SET
            "deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState",
            "claimToken" = NULL,
            "claimedAt" = NULL,
            "deliveryAttemptedAt" = NULL,
            "deliveryFinalizedAt" = NULL,
            "nextDeliveryAttemptAt" = ${nextAttemptAt},
            "providerMessageId" = NULL,
            "updatedAt" = ${now}
          WHERE "id" = ${claim.id}::uuid
            AND "claimToken" = ${claim.claimToken}::uuid
            AND "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
        `;
        return 'RETRY_SCHEDULED';
      }

      const finalState = outcome.outcome === 'REJECTED' ? 'REJECTED' : 'UNCERTAIN';
      await tx.$executeRaw`
        UPDATE "AuthSecurityEmailOutbox"
        SET
          "deliveryState" = ${finalState}::"AuthSecurityEmailDeliveryState",
          "claimToken" = NULL,
          "deliveryFinalizedAt" = ${now},
          "nextDeliveryAttemptAt" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${claim.id}::uuid
          AND "claimToken" = ${claim.claimToken}::uuid
          AND "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
      `;
      return finalState;
    });
  }

  async claimOperatorReviewAlert(
    now: Date,
    limit: number,
  ): Promise<AuthOperatorReviewAlertClaim | null> {
    const budgets = operatorReviewAlertBudgets(limit);
    const staleBefore = new Date(
      now.getTime() - AUTH_OPERATOR_REVIEW_ALERT_CLAIM_STALE_MS,
    );
    const claimToken = crypto.randomUUID();
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const recoveryRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "PasswordRecoveryRequest"
          WHERE "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
            AND "reviewAlertedAt" IS NULL
            AND (
              "reviewAlertClaimedAt" IS NULL
              OR "reviewAlertClaimedAt" < ${staleBefore}
            )
            AND (
              "deliveryState" IN (
                'REJECTED'::"PasswordRecoveryDeliveryState",
                'UNCERTAIN'::"PasswordRecoveryDeliveryState"
              )
              OR "terminationReason" = 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason"
            )
          ORDER BY "createdAt", "id"
          LIMIT ${budgets.recovery}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE "PasswordRecoveryRequest" AS request
          SET
            "reviewAlertClaimToken" = ${claimToken}::uuid,
            "reviewAlertClaimedAt" = ${now},
            "updatedAt" = ${now}
          FROM selected
          WHERE request."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM claimed
      `;
      const securityNoticeRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "AuthSecurityEmailOutbox"
          WHERE "deliveryState" IN (
              'REJECTED'::"AuthSecurityEmailDeliveryState",
              'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
            )
            AND "reviewAlertedAt" IS NULL
            AND (
              "reviewAlertClaimedAt" IS NULL
              OR "reviewAlertClaimedAt" < ${staleBefore}
            )
          ORDER BY "createdAt", "id"
          LIMIT ${budgets.securityNotice}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE "AuthSecurityEmailOutbox" AS outbox
          SET
            "reviewAlertClaimToken" = ${claimToken}::uuid,
            "reviewAlertClaimedAt" = ${now},
            "updatedAt" = ${now}
          FROM selected
          WHERE outbox."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM claimed
      `;
      const affectedCount = rowCount(recoveryRows) + rowCount(securityNoticeRows);
      return affectedCount > 0 ? { claimToken, affectedCount } : null;
    });
  }

  async markOperatorReviewAlertSent(
    claim: AuthOperatorReviewAlertClaim,
    now: Date,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const recovery = await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "reviewAlertClaimToken" = NULL,
          "reviewAlertClaimedAt" = NULL,
          "reviewAlertedAt" = ${now},
          "updatedAt" = ${now}
        WHERE "reviewAlertClaimToken" = ${claim.claimToken}::uuid
          AND "reviewAlertedAt" IS NULL
      `;
      const securityNotices = await tx.$executeRaw`
        UPDATE "AuthSecurityEmailOutbox"
        SET
          "reviewAlertClaimToken" = NULL,
          "reviewAlertClaimedAt" = NULL,
          "reviewAlertedAt" = ${now},
          "updatedAt" = ${now}
        WHERE "reviewAlertClaimToken" = ${claim.claimToken}::uuid
          AND "reviewAlertedAt" IS NULL
      `;
      const acknowledged = recovery + securityNotices;
      if (acknowledged !== claim.affectedCount) {
        throw new Error('Authentication operator-review alert acknowledgement lost its exact claim');
      }
      return acknowledged;
    });
  }

  async releaseOperatorReviewAlertClaim(
    claim: AuthOperatorReviewAlertClaim,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const recovery = await tx.$executeRaw`
        UPDATE "PasswordRecoveryRequest"
        SET
          "reviewAlertClaimToken" = NULL,
          "reviewAlertClaimedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "reviewAlertClaimToken" = ${claim.claimToken}::uuid
          AND "reviewAlertedAt" IS NULL
      `;
      const securityNotices = await tx.$executeRaw`
        UPDATE "AuthSecurityEmailOutbox"
        SET
          "reviewAlertClaimToken" = NULL,
          "reviewAlertClaimedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "reviewAlertClaimToken" = ${claim.claimToken}::uuid
          AND "reviewAlertedAt" IS NULL
      `;
      const released = recovery + securityNotices;
      if (released !== claim.affectedCount) {
        throw new Error('Authentication operator-review alert release lost its exact claim');
      }
      return released;
    });
  }

  async cleanup(now: Date, limit: number): Promise<number> {
    const retainedAfter = new Date(now.getTime() - DELIVERY_EVIDENCE_RETENTION_MS);
    const budgets = authEmailCleanupBudgets(limit);
    return this.prisma.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      const recoveryRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "PasswordRecoveryRequest"
          WHERE "evidenceRetentionAnchorAt" < ${retainedAfter}
            AND "claimToken" IS NULL
            AND "reviewAlertClaimToken" IS NULL
            AND "deliveryState" <> 'SENDING'::"PasswordRecoveryDeliveryState"
            AND (
              "deliveryState" = 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
              OR "terminatedAt" IS NOT NULL
              OR ("expiresAt" IS NOT NULL AND "expiresAt" <= ${now})
            )
            AND (
              "source" <> 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
              OR (
                "deliveryState" NOT IN (
                  'REJECTED'::"PasswordRecoveryDeliveryState",
                  'UNCERTAIN'::"PasswordRecoveryDeliveryState"
                )
                AND "terminationReason" IS DISTINCT FROM 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason"
              )
              OR "reviewAlertedAt" IS NOT NULL
            )
          ORDER BY "id"
          LIMIT ${budgets.recovery}
          FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM "PasswordRecoveryRequest" AS request
          USING selected
          WHERE request."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM deleted
      `;
      const outboxRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "id"
          FROM "AuthSecurityEmailOutbox"
          WHERE "evidenceRetentionAnchorAt" < ${retainedAfter}
            AND "reviewAlertClaimToken" IS NULL
            AND "deliveryState" IN (
              'ACCEPTED'::"AuthSecurityEmailDeliveryState",
              'REJECTED'::"AuthSecurityEmailDeliveryState",
              'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
            )
            AND (
              "deliveryState" = 'ACCEPTED'::"AuthSecurityEmailDeliveryState"
              OR "reviewAlertedAt" IS NOT NULL
            )
          ORDER BY "id"
          LIMIT ${budgets.securityNotice}
          FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM "AuthSecurityEmailOutbox" AS outbox
          USING selected
          WHERE outbox."id" = selected."id"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM deleted
      `;
      const bucketRows = await tx.$queryRaw<CountRow[]>`
        WITH selected AS (
          SELECT "scope", "keyVersion", "subjectDigest", "windowStartedAt"
          FROM "AuthRecoveryRateLimitBucket"
          WHERE "expiresAt" <= ${now}
          ORDER BY "expiresAt"
          LIMIT ${budgets.rateBucket}
          FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM "AuthRecoveryRateLimitBucket" AS bucket
          USING selected
          WHERE bucket."scope" = selected."scope"
            AND bucket."keyVersion" = selected."keyVersion"
            AND bucket."subjectDigest" = selected."subjectDigest"
            AND bucket."windowStartedAt" = selected."windowStartedAt"
          RETURNING 1
        )
        SELECT COUNT(*)::BIGINT AS "count" FROM deleted
      `;
      return rowCount(recoveryRows) + rowCount(outboxRows) + rowCount(bucketRows);
    });
  }

  private async lockPrincipal(
    tx: TransactionClient,
    organisationId: string,
    userId: string,
    requireActive = true,
  ): Promise<boolean> {
    const organisations = await tx.$queryRaw<Array<{
      id: string;
      lifecycleStatus: string;
    }>>`
      SELECT "id", "lifecycleStatus"
      FROM "Organisation"
      WHERE "id" = ${organisationId}
      FOR SHARE
    `;
    const users = await tx.$queryRaw<Array<{
      id: string;
      lifecycleStatus: string;
    }>>`
      SELECT "id", "lifecycleStatus"
      FROM "User"
      WHERE "id" = ${userId} AND "organisationId" = ${organisationId}
      FOR SHARE
    `;
    if (organisations.length !== 1 || users.length !== 1) {
      throw new Error('Authentication email delivery principal is unavailable');
    }
    if (!requireActive) return true;
    return organisations[0].lifecycleStatus === 'ACTIVE' &&
      users[0].lifecycleStatus === 'ACTIVE';
  }
}

type SecurityEmailSender = Pick<
  EmailService,
  'sendPasswordRecoveryEmail' | 'sendPasswordResetCompletedNotice'
>;

export class AuthEmailDeliveryService {
  private store: AuthEmailDeliveryStore;
  private emailService: SecurityEmailSender;

  constructor(
    prisma: PrismaClient,
    emailService: SecurityEmailSender = new EmailService(),
    store: AuthEmailDeliveryStore = new PrismaAuthEmailDeliveryStore(prisma),
    private now: () => Date = () => new Date(),
  ) {
    this.emailService = emailService;
    this.store = store;
  }

  async processDueDeliveries(input: {
    limit: number;
    cleanupLimit: number;
    staleSendingMs: number;
  }): Promise<AuthEmailDeliveryRunResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('Authentication email delivery limit must be an integer from 1 to 100');
    }
    if (!Number.isInteger(input.cleanupLimit) || input.cleanupLimit < 3 || input.cleanupLimit > 1_000) {
      throw new TypeError('Authentication email cleanup limit must be an integer from 3 to 1000');
    }
    if (!Number.isInteger(input.staleSendingMs) || input.staleSendingMs < 16_000) {
      throw new TypeError('Authentication email stale-send threshold must be at least 16000 milliseconds');
    }

    const runNow = this.now();
    const prepared = await this.store.prepare(
      runNow,
      input.staleSendingMs,
      input.cleanupLimit,
    );
    const result: AuthEmailDeliveryRunResult = {
      processed: 0,
      accepted: 0,
      rejected: 0,
      // Stale claims are reported separately: they are terminal UNCERTAIN rows,
      // but keeping the counters disjoint prevents operator alerts double-counting them.
      uncertain: 0,
      keyUnavailable: 0,
      retryScheduled: 0,
      staleQuarantined: prepared.staleQuarantined,
      cleaned: 0,
    };

    for (let index = 0; index < input.limit; index += 1) {
      const claimResult = await this.store.claimPasswordRecovery(this.now());
      if (!claimResult) break;
      if (claimResult.kind === 'KEY_UNAVAILABLE') {
        result.processed += 1;
        result.keyUnavailable += 1;
        continue;
      }
      const claim = claimResult.claim;
      const outcome = await this.emailService.sendPasswordRecoveryEmail(
        claim.recipientEmail,
        claim.recipientName,
        claim.token,
        {
          idempotencyKey: `charitypilot-password-recovery-v${claim.deliveryTemplateVersion}:${claim.id}`,
          templateVersion: claim.deliveryTemplateVersion,
          frontendOrigin: claim.frontendOrigin,
        },
      );
      const finalization = await this.store.finalizePasswordRecovery(
        claim,
        outcome,
        this.now(),
      );
      this.recordFinalization(result, finalization);
    }

    for (let index = 0; index < input.limit; index += 1) {
      const claim = await this.store.claimSecurityNotice(this.now());
      if (!claim) break;
      const outcome = await this.emailService.sendPasswordResetCompletedNotice(
        claim.recipientEmail,
        claim.recipientName,
        claim.changedAt,
        {
          idempotencyKey: `charitypilot-security-email-v${claim.deliveryTemplateVersion}:${claim.id}`,
          templateVersion: claim.deliveryTemplateVersion,
        },
      );
      const finalization = await this.store.finalizeSecurityNotice(
        claim,
        outcome,
        this.now(),
      );
      this.recordFinalization(result, finalization);
    }

    result.cleaned = await this.store.cleanup(this.now(), input.cleanupLimit);
    return result;
  }

  async claimOperatorReviewAlert(limit: number): Promise<AuthOperatorReviewAlertClaim | null> {
    operatorReviewAlertBudgets(limit);
    return this.store.claimOperatorReviewAlert(this.now(), limit);
  }

  async markOperatorReviewAlertSent(
    claim: AuthOperatorReviewAlertClaim,
  ): Promise<number> {
    return this.store.markOperatorReviewAlertSent(claim, this.now());
  }

  async releaseOperatorReviewAlertClaim(
    claim: AuthOperatorReviewAlertClaim,
  ): Promise<number> {
    return this.store.releaseOperatorReviewAlertClaim(claim);
  }

  private recordFinalization(
    result: AuthEmailDeliveryRunResult,
    finalization: DeliveryFinalization,
  ): void {
    result.processed += 1;
    if (finalization === 'ACCEPTED') result.accepted += 1;
    else if (finalization === 'REJECTED') result.rejected += 1;
    else if (finalization === 'UNCERTAIN') result.uncertain += 1;
    else result.retryScheduled += 1;
  }
}
