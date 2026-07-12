import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { derivePasswordRecoveryToken } from '../services/password-recovery-crypto.js';

function docker(args: string[], timeout = 30_000) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
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
  assert.fail('Disposable login/reset-race PostgreSQL fixture did not become ready');
}

async function removeContainer(container: string): Promise<void> {
  docker(['rm', '--force', container], 20_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const residue = docker(['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}']);
    assertCommand(residue, 'Login/reset-race PostgreSQL residue check');
    if (!residue.stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Disposable PostgreSQL container ${container} was not removed`);
}

async function waitForTriggerSleep(
  observer: PrismaClient,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const rows = await observer.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event = 'PgSleep'
    `;
    if ((rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${description} transaction barrier`);
}

export async function runLoginPasswordResetRaceProof(postgresImage: string): Promise<void> {
  const container = `charitypilot-login-reset-race-${randomUUID()}`;
  const databasePassword = 'login-reset-race-fixture-only';
  const previousRecoverySecret = process.env.AUTH_RECOVERY_SECRET;
  const previousFrontend = process.env.FRONTEND_URL;
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.AUTH_RECOVERY_SECRET = Buffer.alloc(48, 0x73).toString('base64url');
  process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
  process.env.JWT_SECRET = 'login-reset-race-proof-jwt-secret-with-enough-entropy';

  const started = docker([
    'run', '--detach', '--rm', '--name', container,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${databasePassword}`,
    postgresImage,
  ], 120_000);
  assertCommand(started, 'Disposable login/reset-race PostgreSQL startup');

  let loginClient: PrismaClient | undefined;
  let resetClient: PrismaClient | undefined;
  try {
    await waitForPostgres(container);
    const publishedPort = docker(['port', container, '5432/tcp']);
    assertCommand(publishedPort, 'Disposable login/reset-race PostgreSQL port lookup');
    const port = publishedPort.stdout.trim().match(/127\.0\.0\.1:(\d+)/u)?.[1];
    assert.ok(port, `Unexpected loopback port output: ${publishedPort.stdout.trim()}`);
    const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${port}/postgres?schema=public`;

    const require = (await import('node:module')).createRequire(import.meta.url);
    const prismaCli = require.resolve('prisma/build/index.js');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      migrated.status,
      0,
      `Login/reset-race migrate deploy failed: ${(migrated.stderr || migrated.stdout || migrated.error?.message || '').slice(0, 3000)}`,
    );

    loginClient = new PrismaClient({ datasourceUrl: databaseUrl });
    resetClient = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([loginClient.$connect(), resetClient.$connect()]);

    const originalPassword = 'OriginalPassword1';
    const replacementPassword = 'ReplacementPassword1';
    const originalPasswordHash = await bcrypt.hash(originalPassword, 12);
    await loginClient.$transaction(async (tx) => {
      await tx.organisation.create({
        data: {
          id: 'login-reset-race-org',
          name: 'Login Reset Race Charity',
          charitablePurpose: [],
        },
      });
      await tx.user.createMany({
        data: [
          {
            id: 'reset-first-owner', organisationId: 'login-reset-race-org',
            email: 'reset-first@example.invalid', name: 'Reset First',
            passwordHash: originalPasswordHash, role: 'OWNER', emailVerified: true,
          },
          {
            id: 'issuance-first-member', organisationId: 'login-reset-race-org',
            email: 'issuance-first@example.invalid', name: 'Issuance First',
            passwordHash: originalPasswordHash, role: 'MEMBER', emailVerified: true,
          },
        ],
      });
    });

    const [{ AuthService }, { PasswordRecoveryService }] = await Promise.all([
      import('../services/auth.service.js'),
      import('../services/password-recovery.service.js'),
    ]);

    const prepareAcceptedReset = async (
      client: PrismaClient,
      email: string,
      userId: string,
      requestLabel: string,
      ipAddress: string,
    ): Promise<string> => {
      await new PasswordRecoveryService(client).requestPasswordReset(email, {
        ipAddress,
        requestId: `${requestLabel}-forgot`,
      });
      const request = await client.passwordRecoveryRequest.findFirstOrThrow({
        where: { userId, deliveryState: 'PENDING', terminatedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(request.tokenNonce && request.tokenKeyVersion);
      const rawToken = derivePasswordRecoveryToken({
        requestId: request.id,
        tokenNonceHex: request.tokenNonce,
        tokenKeyVersion: request.tokenKeyVersion,
      });
      const claimedAt = new Date();
      await client.passwordRecoveryRequest.update({
        where: { id: request.id },
        data: {
          deliveryState: 'SENDING',
          claimToken: randomUUID(),
          claimedAt,
          deliveryAttemptedAt: claimedAt,
          deliveryAttemptCount: 1,
          nextDeliveryAttemptAt: null,
        },
      });
      await client.passwordRecoveryRequest.update({
        where: { id: request.id },
        data: {
          deliveryState: 'ACCEPTED',
          claimToken: null,
          deliveryFinalizedAt: new Date(),
          providerMessageId: `${requestLabel}-provider-message`,
        },
      });
      return rawToken;
    };

    const resetFirstToken = await prepareAcceptedReset(
      resetClient,
      'reset-first@example.invalid',
      'reset-first-owner',
      'reset-first',
      '192.0.2.10',
    );
    await resetClient.$executeRawUnsafe(`
      CREATE FUNCTION charitypilot_test_pause_reset_first() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."id" = 'reset-first-owner'
           AND NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" THEN
          PERFORM pg_sleep(4);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await resetClient.$executeRawUnsafe(`
      CREATE TRIGGER charitypilot_test_pause_reset_first
      AFTER UPDATE OF "passwordHash" ON "User"
      FOR EACH ROW EXECUTE FUNCTION charitypilot_test_pause_reset_first()
    `);

    // Force the reset-first serial order. While the committed old hash remains
    // visible to a plain login lookup, the reset holds the organisation/user
    // write locks after changing the credential. Locked issuance must wake,
    // observe the replacement hash, and reject without creating a session.
    const resetFirst = new PasswordRecoveryService(resetClient).resetPassword(
      resetFirstToken,
      replacementPassword,
      { ipAddress: '192.0.2.11', requestId: 'reset-first-consume' },
    );
    await waitForTriggerSleep(loginClient, 'reset-first');
    const staleLogin = new AuthService(loginClient).login({
      email: 'reset-first@example.invalid',
      password: originalPassword,
    });
    const [resetFirstOutcome, staleLoginOutcome] = await Promise.allSettled([
      resetFirst,
      staleLogin,
    ]);
    assert.equal(resetFirstOutcome.status, 'fulfilled');
    assert.equal(staleLoginOutcome.status, 'rejected');
    if (staleLoginOutcome.status === 'rejected') {
      assert.equal(staleLoginOutcome.reason instanceof AppError, true);
      assert.equal((staleLoginOutcome.reason as AppError).statusCode, 401);
      assert.equal((staleLoginOutcome.reason as AppError).code, 'INVALID_CREDENTIALS');
      assert.equal((staleLoginOutcome.reason as AppError).message, 'Invalid email or password');
    }
    assert.equal(await loginClient.authSession.count({
      where: { userId: 'reset-first-owner' },
    }), 0);

    const issuanceFirstToken = await prepareAcceptedReset(
      resetClient,
      'issuance-first@example.invalid',
      'issuance-first-member',
      'issuance-first',
      '198.51.100.10',
    );
    await loginClient.$executeRawUnsafe(`
      CREATE FUNCTION charitypilot_test_pause_issuance_first() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."userId" = 'issuance-first-member' THEN
          PERFORM pg_sleep(4);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await loginClient.$executeRawUnsafe(`
      CREATE TRIGGER charitypilot_test_pause_issuance_first
      AFTER INSERT ON "AuthSession"
      FOR EACH ROW EXECUTE FUNCTION charitypilot_test_pause_issuance_first()
    `);

    // Force the issuance-first serial order. The login transaction holds the
    // principal share locks through session insertion; reset waits, then sees
    // and revokes that committed session before completing.
    const issuanceFirstLogin = new AuthService(loginClient).login({
      email: 'issuance-first@example.invalid',
      password: originalPassword,
    });
    await waitForTriggerSleep(resetClient, 'issuance-first');
    const issuanceFirstReset = new PasswordRecoveryService(resetClient).resetPassword(
      issuanceFirstToken,
      replacementPassword,
      { ipAddress: '198.51.100.11', requestId: 'issuance-first-consume' },
    );
    const [issuanceOutcome, resetAfterIssuanceOutcome] = await Promise.allSettled([
      issuanceFirstLogin,
      issuanceFirstReset,
    ]);
    assert.equal(issuanceOutcome.status, 'fulfilled');
    assert.equal(resetAfterIssuanceOutcome.status, 'fulfilled');
    assert.equal(await loginClient.authSession.count({
      where: { userId: 'issuance-first-member', revokedAt: null },
    }), 0);
    const issuedSessions = await loginClient.authSession.findMany({
      where: { userId: 'issuance-first-member' },
      select: { revokedAt: true, revocationReason: true },
    });
    assert.equal(issuedSessions.length, 1);
    assert.ok(issuedSessions[0]?.revokedAt);
    assert.equal(issuedSessions[0]?.revocationReason, 'PASSWORD_RESET');
  } finally {
    await Promise.allSettled([
      loginClient?.$disconnect() ?? Promise.resolve(),
      resetClient?.$disconnect() ?? Promise.resolve(),
    ]);
    if (previousRecoverySecret === undefined) delete process.env.AUTH_RECOVERY_SECRET;
    else process.env.AUTH_RECOVERY_SECRET = previousRecoverySecret;
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    await removeContainer(container);
  }
}
