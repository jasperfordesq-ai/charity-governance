import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

process.env.AUTH_RECOVERY_SECRET = Buffer.alloc(48, 0x5c).toString('base64url');
process.env.FRONTEND_URL = 'https://app.charitypilot.ie';

const {
  PASSWORD_RECOVERY_NEUTRAL_MESSAGE,
  PASSWORD_RECOVERY_RESPONSE_MAX_MS,
  PASSWORD_RECOVERY_RESPONSE_MIN_MS,
  PasswordRecoveryService,
  mapPasswordRecoveryInfrastructureError,
} = await import('../services/password-recovery.service.js');
const {
  authRecoverySecretFingerprint,
  createPasswordRecoveryTokenMaterial,
} = await import('../services/password-recovery-crypto.js');

const NOW = new Date('2026-07-11T15:00:00.000Z');
const USER = {
  id: 'user-1',
  organisationId: 'org-1',
  email: 'owner@example.org',
  name: 'Owner One',
  lifecycleStatus: 'ACTIVE',
  organisation: { lifecycleStatus: 'ACTIVE' },
};

const CONTROL_ROW = {
  id: 1,
  blocked: false,
  generation: 1,
  activeSecretFingerprint: authRecoverySecretFingerprint(process.env.AUTH_RECOVERY_SECRET),
  retiredSecretFingerprint: null,
};

function deterministicTiming(targetDurationMs = 450, elapsedMs = 75) {
  let nowCall = 0;
  const delays: number[] = [];
  return {
    timing: {
      nowMs: () => (nowCall++ === 0 ? 1_000 : 1_000 + elapsedMs),
      targetDurationMs: () => targetDurationMs,
      delay: async (ms: number) => { delays.push(ms); },
    },
    delays,
  };
}

function requestHarness(
  candidate: typeof USER | null,
  { outstanding = 0, rateCount = 1 } = {},
) {
  let rawCall = 0;
  let countCalls = 0;
  let executeCalls = 0;
  const creates: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [CONTROL_ROW];
      if (rawCall === 2) return [];
      if (rawCall >= 3 && rawCall <= 6) return [{ count: rateCount }];
      if (rawCall === 7) {
        return candidate ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }] : [];
      }
      if (rawCall === 8) return candidate ? [candidate] : [];
      if (rawCall === 9) return [{ now: NOW }];
      throw new Error(`Unexpected request raw query ${rawCall}`);
    },
    $executeRaw: async () => {
      executeCalls += 1;
      return 1;
    },
    user: {
      findUnique: async () => candidate,
    },
    passwordRecoveryRequest: {
      count: async () => {
        countCalls += 1;
        return outstanding;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return data;
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  return {
    prisma,
    creates,
    stats: () => ({ rawCall, countCalls, executeCalls }),
  };
}

test('forgot-password known and unknown identifiers use the same lock/count operation shape', async () => {
  const known = requestHarness(USER);
  const unknown = requestHarness(null);
  const knownTiming = deterministicTiming();
  const unknownTiming = deterministicTiming();
  const woken: string[] = [];
  const knownService = new PasswordRecoveryService(known.prisma as never, {
    wakePasswordRecoveryDelivery: (requestId) => { woken.push(requestId); },
  }, knownTiming.timing);
  const unknownService = new PasswordRecoveryService(
    unknown.prisma as never,
    undefined,
    unknownTiming.timing,
  );

  const knownResult = await knownService.requestPasswordReset(' OWNER@example.org ', {
    ipAddress: '203.0.113.10',
    requestId: 'known-request',
  });
  const unknownResult = await unknownService.requestPasswordReset('ghost@example.org', {
    ipAddress: '203.0.113.10',
    requestId: 'unknown-request',
  });

  assert.deepEqual(known.stats(), unknown.stats());
  assert.deepEqual(known.stats(), { rawCall: 9, countCalls: 1, executeCalls: 0 });
  assert.deepEqual(knownResult, unknownResult);
  assert.deepEqual(knownResult, { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE });
  assert.equal(known.creates[0].deliveryState, 'PENDING');
  assert.equal(known.creates[0].recipientEmail, 'owner@example.org');
  assert.match(String(known.creates[0].tokenHash), /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(known.creates[0], 'resetToken'), false);
  assert.equal(known.creates[0].deliveryTemplateVersion, 1);
  assert.equal(unknown.creates[0].deliveryState, 'SUPPRESSED');
  assert.equal(unknown.creates[0].suppressionReason, 'NO_ELIGIBLE_ACCOUNT');
  assert.equal(unknown.creates[0].userId, undefined);
  assert.equal(woken.length, 1);
  assert.deepEqual(knownTiming.delays, [375]);
  assert.deepEqual(unknownTiming.delays, [375]);
});

test('current forgot-password requests persist only the P107A ledger and never touch retired User slots', async () => {
  const harness = requestHarness(USER);
  const timing = deterministicTiming();
  const service = new PasswordRecoveryService(harness.prisma as never, undefined, timing.timing);

  await service.requestPasswordReset('owner@example.org', {
    ipAddress: '203.0.113.18',
    requestId: 'p107a-ledger-only',
  });

  assert.equal(harness.creates.length, 1);
  assert.equal(harness.creates[0].source, 'SELF_SERVICE_EMAIL');
  assert.equal(harness.creates[0].deliveryState, 'PENDING');
  assert.equal(Object.hasOwn(harness.creates[0], 'resetToken'), false);
  assert.deepEqual(timing.delays, [375]);
});

test('legacy overlong account emails are suppressed with the same neutral recovery result', async () => {
  const suffix = '@example.org';
  const email = `${'a'.repeat(255 - suffix.length)}${suffix}`;
  const known = requestHarness({ ...USER, email });
  const unknown = requestHarness(null);
  const knownTiming = deterministicTiming();
  const unknownTiming = deterministicTiming();

  const knownResult = await new PasswordRecoveryService(
    known.prisma as never,
    undefined,
    knownTiming.timing,
  ).requestPasswordReset(email, { ipAddress: '203.0.113.19' });
  const unknownResult = await new PasswordRecoveryService(
    unknown.prisma as never,
    undefined,
    unknownTiming.timing,
  ).requestPasswordReset(email, { ipAddress: '203.0.113.19' });

  assert.equal(email.length, 255);
  assert.deepEqual(knownResult, unknownResult);
  assert.deepEqual(knownResult, { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE });
  assert.deepEqual(known.stats(), unknown.stats());
  assert.equal(known.creates[0].deliveryState, 'SUPPRESSED');
  assert.equal(known.creates[0].suppressionReason, 'NO_ELIGIBLE_ACCOUNT');
  assert.equal(known.creates[0].recipientEmail, undefined);
  assert.deepEqual(knownTiming.delays, unknownTiming.delays);
});

test('successful forgot-password variants share one bounded response-time envelope', async (context) => {
  const variants = [
    ['known', USER, {}],
    ['unknown', null, {}],
    ['inactive', { ...USER, lifecycleStatus: 'SUSPENDED' }, {}],
    ['outstanding-capped', USER, { outstanding: 3 }],
    ['rate-suppressed', USER, { rateCount: 1_000 }],
  ] as const;

  for (const [label, candidate, options] of variants) {
    await context.test(label, async () => {
      const harness = requestHarness(candidate as typeof USER | null, options);
      const timing = deterministicTiming(450, 90);
      const service = new PasswordRecoveryService(
        harness.prisma as never,
        undefined,
        timing.timing,
      );
      const result = await service.requestPasswordReset(`${label}@example.org`, {
        ipAddress: '198.51.100.20',
      });
      assert.deepEqual(result, { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE });
      assert.deepEqual(timing.delays, [360]);
      assert.deepEqual(harness.stats(), { rawCall: 9, countCalls: 1, executeCalls: 0 });
    });
  }

  assert.equal(PASSWORD_RECOVERY_RESPONSE_MIN_MS, 350);
  assert.equal(PASSWORD_RECOVERY_RESPONSE_MAX_MS, 550);
});

test('forgot-password equalization clamps injected targets to the reviewed bounds', async () => {
  for (const [target, expectedDelay] of [[1, 300], [10_000, 500]] as const) {
    const harness = requestHarness(null);
    const timing = deterministicTiming(target, 50);
    const service = new PasswordRecoveryService(harness.prisma as never, undefined, timing.timing);
    await service.requestPasswordReset('ghost@example.org', { ipAddress: '203.0.113.20' });
    assert.deepEqual(timing.delays, [expectedDelay]);
  }
});

function resetHarness(token: string, mode: 'request' | 'backfilled' | 'personal' = 'request') {
  const requestId = 'd8d9f463-67ce-49ef-a10f-8c9812ee7ac5';
  const tokenHash = createPasswordRecoveryTokenMaterial(requestId).tokenHash;
  const actualTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let transactionNumber = 0;
  let locatorCalled = false;
  const mutations: Record<string, unknown> = {};
  const presentedRow = {
      id: requestId,
      source: mode === 'personal'
        ? 'PERSONAL_SERVER_OPERATOR'
        : mode === 'backfilled'
          ? 'LEGACY_USER_SLOT'
          : 'SELF_SERVICE_EMAIL',
      tokenHash: actualTokenHash,
      deliveryState: 'ACCEPTED',
      expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      terminatedAt: null,
    };
  const otherRow = {
      id: '0a6c81da-5d46-46d0-b7e2-5eec4cb29b38',
      source: 'LEGACY_USER_SLOT',
      tokenHash,
      deliveryState: 'UNCERTAIN',
      expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      terminatedAt: null,
    };
  const recoveryRows = [presentedRow, otherRow];
  const prisma: Record<string, unknown> = {
    passwordRecoveryRequest: {
      findUnique: async () => {
        locatorCalled = true;
        return { id: requestId, userId: 'user-1', organisationId: 'org-1' };
      },
    },
    $transaction: async (callback: (client: Record<string, unknown>) => Promise<unknown>) => {
      transactionNumber += 1;
      if (transactionNumber === 1) {
        let rawCall = 0;
        return callback({
          $queryRaw: async () => {
            rawCall += 1;
            return rawCall === 1 ? [CONTROL_ROW] : [{ count: 1 }];
          },
          $executeRaw: async () => 1,
        });
      }
      let rawCall = 0;
      const tx = {
        $queryRaw: async () => {
          rawCall += 1;
          if (rawCall === 1) return [CONTROL_ROW];
          if (rawCall === 2) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
          if (rawCall === 3) return [USER];
          if (rawCall === 4) return recoveryRows;
          if (rawCall === 5) return [{ id: 'session-1' }, { id: 'session-2' }];
          if (rawCall === 6) return [{ now: NOW }];
          throw new Error(`Unexpected reset raw query ${rawCall}`);
        },
        $executeRaw: async () => 1,
        user: {
          updateMany: async (args: unknown) => {
            mutations.user = args;
            return { count: 1 };
          },
        },
        passwordRecoveryRequest: {
          updateMany: async (args: unknown) => {
            mutations.recovery = args;
            return { count: recoveryRows.length };
          },
        },
        authSession: {
          updateMany: async (args: unknown) => {
            mutations.sessions = args;
            return { count: 2 };
          },
        },
        securityAuditEvent: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            mutations.audit = data;
            return { id: 'audit-1' };
          },
        },
        authSecurityEmailOutbox: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            mutations.outbox = data;
            return { id: 'outbox-1' };
          },
        },
      };
      return callback(tx);
    },
  };
  return {
    prisma,
    mutations,
    locatorCalled: () => locatorCalled,
  };
}

test('reset-password atomically terminates all requests, revokes sessions, audits, and enqueues notice', async () => {
  const token = 'A'.repeat(43);
  const harness = resetHarness(token);
  const service = new PasswordRecoveryService(harness.prisma as never);

  const result = await service.resetPassword(token, 'NewPassword1', {
    ipAddress: '2001:db8::9',
    requestId: 'http-reset-1',
  });

  assert.match(result.message, /reset successfully/i);
  assert.equal(harness.locatorCalled(), true);
  const recovery = harness.mutations.recovery as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(recovery.where, {
    userId: 'user-1', organisationId: 'org-1', terminatedAt: null,
  });
  assert.equal(recovery.data.terminationReason, 'PASSWORD_RESET_COMPLETED');
  const sessions = harness.mutations.sessions as { data: Record<string, unknown> };
  assert.equal(sessions.data.revocationReason, 'PASSWORD_RESET');
  const audit = harness.mutations.audit as Record<string, unknown>;
  assert.equal(audit.type, 'ALL_SESSIONS_REVOKED');
  assert.equal(audit.actorKind, 'SYSTEM');
  assert.equal((audit.context as Record<string, unknown>).eventKind, 'PASSWORD_RESET_COMPLETED');
  assert.equal(JSON.stringify(audit).includes(token), false);
  const outbox = harness.mutations.outbox as Record<string, unknown>;
  assert.equal(outbox.kind, 'PASSWORD_RESET_COMPLETED_NOTICE');
  assert.equal(outbox.deliveryState, 'PENDING');
  assert.equal(outbox.deliveryTemplateVersion, 1);
});

test('reset-password consumes a valid pre-cutover p109 link only through its backfilled ledger row', async () => {
  const token = 'L'.repeat(43);
  const harness = resetHarness(token, 'backfilled');
  const service = new PasswordRecoveryService(harness.prisma as never);

  await service.resetPassword(token, 'NewPassword1', {
    ipAddress: '198.51.100.17',
    requestId: 'legacy-roll-forward-reset',
  });

  assert.equal(harness.locatorCalled(), true);
  const userMutation = harness.mutations.user as { data: Record<string, unknown> };
  assert.equal(typeof userMutation.data.passwordHash, 'string');
  assert.equal(Object.hasOwn(userMutation.data, 'resetToken'), false);
  assert.equal(Object.hasOwn(userMutation.data, 'resetTokenExpiry'), false);
  const audit = harness.mutations.audit as { context: Record<string, unknown> };
  assert.equal(audit.context.eventKind, 'PASSWORD_RESET_COMPLETED');
  assert.equal(audit.context.terminatedRequestCount, 2);
});

test('personal-server reset records operator audit evidence without an undeliverable outbox row', async () => {
  const previousMode = process.env.CHARITYPILOT_DEPLOYMENT_MODE;
  process.env.CHARITYPILOT_DEPLOYMENT_MODE = 'personal-server';
  try {
    const harness = resetHarness('P'.repeat(43), 'personal');
    const service = new PasswordRecoveryService(harness.prisma as never);
    await service.resetPassword('P'.repeat(43), 'NewPassword1', {
      ipAddress: '127.0.0.1',
      requestId: 'personal-reset',
    });

    const audit = harness.mutations.audit as {
      actorKind: string;
      context: Record<string, unknown>;
    };
    assert.equal(audit.actorKind, 'SUPPORT');
    assert.equal(audit.context.eventKind, 'PASSWORD_RESET_COMPLETED');
    assert.equal(audit.context.method, 'PERSONAL_SERVER_OPERATOR');
    assert.equal(harness.mutations.outbox, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.CHARITYPILOT_DEPLOYMENT_MODE;
    else process.env.CHARITYPILOT_DEPLOYMENT_MODE = previousMode;
  }
});

test('reset-password rejects a p109-shaped User slot when no P107A ledger row exists', async () => {
  let legacyUserLookupCalled = false;
  let rawCall = 0;
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => {
        rawCall += 1;
        return rawCall === 1 ? [CONTROL_ROW] : [{ count: 1 }];
      },
      $executeRaw: async () => 1,
    }),
    passwordRecoveryRequest: { findUnique: async () => null },
    user: {
      findUnique: async () => {
        legacyUserLookupCalled = true;
        return { id: 'user-1', organisationId: 'org-1' };
      },
    },
  };
  const service = new PasswordRecoveryService(prisma as never);
  await assert.rejects(
    () => service.resetPassword('U'.repeat(43), 'NewPassword1', {
      ipAddress: '203.0.113.21',
    }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_RESET_TOKEN',
  );
  assert.equal(legacyUserLookupCalled, false);
});

test('whitespace, control, and oversized reset tokens fail generically after durable rate accounting', async () => {
  for (const token of [' bad token ', `bad\u0000token`, 'x'.repeat(513)]) {
    let transactionCalls = 0;
    let locatorCalled = false;
    let rawCall = 0;
    const prisma = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        return callback({
          $queryRaw: async () => {
            rawCall += 1;
            return rawCall === 1 ? [CONTROL_ROW] : [{ count: 1 }];
          },
          $executeRaw: async () => 1,
        });
      },
      passwordRecoveryRequest: {
        findUnique: async () => {
          locatorCalled = true;
          return null;
        },
      },
    };
    const service = new PasswordRecoveryService(prisma as never);
    await assert.rejects(
      () => service.resetPassword(token, 'NewPassword1', { ipAddress: '203.0.113.10' }),
      (error: unknown) => (
        (error as { statusCode?: number; code?: string; message?: string }).statusCode === 400
        && (error as { code?: string }).code === 'INVALID_RESET_TOKEN'
        && !(error as { message?: string }).message?.includes(token)
      ),
    );
    assert.equal(transactionCalls, 1);
    assert.equal(locatorCalled, false);
  }
});

test('only recognized Prisma infrastructure failures map to neutral recovery 503', () => {
  const mapped = mapPasswordRecoveryInfrastructureError({ code: 'P2024' }) as {
    statusCode: number;
    code: string;
  };
  assert.equal(mapped.statusCode, 503);
  assert.equal(mapped.code, 'PASSWORD_RECOVERY_UNAVAILABLE');
  const programmerError = new Error('bad SQL shape');
  assert.equal(mapPasswordRecoveryInfrastructureError(programmerError), programmerError);
});
