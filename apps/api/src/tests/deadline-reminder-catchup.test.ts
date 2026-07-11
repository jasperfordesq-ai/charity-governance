import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'deadline-catchup-test-secret';

const { DeadlineRemindersService } = await import('../services/deadline-reminders.service.js');

function deadlineDueInDays(days: number, reminderDays: number[]) {
  const dueDate = new Date();
  dueDate.setUTCHours(0, 0, 0, 0);
  dueDate.setUTCDate(dueDate.getUTCDate() + days);

  return {
    id: 'deadline_catchup',
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

function harness(deadline: ReturnType<typeof deadlineDueInDays>) {
  const reserved: Array<Record<string, unknown>> = [];
  const sent: unknown[][] = [];
  const prisma = {
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
      updateMany: async (args: { where?: { status?: unknown } }) => ({
        count:
          args.where?.status === 'SENDING' &&
          'providerRequestStartedAt' in (args.where ?? {})
            ? 0
            : 1,
      }),
    },
    user: { findFirst: async () => ({ id: 'user_1' }) },
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null }),
    },
    organisation: { findUnique: async () => ({ name: 'Governance Charity' }) },
    $queryRaw: async () => [{ id: deadline.id }],
  };
  const client = {
    ...prisma,
    $transaction: async (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
  };
  const service = new DeadlineRemindersService(client as never, {
    sendDeadlineReminder: async (...a: unknown[]) => {
      sent.push(a);
      return { outcome: 'ACCEPTED', providerMessageId: 'provider-catchup-accepted' };
    },
  } as never);
  return { service, reserved, sent };
}

// Regression guard for the missed-run catch-up fix: a window must still fire on
// the next run if the exact trigger day was skipped, and dedup must key on the
// configured window rather than the live day count.
test('reminder catches up to the most urgent window when the exact day was missed', async () => {
  // 5 days out with windows [7,14,30]: the day daysUntilDue===7 was skipped.
  // Old exact-match logic would never send; catch-up must send the 7-day window.
  const { service, reserved, sent } = harness(deadlineDueInDays(5, [7, 14, 30]));

  await service.sendDueReminders();

  assert.equal(sent.length, 1, 'a catch-up reminder must be sent');
  assert.equal(reserved.length, 1);
  assert.equal(
    reserved[0].reminderDays,
    7,
    'dedup must be keyed on the configured window (7), not the live day count',
  );
});

test('reminder selects the most urgent window that has actually been reached', async () => {
  // 10 days out with windows [7,14,30]: 14 is reached (10<=14), 7 is not (10>7).
  const { service, reserved, sent } = harness(deadlineDueInDays(10, [7, 14, 30]));

  await service.sendDueReminders();

  assert.equal(sent.length, 1);
  assert.equal(reserved[0].reminderDays, 14);
});

test('reminder does not fire before any configured window is reached', async () => {
  // 20 days out with windows [7,14]: no window reached yet.
  const { service, reserved, sent } = harness(deadlineDueInDays(20, [7, 14]));

  await service.sendDueReminders();

  assert.equal(sent.length, 0);
  assert.equal(reserved.length, 0);
});
