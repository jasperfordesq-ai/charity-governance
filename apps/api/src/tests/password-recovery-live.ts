import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import {
  authRecoverySecretFingerprint,
  derivePasswordRecoveryRateDigest,
  derivePasswordRecoveryToken,
} from '../services/password-recovery-crypto.js';
import { PasswordRecoveryService } from '../services/password-recovery.service.js';
import {
  AUTH_OPERATOR_REVIEW_ALERT_CLAIM_STALE_MS,
  AuthEmailDeliveryService,
  PrismaAuthEmailDeliveryStore,
} from '../services/auth-email-delivery.service.js';
import {
  PrismaAuthRecoverySecretRotationStore,
  authRecoverySecretActivationConfirmation,
  authRecoverySecretRotationConfirmation,
  parseAuthRecoverySecretRotationArgs,
  runAuthRecoverySecretRotation,
  type AuthRecoverySecretRotationCounts,
} from '../jobs/rotate-auth-recovery-secret.js';
import { assertAuthRecoveryControlForCurrentSecret } from '../services/auth-recovery-control.js';

function docker(args: string[], timeout = 30_000) {
  return spawnSync('docker', args, {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
  });
}

function assertCommand(result: ReturnType<typeof docker>, operation: string): void {
  assert.equal(
    result.status,
    0,
    `${operation} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown').slice(0, 3000)}`,
  );
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], 5_000).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disposable password-recovery PostgreSQL fixture did not become ready');
}

async function removeContainer(container: string): Promise<void> {
  docker(['rm', '--force', container], 20_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const residue = docker(['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}']);
    assertCommand(residue, 'Password-recovery PostgreSQL residue check');
    if (!residue.stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Disposable PostgreSQL container ${container} was not removed`);
}

export async function runPasswordRecoveryConcurrencyProof(postgresImage: string): Promise<void> {
  const container = `charitypilot-password-recovery-${randomUUID()}`;
  const password = 'password-recovery-fixture-only';
  const previousSecret = process.env.AUTH_RECOVERY_SECRET;
  const previousFrontend = process.env.FRONTEND_URL;
  process.env.AUTH_RECOVERY_SECRET = Buffer.alloc(48, 0x71).toString('base64url');
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';

  const started = docker([
    'run', '--detach', '--rm', '--name', container,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    postgresImage,
  ], 120_000);
  assertCommand(started, 'Disposable password-recovery PostgreSQL startup');

  let firstClient: PrismaClient | undefined;
  let secondClient: PrismaClient | undefined;
  try {
    await waitForPostgres(container);
    const publishedPort = docker(['port', container, '5432/tcp']);
    assertCommand(publishedPort, 'Disposable password-recovery PostgreSQL port lookup');
    const port = publishedPort.stdout.trim().match(/127\.0\.0\.1:(\d+)/u)?.[1];
    assert.ok(port, `Unexpected loopback port output: ${publishedPort.stdout.trim()}`);
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?schema=public`;

    const require = (await import('node:module')).createRequire(import.meta.url);
    const prismaCli = require.resolve('prisma/build/index.js');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      migrated.status,
      0,
      `Password-recovery migrate deploy failed: ${(migrated.stderr || migrated.stdout || migrated.error?.message || '').slice(0, 3000)}`,
    );

    firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([firstClient.$connect(), secondClient.$connect()]);
    assert.equal((await firstClient.authRecoveryControl.findUniqueOrThrow({
      where: { id: 1 }, select: { activeSecretFingerprint: true },
    })).activeSecretFingerprint, null);
    await assert.rejects(
      () => new PrismaAuthRecoverySecretRotationStore(firstClient!).inspect(),
      /has not been explicitly bound/u,
    );
    assert.equal((await firstClient.authRecoveryControl.findUniqueOrThrow({
      where: { id: 1 }, select: { activeSecretFingerprint: true },
    })).activeSecretFingerprint, null);
    const initialPasswordHash = await bcrypt.hash('OriginalPassword1', 12);
    const overlongAccountSuffix = '@example.invalid';
    const overlongAccountEmail = `${'e'.repeat(255 - overlongAccountSuffix.length)}${overlongAccountSuffix}`;
    assert.equal(overlongAccountEmail.length, 255);
    await firstClient.$transaction(async (tx) => {
      await tx.organisation.create({
        data: { id: 'recovery-org', name: 'Recovery Concurrency Charity', charitablePurpose: [] },
      });
      await tx.user.create({
        data: {
          id: 'recovery-owner', organisationId: 'recovery-org',
          email: 'recovery-owner@example.invalid', name: 'Recovery Owner',
          passwordHash: initialPasswordHash,
          role: 'OWNER', emailVerified: true,
        },
      });
      await tx.user.createMany({
        data: [
          {
            id: 'legacy-roll-forward-owner', organisationId: 'recovery-org',
            email: 'legacy-roll-forward@example.invalid', name: 'Legacy Roll Forward',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'rollback-trigger-owner', organisationId: 'recovery-org',
            email: 'rollback-trigger@example.invalid', name: 'Rollback Trigger',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'delivery-rejected-owner', organisationId: 'recovery-org',
            email: 'delivery-rejected@example.invalid', name: 'Delivery Rejected',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'delivery-uncertain-owner', organisationId: 'recovery-org',
            email: 'delivery-uncertain@example.invalid', name: 'Delivery Uncertain',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'delivery-stale-owner', organisationId: 'recovery-org',
            email: 'delivery-stale@example.invalid', name: 'Delivery Stale',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'timing-known-owner', organisationId: 'recovery-org',
            email: 'timing-known@example.invalid', name: 'Timing Known',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'timing-inactive-owner', organisationId: 'recovery-org',
            email: 'timing-inactive@example.invalid', name: 'Timing Inactive',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true, lifecycleStatus: 'SUSPENDED',
          },
          {
            id: 'timing-capped-owner', organisationId: 'recovery-org',
            email: 'timing-capped@example.invalid', name: 'Timing Capped',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'timing-rate-owner', organisationId: 'recovery-org',
            email: 'timing-rate@example.invalid', name: 'Timing Rate',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
          {
            id: 'legacy-overlong-email-owner', organisationId: 'recovery-org',
            email: overlongAccountEmail, name: 'Legacy Overlong Email',
            passwordHash: initialPasswordHash,
            role: 'MEMBER', emailVerified: true,
          },
        ],
      });
    });

    const forgotService = new PasswordRecoveryService(firstClient);
    const forgotResults = await Promise.all(
      Array.from({ length: 5 }, (_, index) => forgotService.requestPasswordReset(
        'recovery-owner@example.invalid',
        { ipAddress: `203.0.113.${10 + index}`, requestId: `forgot-${index}` },
      )),
    );
    assert.equal(new Set(forgotResults.map((result) => result.message)).size, 1);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { userId: 'recovery-owner', deliveryState: 'PENDING', terminatedAt: null },
    }), 3);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { deliveryState: 'SUPPRESSED', suppressionReason: { in: ['RATE_LIMITED', 'OUTSTANDING_LIMIT'] } },
    }), 2);

    const overlongUnknownEmail = `u${overlongAccountEmail.slice(1)}`;
    const [knownOverlongResult, unknownOverlongResult] = await Promise.all([
      forgotService.requestPasswordReset(overlongAccountEmail, {
        ipAddress: '203.0.113.21', requestId: 'legacy-overlong-known',
      }),
      forgotService.requestPasswordReset(overlongUnknownEmail, {
        ipAddress: '203.0.113.22', requestId: 'legacy-overlong-unknown',
      }),
    ]);
    assert.deepEqual(knownOverlongResult, unknownOverlongResult);
    const overlongRows = await firstClient.passwordRecoveryRequest.findMany({
      where: {
        source: 'SELF_SERVICE_EMAIL',
        suppressionReason: 'NO_ELIGIBLE_ACCOUNT',
      },
      orderBy: { id: 'asc' },
      select: {
        deliveryState: true,
        suppressionReason: true,
        recipientEmail: true,
        userId: true,
      },
    });
    assert.deepEqual(overlongRows, [
      {
        deliveryState: 'SUPPRESSED',
        suppressionReason: 'NO_ELIGIBLE_ACCOUNT',
        recipientEmail: null,
        userId: null,
      },
      {
        deliveryState: 'SUPPRESSED',
        suppressionReason: 'NO_ELIGIBLE_ACCOUNT',
        recipientEmail: null,
        userId: null,
      },
    ]);

    const retiredLegacySlot = await firstClient.user.findUniqueOrThrow({
      where: { id: 'recovery-owner' },
      select: { resetToken: true, resetTokenExpiry: true },
    });
    assert.equal(retiredLegacySlot.resetToken, null);
    assert.equal(retiredLegacySlot.resetTokenExpiry, null);

    const selected = await firstClient.passwordRecoveryRequest.findFirstOrThrow({
      where: { userId: 'recovery-owner', deliveryState: 'PENDING' },
      orderBy: [{ nextDeliveryAttemptAt: 'asc' }, { id: 'asc' }],
    });
    assert.ok(selected.tokenNonce && selected.tokenKeyVersion);
    const rawToken = derivePasswordRecoveryToken({
      requestId: selected.id,
      tokenNonceHex: selected.tokenNonce,
      tokenKeyVersion: selected.tokenKeyVersion,
    });
    const acceptedSender = {
      async sendPasswordRecoveryEmail(
        _to: string,
        _name: string,
        token: string,
        options: { idempotencyKey: string },
      ) {
        assert.equal(token, rawToken);
        return {
          outcome: 'ACCEPTED' as const,
          providerMessageId: `provider-${options.idempotencyKey.split(':').at(-1)}`,
        };
      },
      async sendPasswordResetCompletedNotice(
        _to: string,
        _name: string,
        _changedAt: Date,
        options: { idempotencyKey: string },
      ) {
        return {
          outcome: 'ACCEPTED' as const,
          providerMessageId: `provider-${options.idempotencyKey.split(':').at(-1)}`,
        };
      },
    };
    const acceptedDelivery = new AuthEmailDeliveryService(firstClient, acceptedSender);
    const acceptedRecoveryRun = await acceptedDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.deepEqual(
      {
        processed: acceptedRecoveryRun.processed,
        accepted: acceptedRecoveryRun.accepted,
        rejected: acceptedRecoveryRun.rejected,
      },
      { processed: 1, accepted: 1, rejected: 0 },
    );
    assert.equal((await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: selected.id },
      select: { deliveryState: true, providerMessageId: true },
    })).deliveryState, 'ACCEPTED');

    for (const index of [1, 2]) {
      await firstClient.authSession.create({
        data: {
          userId: 'recovery-owner',
          refreshTokenHash: crypto.createHash('sha256').update(`refresh-${index}`).digest('hex'),
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }

    const firstReset = new PasswordRecoveryService(firstClient).resetPassword(
      rawToken, 'ReplacementPassword1',
      { ipAddress: '198.51.100.42', requestId: 'reset-first' },
    );
    const secondReset = new PasswordRecoveryService(secondClient).resetPassword(
      rawToken, 'ReplacementPassword1',
      { ipAddress: '198.51.100.42', requestId: 'reset-second' },
    );
    const outcomes = await Promise.allSettled([firstReset, secondReset]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const loser = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.ok(loser);
    assert.equal(loser.reason instanceof AppError, true);
    assert.equal((loser.reason as AppError).code, 'INVALID_RESET_TOKEN');

    const account = await firstClient.user.findUniqueOrThrow({ where: { id: 'recovery-owner' } });
    assert.equal(await bcrypt.compare('ReplacementPassword1', account.passwordHash), true);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { userId: 'recovery-owner', terminatedAt: null },
    }), 0);
    assert.equal(await firstClient.authSession.count({
      where: { userId: 'recovery-owner', revokedAt: null },
    }), 0);
    const resetAudits = await firstClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS "count"
      FROM "SecurityAuditEvent"
      WHERE "subjectUserId" = 'recovery-owner'
        AND "type" = 'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType"
        AND "context" ->> 'eventKind' = 'PASSWORD_RESET_COMPLETED'
        AND "context" ->> 'method' = 'PASSWORD_RECOVERY_LINK'
    `;
    assert.equal(resetAudits[0]?.count, 1);
    assert.equal(await firstClient.authSecurityEmailOutbox.count({
      where: { userId: 'recovery-owner', kind: 'PASSWORD_RESET_COMPLETED_NOTICE' },
    }), 1);
    const acceptedNoticeRun = await acceptedDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.equal(acceptedNoticeRun.processed, 1);
    assert.equal(acceptedNoticeRun.accepted, 1);
    assert.equal((await firstClient.authSecurityEmailOutbox.findFirstOrThrow({
      where: { userId: 'recovery-owner' },
      select: { deliveryState: true, providerMessageId: true },
    })).deliveryState, 'ACCEPTED');

    await new PasswordRecoveryService(firstClient).requestPasswordReset(
      'delivery-rejected@example.invalid',
      { ipAddress: '203.0.113.91', requestId: 'delivery-rejected-forgot' },
    );
    const rejectedDelivery = new AuthEmailDeliveryService(firstClient, {
      async sendPasswordRecoveryEmail() {
        return { outcome: 'REJECTED' as const, retryable: false };
      },
      async sendPasswordResetCompletedNotice() {
        assert.fail('no completion notice should be due');
      },
    });
    const rejectedRun = await rejectedDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.equal(rejectedRun.rejected, 1);

    await new PasswordRecoveryService(firstClient).requestPasswordReset(
      'delivery-uncertain@example.invalid',
      { ipAddress: '203.0.113.92', requestId: 'delivery-uncertain-forgot' },
    );
    const uncertainRecoveryDelivery = new AuthEmailDeliveryService(firstClient, {
      async sendPasswordRecoveryEmail() {
        return { outcome: 'UNCERTAIN' as const };
      },
      async sendPasswordResetCompletedNotice() {
        assert.fail('no completion notice should be due');
      },
    });
    const uncertainRecoveryRun = await uncertainRecoveryDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.equal(uncertainRecoveryRun.uncertain, 1);
    const uncertainRecoveryRequest = await firstClient.passwordRecoveryRequest.findFirstOrThrow({
      where: { userId: 'delivery-uncertain-owner', deliveryState: 'UNCERTAIN' },
    });
    assert.ok(uncertainRecoveryRequest.tokenNonce && uncertainRecoveryRequest.tokenKeyVersion);
    const uncertainRecoveryToken = derivePasswordRecoveryToken({
      requestId: uncertainRecoveryRequest.id,
      tokenNonceHex: uncertainRecoveryRequest.tokenNonce,
      tokenKeyVersion: uncertainRecoveryRequest.tokenKeyVersion,
    });
    await new PasswordRecoveryService(firstClient).resetPassword(
      uncertainRecoveryToken,
      'ReplacementPassword1',
      { ipAddress: '198.51.100.92', requestId: 'delivery-uncertain-reset' },
    );
    const uncertainNoticeDelivery = new AuthEmailDeliveryService(firstClient, {
      async sendPasswordRecoveryEmail() {
        assert.fail('no password recovery delivery should be due');
      },
      async sendPasswordResetCompletedNotice() {
        return { outcome: 'UNCERTAIN' as const };
      },
    });
    const uncertainNoticeRun = await uncertainNoticeDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.equal(uncertainNoticeRun.uncertain, 1);
    assert.equal(await firstClient.authSecurityEmailOutbox.count({
      where: { userId: 'delivery-uncertain-owner', deliveryState: 'UNCERTAIN' },
    }), 1);

    await new PasswordRecoveryService(firstClient).requestPasswordReset(
      'delivery-stale@example.invalid',
      { ipAddress: '203.0.113.93', requestId: 'delivery-stale-forgot' },
    );
    const staleRequest = await firstClient.passwordRecoveryRequest.findFirstOrThrow({
      where: { userId: 'delivery-stale-owner', deliveryState: 'PENDING' },
    });
    const staleClaimedAt = new Date();
    await firstClient.passwordRecoveryRequest.update({
      where: { id: staleRequest.id },
      data: {
        deliveryState: 'SENDING',
        claimToken: randomUUID(),
        claimedAt: staleClaimedAt,
        deliveryAttemptedAt: staleClaimedAt,
        deliveryAttemptCount: 1,
        nextDeliveryAttemptAt: null,
      },
    });
    const staleRunNow = new Date(staleClaimedAt.getTime() + 2 * 60 * 1000);
    const staleRecoveryDelivery = new AuthEmailDeliveryService(
      firstClient,
      {
        async sendPasswordRecoveryEmail() {
          assert.fail('a stale provider claim must be quarantined without another send');
        },
        async sendPasswordResetCompletedNotice() {
          assert.fail('no completion notice should be due');
        },
      },
      undefined,
      () => new Date(staleRunNow),
    );
    const staleRun = await staleRecoveryDelivery.processDueDeliveries({
      limit: 1,
      cleanupLimit: 3,
      staleSendingMs: 60_000,
    });
    assert.equal(staleRun.staleQuarantined, 1);
    assert.equal((await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: staleRequest.id }, select: { deliveryState: true },
    })).deliveryState, 'UNCERTAIN');

    const firstReviewService = new AuthEmailDeliveryService(firstClient, acceptedSender);
    const secondReviewService = new AuthEmailDeliveryService(secondClient, acceptedSender);
    const concurrentReviewClaims = await Promise.all([
      firstReviewService.claimOperatorReviewAlert(4),
      secondReviewService.claimOperatorReviewAlert(4),
    ]);
    assert.equal(concurrentReviewClaims.every((claim) => claim !== null), true);
    const initialReviewClaims = concurrentReviewClaims.filter(
      (claim): claim is NonNullable<typeof claim> => claim !== null,
    );
    assert.equal(
      initialReviewClaims.reduce((total, claim) => total + claim.affectedCount, 0),
      4,
    );
    assert.equal(new Set(initialReviewClaims.map((claim) => claim.claimToken)).size, 2);

    assert.equal(
      await firstReviewService.markOperatorReviewAlertSent(initialReviewClaims[0]),
      initialReviewClaims[0].affectedCount,
    );
    assert.equal(
      await secondReviewService.releaseOperatorReviewAlertClaim(initialReviewClaims[1]),
      initialReviewClaims[1].affectedCount,
    );
    const retriedReviewClaim = await firstReviewService.claimOperatorReviewAlert(4);
    assert.ok(retriedReviewClaim);
    assert.equal(retriedReviewClaim.affectedCount, initialReviewClaims[1].affectedCount);

    const staleReviewTakeoverAt = new Date(
      Date.now() + AUTH_OPERATOR_REVIEW_ALERT_CLAIM_STALE_MS + 1_000,
    );
    const staleReviewTakeoverService = new AuthEmailDeliveryService(
      secondClient,
      acceptedSender,
      undefined,
      () => new Date(staleReviewTakeoverAt),
    );
    const staleReviewTakeover = await staleReviewTakeoverService.claimOperatorReviewAlert(4);
    assert.ok(staleReviewTakeover);
    assert.notEqual(staleReviewTakeover.claimToken, retriedReviewClaim.claimToken);
    assert.equal(staleReviewTakeover.affectedCount, retriedReviewClaim.affectedCount);
    assert.equal(
      await staleReviewTakeoverService.markOperatorReviewAlertSent(staleReviewTakeover),
      staleReviewTakeover.affectedCount,
    );
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: {
        source: 'SELF_SERVICE_EMAIL',
        reviewAlertedAt: { not: null },
        OR: [
          { deliveryState: { in: ['REJECTED', 'UNCERTAIN'] } },
          { terminationReason: 'KEY_UNAVAILABLE' },
        ],
      },
    }), 3);
    assert.equal(await firstClient.authSecurityEmailOutbox.count({
      where: { deliveryState: 'UNCERTAIN', reviewAlertedAt: { not: null } },
    }), 1);
    assert.equal(await firstReviewService.claimOperatorReviewAlert(4), null);

    const retentionNow = new Date();
    const retentionOld = new Date(retentionNow.getTime() - 8 * 24 * 60 * 60 * 1000);
    const expiredOldId = randomUUID();
    const terminatedTodayId = randomUUID();
    for (const id of [expiredOldId, terminatedTodayId]) {
      await firstClient.passwordRecoveryRequest.create({
        data: {
          id,
          source: 'PERSONAL_SERVER_OPERATOR',
          organisationId: 'recovery-org',
          userId: 'timing-known-owner',
          tokenHash: crypto.createHash('sha256').update(`retention-${id}`).digest('hex'),
          deliveryState: 'ACCEPTED',
          expiresAt: new Date(retentionOld.getTime() + 60 * 60 * 1000),
          evidenceRetentionAnchorAt: retentionOld,
          createdAt: retentionOld,
          updatedAt: retentionOld,
        },
      });
    }
    await firstClient.passwordRecoveryRequest.update({
      where: { id: terminatedTodayId },
      data: {
        terminatedAt: retentionNow,
        terminationReason: 'EXPIRED',
      },
    });

    const alertRetentionId = randomUUID();
    const alertClaimedAt = new Date(retentionOld.getTime() + 60_000);
    const alertFinalizedAt = new Date(retentionOld.getTime() + 120_000);
    const retentionDigest = (label: string) => crypto.createHash('sha256')
      .update(`retention-alert-${label}`)
      .digest('hex');
    await firstClient.passwordRecoveryRequest.create({
      data: {
        id: alertRetentionId,
        source: 'SELF_SERVICE_EMAIL',
        organisationId: 'recovery-org',
        userId: 'timing-known-owner',
        identifierDigest: retentionDigest('identifier'),
        requestIpDigest: retentionDigest('ip'),
        requestNetworkDigest: retentionDigest('network'),
        rateKeyVersion: 1,
        tokenHash: retentionDigest('token'),
        tokenNonce: retentionDigest('nonce'),
        tokenKeyVersion: 1,
        recipientEmail: 'timing-known@example.invalid',
        recipientName: 'Timing Known',
        frontendOrigin: 'https://app.charitypilot.ie',
        deliveryTemplateVersion: 1,
        deliveryState: 'UNCERTAIN',
        claimedAt: alertClaimedAt,
        deliveryAttemptedAt: alertClaimedAt,
        deliveryFinalizedAt: alertFinalizedAt,
        deliveryAttemptCount: 1,
        expiresAt: new Date(retentionOld.getTime() + 60 * 60 * 1000),
        evidenceRetentionAnchorAt: alertFinalizedAt,
        createdAt: retentionOld,
        updatedAt: alertFinalizedAt,
      },
    });
    const retentionAlertClaim = await firstReviewService.claimOperatorReviewAlert(2);
    assert.ok(retentionAlertClaim);
    assert.equal(retentionAlertClaim.affectedCount, 1);
    await firstReviewService.markOperatorReviewAlertSent(retentionAlertClaim);
    const retainedAfterAlert = await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: alertRetentionId },
      select: { evidenceRetentionAnchorAt: true, reviewAlertedAt: true },
    });
    assert.ok(retainedAfterAlert.reviewAlertedAt);
    assert.equal(
      retainedAfterAlert.evidenceRetentionAnchorAt.getTime(),
      retainedAfterAlert.reviewAlertedAt.getTime(),
    );

    const cleanupStore = new PrismaAuthEmailDeliveryStore(firstClient);
    await cleanupStore.cleanup(new Date(retentionNow.getTime() + 1_000), 30);
    assert.equal(await firstClient.passwordRecoveryRequest.findUnique({
      where: { id: expiredOldId }, select: { id: true },
    }), null);
    assert.ok(await firstClient.passwordRecoveryRequest.findUnique({
      where: { id: terminatedTodayId }, select: { id: true },
    }));
    assert.ok(await firstClient.passwordRecoveryRequest.findUnique({
      where: { id: alertRetentionId }, select: { id: true },
    }));

    // Any password change outside the recovery service invokes the new-schema
    // trigger and prevents an outstanding capability from surviving.
    await new PasswordRecoveryService(firstClient).requestPasswordReset(
      'rollback-trigger@example.invalid',
      { ipAddress: '203.0.113.90', requestId: 'rollback-trigger-forgot' },
    );
    await firstClient.user.update({
      where: { id: 'rollback-trigger-owner' },
      data: { passwordHash: await bcrypt.hash('ChangedByP109Password1', 12) },
    });
    const rollbackTriggerUser = await firstClient.user.findUniqueOrThrow({
      where: { id: 'rollback-trigger-owner' },
      select: { resetToken: true, resetTokenExpiry: true },
    });
    assert.equal(rollbackTriggerUser.resetToken, null);
    assert.equal(rollbackTriggerUser.resetTokenExpiry, null);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: {
        userId: 'rollback-trigger-owner',
        terminatedAt: null,
      },
    }), 0);

    const timingStartedAt = new Date();
    for (let index = 0; index < 3; index += 1) {
      const createdAt = new Date(timingStartedAt.getTime() + index);
      await firstClient.passwordRecoveryRequest.create({
        data: {
          id: randomUUID(),
          source: 'PERSONAL_SERVER_OPERATOR',
          organisationId: 'recovery-org',
          userId: 'timing-capped-owner',
          tokenHash: crypto.createHash('sha256').update(`timing-capability-${index}`).digest('hex'),
          deliveryState: 'ACCEPTED',
          expiresAt: new Date(createdAt.getTime() + 45 * 60 * 1000),
          createdAt,
          updatedAt: createdAt,
        },
      });
    }
    const rateWindowStartedAt = new Date(
      Math.floor(timingStartedAt.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000,
    );
    await firstClient.authRecoveryRateLimitBucket.create({
      data: {
        scope: 'FORGOT_IDENTIFIER_15M',
        keyVersion: 1,
        subjectDigest: derivePasswordRecoveryRateDigest(
          'forgot-identifier',
          'timing-rate@example.invalid',
        ),
        windowStartedAt: rateWindowStartedAt,
        count: 3,
        windowEndsAt: new Date(rateWindowStartedAt.getTime() + 15 * 60 * 1000),
        expiresAt: new Date(rateWindowStartedAt.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    const equalizedTargetMs = 500;
    const timingService = new PasswordRecoveryService(firstClient, undefined, {
      nowMs: () => performance.now(),
      targetDurationMs: () => equalizedTargetMs,
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const timingVariants = [
      ['known', 'timing-known@example.invalid', '198.18.10.10'],
      ['unknown', 'timing-unknown@example.invalid', '198.18.20.10'],
      ['inactive', 'timing-inactive@example.invalid', '198.18.30.10'],
      ['outstanding-capped', 'timing-capped@example.invalid', '198.18.40.10'],
      ['rate-suppressed', 'timing-rate@example.invalid', '198.18.50.10'],
    ] as const;
    const measuredDurations: Array<{ label: string; durationMs: number }> = [];
    for (const [label, email, ipAddress] of timingVariants) {
      const startedAtMs = performance.now();
      await timingService.requestPasswordReset(email, {
        ipAddress,
        requestId: `real-pg-timing-${label}`,
      });
      measuredDurations.push({ label, durationMs: performance.now() - startedAtMs });
    }
    for (const measurement of measuredDurations) {
      assert.ok(
        measurement.durationMs >= equalizedTargetMs - 35,
        `${measurement.label} returned before the equalized real-PostgreSQL floor: ${measurement.durationMs.toFixed(1)}ms`,
      );
      assert.ok(
        measurement.durationMs <= equalizedTargetMs + 300,
        `${measurement.label} exceeded the equalized real-PostgreSQL scheduler tolerance: ${measurement.durationMs.toFixed(1)}ms`,
      );
    }
    const timingSpreadMs = Math.max(...measuredDurations.map(({ durationMs }) => durationMs))
      - Math.min(...measuredDurations.map(({ durationMs }) => durationMs));
    assert.ok(
      timingSpreadMs <= 250,
      `forgot-password category timing spread exceeded 250ms: ${JSON.stringify(measuredDurations)}`,
    );
    assert.equal((await firstClient.passwordRecoveryRequest.findFirstOrThrow({
      where: {
        identifierDigest: derivePasswordRecoveryRateDigest(
          'forgot-identifier',
          'timing-capped@example.invalid',
        ),
      },
      orderBy: { createdAt: 'desc' },
      select: { suppressionReason: true },
    })).suppressionReason, 'OUTSTANDING_LIMIT');
    assert.equal((await firstClient.passwordRecoveryRequest.findFirstOrThrow({
      where: {
        identifierDigest: derivePasswordRecoveryRateDigest(
          'forgot-identifier',
          'timing-rate@example.invalid',
        ),
      },
      orderBy: { createdAt: 'desc' },
      select: { suppressionReason: true },
    })).suppressionReason, 'RATE_LIMITED');

    // Prove the real restricted key-rotation store against PostgreSQL, not just
    // its parser/source contract. The fixture covers every deliverable state,
    // a legacy User slot, keyed buckets, and an already-enqueued completion
    // notice that must survive rotation.
    const rotationPasswordHash = await bcrypt.hash('OriginalPassword1', 12);
    await firstClient.$transaction(async (tx) => {
      await tx.organisation.create({
        data: {
          id: 'rotation-org',
          name: 'Recovery Rotation Charity',
          charitablePurpose: [],
        },
      });
      await tx.user.createMany({
        data: [
        {
          id: 'rotation-pending-user', organisationId: 'rotation-org',
          email: 'rotation-pending@example.invalid', name: 'Rotation Pending',
          passwordHash: rotationPasswordHash, role: 'OWNER', emailVerified: true,
        },
        {
          id: 'rotation-sending-user', organisationId: 'rotation-org',
          email: 'rotation-sending@example.invalid', name: 'Rotation Sending',
          passwordHash: rotationPasswordHash, role: 'MEMBER', emailVerified: true,
        },
        {
          id: 'rotation-accepted-user', organisationId: 'rotation-org',
          email: 'rotation-accepted@example.invalid', name: 'Rotation Accepted',
          passwordHash: rotationPasswordHash, role: 'MEMBER', emailVerified: true,
        },
        {
          id: 'rotation-uncertain-user', organisationId: 'rotation-org',
          email: 'rotation-uncertain@example.invalid', name: 'Rotation Uncertain',
          passwordHash: rotationPasswordHash, role: 'MEMBER', emailVerified: true,
        },
        {
          id: 'rotation-legacy-user', organisationId: 'rotation-org',
          email: 'rotation-legacy@example.invalid', name: 'Rotation Legacy',
          passwordHash: rotationPasswordHash, role: 'MEMBER', emailVerified: true,
        },
        ],
      });
    });

    const rotationRequestIds: Record<string, string> = {};
    for (const [index, state] of ['PENDING', 'SENDING', 'ACCEPTED', 'UNCERTAIN'].entries()) {
      const userId = `rotation-${state.toLowerCase()}-user`;
      const id = randomUUID();
      rotationRequestIds[state] = id;
      const digest = (label: string) => crypto.createHash('sha256')
        .update(`rotation-${label}-${index}`)
        .digest('hex');
      await firstClient.passwordRecoveryRequest.create({
        data: {
          id,
          source: 'SELF_SERVICE_EMAIL',
          organisationId: 'rotation-org',
          userId,
          identifierDigest: digest('identifier'),
          requestIpDigest: digest('ip'),
          requestNetworkDigest: digest('network'),
          rateKeyVersion: 1,
          tokenHash: digest('token'),
          tokenNonce: digest('nonce'),
          tokenKeyVersion: 1,
          recipientEmail: `rotation-${state.toLowerCase()}@example.invalid`,
          recipientName: `Rotation ${state}`,
          frontendOrigin: 'https://app.charitypilot.ie',
          deliveryTemplateVersion: 1,
          nextDeliveryAttemptAt: new Date(),
          expiresAt: new Date(Date.now() + 50 * 60 * 1000),
        },
      });
      if (state !== 'PENDING') {
        const claimedAt = new Date();
        await firstClient.passwordRecoveryRequest.update({
          where: { id },
          data: {
            deliveryState: 'SENDING',
            claimToken: randomUUID(),
            claimedAt,
            deliveryAttemptedAt: claimedAt,
            deliveryAttemptCount: 1,
            nextDeliveryAttemptAt: null,
          },
        });
        if (state === 'ACCEPTED') {
          await firstClient.passwordRecoveryRequest.update({
            where: { id },
            data: {
              deliveryState: 'ACCEPTED',
              claimToken: null,
              deliveryFinalizedAt: new Date(),
              providerMessageId: `rotation-provider-${id}`,
            },
          });
        } else if (state === 'UNCERTAIN') {
          await firstClient.passwordRecoveryRequest.update({
            where: { id },
            data: {
              deliveryState: 'UNCERTAIN',
              claimToken: null,
              deliveryFinalizedAt: new Date(),
            },
          });
        }
      }
    }

    const rateWindowStart = new Date();
    await firstClient.authRecoveryRateLimitBucket.createMany({
      data: [
        {
          scope: 'FORGOT_IDENTIFIER_15M', keyVersion: 1,
          subjectDigest: crypto.createHash('sha256').update('rotation-bucket-one').digest('hex'),
          windowStartedAt: rateWindowStart,
          windowEndsAt: new Date(rateWindowStart.getTime() + 15 * 60 * 1000),
          expiresAt: new Date(rateWindowStart.getTime() + 16 * 60 * 60 * 1000),
        },
        {
          scope: 'RESET_NETWORK_15M', keyVersion: 1,
          subjectDigest: crypto.createHash('sha256').update('rotation-bucket-two').digest('hex'),
          windowStartedAt: rateWindowStart,
          windowEndsAt: new Date(rateWindowStart.getTime() + 15 * 60 * 1000),
          expiresAt: new Date(rateWindowStart.getTime() + 16 * 60 * 60 * 1000),
        },
      ],
    });

    // Simulate one residual predecessor slot on the disposable fixture. The
    // current-schema trigger normally forbids this state; rotation must still
    // clear it if a controlled recovery or interrupted cutover exposes it.
    await firstClient.$executeRawUnsafe(
      'ALTER TABLE "User" DISABLE TRIGGER "User_guard_retired_password_recovery_slot"',
    );
    try {
      await firstClient.user.update({
        where: { id: 'rotation-legacy-user' },
        data: {
          resetToken: crypto.createHash('sha256').update('rotation-legacy-slot').digest('hex'),
          resetTokenExpiry: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
    } finally {
      await firstClient.$executeRawUnsafe(
        'ALTER TABLE "User" ENABLE TRIGGER "User_guard_retired_password_recovery_slot"',
      );
    }

    const securityNoticesBefore = await firstClient.authSecurityEmailOutbox.findMany({
      select: { id: true, deliveryState: true, providerMessageId: true },
      orderBy: { id: 'asc' },
    });
    assert.ok(securityNoticesBefore.length >= 1);
    const expectedCounts: AuthRecoverySecretRotationCounts = {
      generation: (await firstClient.authRecoveryControl.findUniqueOrThrow({
        where: { id: 1 }, select: { generation: true },
      })).generation,
      capabilities: await firstClient.passwordRecoveryRequest.count({
        where: { deliveryState: { not: 'SUPPRESSED' }, terminatedAt: null },
      }),
      requestEvidenceRows: await firstClient.passwordRecoveryRequest.count({
        where: {
          OR: [
            { identifierDigest: { not: null } },
            { requestIpDigest: { not: null } },
            { requestNetworkDigest: { not: null } },
            { rateKeyVersion: { not: null } },
          ],
        },
      }),
      legacySlots: await firstClient.user.count({
        where: { OR: [{ resetToken: { not: null } }, { resetTokenExpiry: { not: null } }] },
      }),
      rateBuckets: await firstClient.authRecoveryRateLimitBucket.count(),
      securityNotices: securityNoticesBefore.length,
    };
    assert.ok(expectedCounts.capabilities >= 4);
    assert.equal(expectedCounts.legacySlots, 1);
    assert.ok(expectedCounts.rateBuckets >= 2);
    assert.ok(expectedCounts.requestEvidenceRows >= 4);

    const rotationEnv = {
      NODE_ENV: 'production',
      CHARITYPILOT_DEPLOYMENT_MODE: 'production',
      DATABASE_URL: databaseUrl,
    };
    const store = new PrismaAuthRecoverySecretRotationStore(firstClient);
    const dryRun = await runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs([
        '--dry-run',
        '--reason', 'SUSPECTED_KEY_COMPROMISE',
        '--operator', 'Fixture Rotation Operator',
        '--case-reference', 'FIXTURE-ROTATION-1',
        '--confirm-api-and-scheduler-quiesced',
      ]),
      rotationEnv,
    );
    assert.equal(dryRun.mode, 'DRY_RUN');
    const databaseIdentitySha256 = dryRun.databaseIdentitySha256;
    assert.match(databaseIdentitySha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual({
      generation: dryRun.generation,
      capabilities: dryRun.capabilities,
      requestEvidenceRows: dryRun.requestEvidenceRows,
      legacySlots: dryRun.legacySlots,
      rateBuckets: dryRun.rateBuckets,
      securityNotices: dryRun.securityNotices,
    }, expectedCounts);
    assert.equal(dryRun.deploymentProfile, 'production');
    await assert.rejects(
      () => firstClient!.authRecoveryControl.update({
        where: { id: 1 },
        data: {
          activeSecretFingerprint: authRecoverySecretFingerprint(
            Buffer.alloc(48, 0x7f).toString('base64url'),
          ),
        },
      }),
      /Illegal authentication recovery control transition/u,
    );
    await assert.rejects(
      () => firstClient!.authRecoveryControl.delete({ where: { id: 1 } }),
      /Authentication recovery control cannot be deleted/u,
    );

    const executeArgs = (counts: AuthRecoverySecretRotationCounts) => [
      '--execute',
      '--reason', 'SUSPECTED_KEY_COMPROMISE',
      '--operator', 'Fixture Rotation Operator',
      '--case-reference', 'FIXTURE-ROTATION-1',
      '--confirm-api-and-scheduler-quiesced',
      '--confirm-outbox-preservation-understood',
      '--expected-generation', String(counts.generation),
      '--expected-capabilities', String(counts.capabilities),
      '--expected-request-evidence-rows', String(counts.requestEvidenceRows),
      '--expected-legacy-slots', String(counts.legacySlots),
      '--expected-rate-buckets', String(counts.rateBuckets),
      '--expected-security-notices', String(counts.securityNotices),
      '--expected-database-identity-sha256', databaseIdentitySha256,
      '--expected-deployment-profile', 'production',
      '--confirm-execute', authRecoverySecretRotationConfirmation(
        'SUSPECTED_KEY_COMPROMISE', counts, databaseIdentitySha256, 'production',
      ),
    ];

    const mismatchedCounts = {
      ...expectedCounts,
      capabilities: expectedCounts.capabilities + 1,
    };
    await assert.rejects(
      () => runAuthRecoverySecretRotation(
        store,
        parseAuthRecoverySecretRotationArgs(executeArgs(mismatchedCounts)),
        rotationEnv,
      ),
      /database counts changed after the reviewed dry-run/,
    );
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { deliveryState: { not: 'SUPPRESSED' }, terminatedAt: null },
    }), expectedCounts.capabilities);
    assert.equal(await firstClient.authRecoveryRateLimitBucket.count(), expectedCounts.rateBuckets);
    assert.equal((await firstClient.user.findUniqueOrThrow({
      where: { id: 'rotation-legacy-user' }, select: { resetToken: true },
    })).resetToken !== null, true);

    let releaseInFlightWriter!: () => void;
    let signalInFlightWriterLocked!: () => void;
    const inFlightWriterRelease = new Promise<void>((resolve) => {
      releaseInFlightWriter = resolve;
    });
    const inFlightWriterLocked = new Promise<void>((resolve) => {
      signalInFlightWriterLocked = resolve;
    });
    const inFlightWriter = secondClient.$transaction(async (tx) => {
      await assertAuthRecoveryControlForCurrentSecret(tx);
      await tx.$queryRaw`
        SELECT "id"
        FROM "PasswordRecoveryRequest"
        WHERE "id" = ${rotationRequestIds.PENDING}::uuid
        FOR UPDATE
      `;
      signalInFlightWriterLocked();
      await inFlightWriterRelease;
      const claimedAt = new Date();
      await tx.passwordRecoveryRequest.update({
        where: { id: rotationRequestIds.PENDING },
        data: {
          deliveryState: 'SENDING',
          claimToken: randomUUID(),
          claimedAt,
          deliveryAttemptedAt: claimedAt,
          deliveryAttemptCount: 1,
          nextDeliveryAttemptAt: null,
        },
      });
    });
    await inFlightWriterLocked;
    let rotationSettled = false;
    const executePromise = runAuthRecoverySecretRotation(
      store,
      parseAuthRecoverySecretRotationArgs(executeArgs(expectedCounts)),
      rotationEnv,
    ).finally(() => { rotationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rotationSettled, false, 'rotation must wait for the control-first writer');
    releaseInFlightWriter();
    await inFlightWriter;
    const executed = await executePromise;
    assert.equal(executed.mode, 'EXECUTED');
    assert.equal(executed.mutationApplied, true);
    assert.deepEqual({
      generation: executed.rotatedGeneration,
      capabilities: executed.invalidatedCapabilities,
      requestEvidenceRows: executed.redactedRequestEvidenceRows,
      legacySlots: executed.clearedLegacySlots,
      rateBuckets: executed.deletedRateBuckets,
      securityNotices: executed.securityNotices,
    }, expectedCounts);
    assert.equal(executed.remainingCapabilities, 0);
    assert.equal(executed.remainingRequestEvidenceRows, 0);
    assert.equal(executed.remainingLegacySlots, 0);
    assert.equal(executed.remainingRateBuckets, 0);
    assert.equal(executed.recoveryBlocked, true);
    assert.equal(executed.blockedGeneration, expectedCounts.generation + 1);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { deliveryState: { not: 'SUPPRESSED' }, terminatedAt: null },
    }), 0);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: {
        OR: [
          { identifierDigest: { not: null } },
          { requestIpDigest: { not: null } },
          { requestNetworkDigest: { not: null } },
          { rateKeyVersion: { not: null } },
        ],
      },
    }), 0);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: { source: 'SELF_SERVICE_EMAIL', requestEvidenceRedactedAt: { not: null } },
    }), expectedCounts.requestEvidenceRows);
    assert.equal(await firstClient.passwordRecoveryRequest.count({
      where: {
        id: { in: Object.values(rotationRequestIds) },
        terminationReason: 'KEY_ROTATED',
        terminatedAt: { not: null },
      },
    }), 4);
    const rotatedSending = await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: rotationRequestIds.SENDING },
      select: { deliveryState: true, claimToken: true, deliveryFinalizedAt: true },
    });
    assert.equal(rotatedSending.deliveryState, 'UNCERTAIN');
    assert.equal(rotatedSending.claimToken, null);
    assert.ok(rotatedSending.deliveryFinalizedAt);
    assert.equal((await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: rotationRequestIds.ACCEPTED }, select: { deliveryState: true },
    })).deliveryState, 'ACCEPTED');
    assert.equal((await firstClient.passwordRecoveryRequest.findUniqueOrThrow({
      where: { id: rotationRequestIds.UNCERTAIN }, select: { deliveryState: true },
    })).deliveryState, 'UNCERTAIN');
    const legacyAfterRotation = await firstClient.user.findUniqueOrThrow({
      where: { id: 'rotation-legacy-user' },
      select: { resetToken: true, resetTokenExpiry: true },
    });
    assert.equal(legacyAfterRotation.resetToken, null);
    assert.equal(legacyAfterRotation.resetTokenExpiry, null);
    assert.equal(await firstClient.authRecoveryRateLimitBucket.count(), 0);
    assert.deepEqual(await firstClient.authSecurityEmailOutbox.findMany({
      select: { id: true, deliveryState: true, providerMessageId: true },
      orderBy: { id: 'asc' },
    }), securityNoticesBefore);
    assert.equal(await firstClient.authRecoveryRetiredSecret.count(), 1);
    const firstRetiredFingerprint = authRecoverySecretFingerprint(
      Buffer.alloc(48, 0x71).toString('base64url'),
    );
    assert.ok(await firstClient.authRecoveryRetiredSecret.findUnique({
      where: { fingerprint: firstRetiredFingerprint },
    }));

    await assert.rejects(
      () => new PasswordRecoveryService(firstClient!).requestPasswordReset(
        'blocked-recovery@example.invalid',
        { ipAddress: '203.0.113.200', requestId: 'blocked-after-rotation' },
      ),
      /blocked pending controlled key activation/u,
    );
    const replacementSecret = Buffer.alloc(48, 0x82).toString('base64url');
    const blockedGeneration = expectedCounts.generation + 1;
    await assert.rejects(
      () => store.activate(blockedGeneration, databaseIdentitySha256),
      /replacement matches the retired key/u,
    );
    const activation = await runAuthRecoverySecretRotation(
      new PrismaAuthRecoverySecretRotationStore(firstClient, replacementSecret),
      parseAuthRecoverySecretRotationArgs([
        '--activate-after-replacement',
        '--reason', 'SUSPECTED_KEY_COMPROMISE',
        '--operator', 'Fixture Rotation Operator',
        '--case-reference', 'FIXTURE-ROTATION-1',
        '--confirm-api-and-scheduler-quiesced',
        '--expected-generation', String(blockedGeneration),
        '--expected-database-identity-sha256', databaseIdentitySha256,
        '--expected-deployment-profile', 'production',
        '--confirm-activate', authRecoverySecretActivationConfirmation(
          'SUSPECTED_KEY_COMPROMISE',
          blockedGeneration,
          databaseIdentitySha256,
          'production',
        ),
      ]),
      rotationEnv,
    );
    assert.equal(activation.mode, 'ACTIVATED');
    assert.equal(activation.generation, blockedGeneration);
    assert.equal(activation.recoveryBlocked, false);
    await assert.rejects(
      () => firstClient!.$transaction(
        (tx) => assertAuthRecoveryControlForCurrentSecret(
          tx,
          Buffer.alloc(48, 0x71).toString('base64url'),
        ),
      ),
      /non-active root key/u,
    );
    const evidenceRowsBeforeNewKey = await firstClient.passwordRecoveryRequest.count();
    process.env.AUTH_RECOVERY_SECRET = replacementSecret;
    await new PasswordRecoveryService(firstClient).requestPasswordReset(
      'new-key-recovery@example.invalid',
      { ipAddress: '203.0.113.201', requestId: 'new-key-after-activation' },
    );
    assert.equal(
      await firstClient.passwordRecoveryRequest.count(),
      evidenceRowsBeforeNewKey + 1,
    );

    const replacementStore = new PrismaAuthRecoverySecretRotationStore(
      firstClient,
      replacementSecret,
    );
    const secondDryRun = await runAuthRecoverySecretRotation(
      replacementStore,
      parseAuthRecoverySecretRotationArgs([
        '--dry-run',
        '--reason', 'SUSPECTED_KEY_COMPROMISE',
        '--operator', 'Fixture Rotation Operator',
        '--case-reference', 'FIXTURE-ROTATION-2',
        '--confirm-api-and-scheduler-quiesced',
      ]),
      rotationEnv,
    );
    if (secondDryRun.mode !== 'DRY_RUN') {
      throw new Error('Second rotation inspection did not return dry-run evidence');
    }
    assert.equal(secondDryRun.mode, 'DRY_RUN');
    if (secondDryRun.mode !== 'DRY_RUN') {
      throw new Error('Second recovery-secret review did not remain a dry-run');
    }
    const secondCounts: AuthRecoverySecretRotationCounts = {
      generation: secondDryRun.generation,
      capabilities: secondDryRun.capabilities,
      requestEvidenceRows: secondDryRun.requestEvidenceRows,
      legacySlots: secondDryRun.legacySlots,
      rateBuckets: secondDryRun.rateBuckets,
      securityNotices: secondDryRun.securityNotices,
    };
    assert.equal(secondDryRun.databaseIdentitySha256, databaseIdentitySha256);
    const secondExecuteArgs = executeArgs(secondCounts);
    const caseReferenceIndex = secondExecuteArgs.indexOf('--case-reference');
    secondExecuteArgs[caseReferenceIndex + 1] = 'FIXTURE-ROTATION-2';
    const secondExecuted = await runAuthRecoverySecretRotation(
      replacementStore,
      parseAuthRecoverySecretRotationArgs(secondExecuteArgs),
      rotationEnv,
    );
    if (secondExecuted.mode !== 'EXECUTED') {
      throw new Error('Second auth recovery secret rotation did not execute');
    }
    assert.equal(secondExecuted.mode, 'EXECUTED');
    if (secondExecuted.mode !== 'EXECUTED') {
      throw new Error('Second recovery-secret rotation did not execute');
    }
    const secondBlockedGeneration = secondCounts.generation + 1;
    assert.equal(secondExecuted.blockedGeneration, secondBlockedGeneration);
    assert.equal(await firstClient.authRecoveryRetiredSecret.count(), 2);
    await assert.rejects(
      () => new PrismaAuthRecoverySecretRotationStore(
        firstClient!,
        Buffer.alloc(48, 0x71).toString('base64url'),
      ).activate(secondBlockedGeneration, databaseIdentitySha256),
      /previously retired/u,
    );
    await assert.rejects(
      () => firstClient!.authRecoveryRetiredSecret.delete({
        where: { fingerprint: firstRetiredFingerprint },
      }),
      /append-only/u,
    );

    const finalReplacementSecret = Buffer.alloc(48, 0x93).toString('base64url');
    const finalActivation = await runAuthRecoverySecretRotation(
      new PrismaAuthRecoverySecretRotationStore(firstClient, finalReplacementSecret),
      parseAuthRecoverySecretRotationArgs([
        '--activate-after-replacement',
        '--reason', 'SUSPECTED_KEY_COMPROMISE',
        '--operator', 'Fixture Rotation Operator',
        '--case-reference', 'FIXTURE-ROTATION-2',
        '--confirm-api-and-scheduler-quiesced',
        '--expected-generation', String(secondBlockedGeneration),
        '--expected-database-identity-sha256', databaseIdentitySha256,
        '--expected-deployment-profile', 'production',
        '--confirm-activate', authRecoverySecretActivationConfirmation(
          'SUSPECTED_KEY_COMPROMISE',
          secondBlockedGeneration,
          databaseIdentitySha256,
          'production',
        ),
      ]),
      rotationEnv,
    );
    assert.equal(finalActivation.mode, 'ACTIVATED');
    process.env.AUTH_RECOVERY_SECRET = finalReplacementSecret;
  } finally {
    await Promise.allSettled([
      firstClient?.$disconnect() ?? Promise.resolve(),
      secondClient?.$disconnect() ?? Promise.resolve(),
    ]);
    if (previousSecret === undefined) delete process.env.AUTH_RECOVERY_SECRET;
    else process.env.AUTH_RECOVERY_SECRET = previousSecret;
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
    await removeContainer(container);
  }
}
