import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'deadline-manual-link-test-secret';

const { DeadlineRemindersService } = await import('../services/deadline-reminders.service.js');

// Fix round 4: CHARITYPILOT_EMAIL_DELIVERY=manual-link has no fallback for
// deadline reminders (unlike password-recovery/team-invite flows, which show
// a link instead of emailing) — reminder emails ARE the whole job. Proves
// the chosen "honest" behaviour against the REAL sendDueReminders code path:
// a clean skip, never touching the database or attempting a send, rather
// than running the loop and silently accumulating REJECTED delivery rows
// forever (EmailService already rejects gracefully instead of throwing when
// unconfigured, so nothing here would crash — the defect this pins is
// "quiet noise", not "crash").
async function withEmailDeliveryMode<T>(mode: 'provider' | 'manual-link', run: () => Promise<T> | T): Promise<T> {
  const original = process.env.CHARITYPILOT_EMAIL_DELIVERY;
  process.env.CHARITYPILOT_EMAIL_DELIVERY = mode;
  try {
    // await (not just return) matters: this must resolve BEFORE the env var
    // is restored in the finally block below, or an async run() body could
    // still be executing (past its first await) under the WRONG mode.
    return await run();
  } finally {
    if (original === undefined) delete process.env.CHARITYPILOT_EMAIL_DELIVERY;
    else process.env.CHARITYPILOT_EMAIL_DELIVERY = original;
  }
}

function deadlineDueInDays(days: number, reminderDays: number[]) {
  const dueDate = new Date();
  dueDate.setUTCHours(0, 0, 0, 0);
  dueDate.setUTCDate(dueDate.getUTCDate() + days);

  return {
    id: 'deadline_manual_link',
    organisationId: 'org_1',
    title: 'Annual report',
    dueDate,
    scheduleVersion: 1,
    reminderDays,
    organisation: {
      id: 'org_1',
      name: 'Governance Charity',
      subscription: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null },
      users: [{ id: 'user_1', email: 'owner@example.org', role: 'OWNER', emailVerified: true }],
    },
  };
}

// Every Prisma method a real run would touch throws if called at all — a
// stub that quietly "worked" would defeat the point of this test (session
// standard: stubs must honour their inputs, not just return canned success).
function neverCalledPrisma(dbCalls: string[]) {
  const fail = (name: string) => {
    dbCalls.push(name);
    throw new Error(`${name} must not be called under manual-link — sendDueReminders must skip before touching the database`);
  };
  const base = {
    deadline: {
      findMany: async () => fail('deadline.findMany'),
      findFirst: async () => fail('deadline.findFirst'),
    },
    deadlineReminderLog: {
      findFirst: async () => fail('deadlineReminderLog.findFirst'),
      count: async () => fail('deadlineReminderLog.count'),
      create: async () => fail('deadlineReminderLog.create'),
      updateMany: async () => fail('deadlineReminderLog.updateMany'),
    },
    user: { findFirst: async () => fail('user.findFirst') },
    subscription: { findUnique: async () => fail('subscription.findUnique') },
    organisation: { findUnique: async () => fail('organisation.findUnique') },
    $queryRaw: async () => fail('$queryRaw'),
  };
  return {
    ...base,
    $transaction: async (operation: (tx: typeof base) => Promise<unknown>) => operation(base),
  };
}

test('sendDueReminders skips cleanly under manual-link: no database touch, no send attempt, no throw', async () => {
  await withEmailDeliveryMode('manual-link', async () => {
    const dbCalls: string[] = [];
    const sent: unknown[][] = [];
    const prisma = neverCalledPrisma(dbCalls);
    const service = new DeadlineRemindersService(prisma as never, {
      sendDeadlineReminder: async (...a: unknown[]) => {
        sent.push(a);
        throw new Error('email must not be attempted under manual-link');
      },
    } as never);

    await service.sendDueReminders();

    assert.deepEqual(dbCalls, [], 'manual-link must skip before touching the database at all');
    assert.equal(sent.length, 0, 'manual-link must never attempt to send a reminder email');
  });
});

test('sendDueReminders still runs normally under provider mode (byte-identical to pre-fix behaviour)', async () => {
  await withEmailDeliveryMode('provider', async () => {
    const deadline = deadlineDueInDays(5, [7, 14, 30]);
    const reserved: Array<Record<string, unknown>> = [];
    const sent: unknown[][] = [];
    const base = {
      deadline: {
        findMany: async () => [deadline],
        findFirst: async () => ({ id: deadline.id }),
      },
      deadlineReminderLog: {
        findFirst: async () => null,
        count: async () => 0,
        create: async (args: { data: Record<string, unknown> }) => {
          reserved.push(args.data);
          return { id: 'log_1', ...args.data };
        },
        // Only the stale-SENDING reconciliation sweep (at the very start of
        // sendDueReminders) legitimately matches zero rows here — every OTHER
        // updateMany call (RESERVED -> SENDING, and the SKIPPED transitions)
        // must match exactly the one row this fixture reserves, or the real
        // code correctly treats it as "claimed elsewhere" and skips instead
        // of sending. A stub that always returns 0 (ignoring which update it
        // was asked for) would silently break that and defeat this test.
        updateMany: async (args: { where?: { status?: unknown } }) =>
          args.where?.status === 'SENDING' && 'providerRequestStartedAt' in (args.where ?? {})
            ? { count: 0 }
            : { count: 1 },
      },
      user: { findFirst: async () => ({ id: 'user_1' }) },
      subscription: {
        findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null }),
      },
      organisation: { findUnique: async () => ({ name: 'Governance Charity' }) },
      $queryRaw: async () => [{ id: deadline.id }],
    };
    const client = {
      ...base,
      $transaction: async (operation: (tx: typeof base) => Promise<unknown>) => operation(base),
    };
    const service = new DeadlineRemindersService(client as never, {
      sendDeadlineReminder: async (...a: unknown[]) => {
        sent.push(a);
        return { outcome: 'ACCEPTED', providerMessageId: 'provider-manual-link-regression-check' };
      },
    } as never);

    await service.sendDueReminders();

    assert.equal(sent.length, 1, 'provider mode must still attempt the send exactly as before');
    assert.equal(reserved.length, 1);
  });
});
