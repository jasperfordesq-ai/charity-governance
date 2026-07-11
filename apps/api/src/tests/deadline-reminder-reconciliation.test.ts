import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executeReminderReconciliation,
  parseReminderReconciliationArgs,
} from '../jobs/reconcile-deadline-reminder.js';

test('reconciliation parser requires explicit scheduler quiescence and bounded evidence', () => {
  assert.throws(
    () => parseReminderReconciliationArgs([
      '--id', 'reminder-1', '--outcome', 'accepted-confirmed', '--operator', 'ops', '--reference', 'INC-1',
    ]),
    /confirm-schedulers-quiesced/,
  );
  assert.throws(
    () => parseReminderReconciliationArgs([
      '--id', 'reminder-1', '--outcome', 'accepted-confirmed', '--operator', 'ops',
      '--reference', 'x'.repeat(201), '--confirm-schedulers-quiesced',
    ]),
    /at most 200/,
  );
  assert.throws(
    () => parseReminderReconciliationArgs(['--list', '--outcome', 'accepted-confirmed']),
    /does not accept reconciliation options/,
  );
  assert.deepEqual(parseReminderReconciliationArgs([
    '--prepare-quiesced-cutover', '--confirm-schedulers-quiesced',
  ]), {
    mode: 'prepare-cutover',
    schedulersQuiesced: true,
  });

  assert.deepEqual(parseReminderReconciliationArgs([
    '--id', 'reminder-1', '--outcome', 'not-accepted-confirmed', '--operator', 'release-operator',
    '--reference', 'INC-42', '--confirm-schedulers-quiesced',
  ]), {
    mode: 'reconcile',
    id: 'reminder-1',
    outcome: 'NOT_ACCEPTED_CONFIRMED',
    operator: 'release-operator',
    reference: 'INC-42',
    schedulersQuiesced: true,
  });
});

test('reconciliation uses an unresolved-UNCERTAIN compare-and-set and records operator evidence', async () => {
  let updateArgs: Record<string, unknown> | undefined;
  const now = new Date('2026-07-10T12:00:00.000Z');
  const client = {
    deadlineReminderLog: {
      updateMany: async (args: Record<string, unknown>) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  };
  const result = await executeReminderReconciliation(client as never, {
    mode: 'reconcile',
    id: 'reminder-1',
    outcome: 'ACCEPTED_CONFIRMED',
    operator: 'release-operator',
    reference: 'INC-42',
    schedulersQuiesced: true,
  }, now);

  assert.deepEqual(updateArgs?.where, {
    id: 'reminder-1',
    status: 'UNCERTAIN',
    reconciliationOutcome: null,
  });
  assert.deepEqual(updateArgs?.data, {
    reconciliationOutcome: 'ACCEPTED_CONFIRMED',
    reconciledAt: now,
    reconciledBy: 'release-operator',
    reconciliationReference: 'INC-42',
  });
  assert.deepEqual(result, {
    id: 'reminder-1',
    outcome: 'ACCEPTED_CONFIRMED',
    reconciledAt: '2026-07-10T12:00:00.000Z',
  });
});

test('assert-clear fails closed while any unreconciled ambiguous delivery remains', async () => {
  const blocked = {
    deadlineReminderLog: { count: async () => 2 },
  };
  await assert.rejects(
    () => executeReminderReconciliation(blocked as never, { mode: 'assert-clear' }),
    /2 unresolved deadline reminder outcome/,
  );

  const clear = {
    deadlineReminderLog: { count: async () => 0 },
  };
  assert.deepEqual(
    await executeReminderReconciliation(clear as never, { mode: 'assert-clear' }),
    { unresolved: 0 },
  );
});

test('restricted blocker listing includes status, correlation, provenance, and timing discriminators', async () => {
  let query: Record<string, unknown> | undefined;
  const rows = [{ id: 'reminder-1', status: 'UNCERTAIN' }];
  const client = {
    deadlineReminderLog: {
      findMany: async (args: Record<string, unknown>) => {
        query = args;
        return rows;
      },
    },
  };
  assert.deepEqual(
    await executeReminderReconciliation(client as never, { mode: 'list' }),
    rows,
  );
  assert.deepEqual((query?.select as Record<string, unknown>).status, true);
  assert.deepEqual((query?.select as Record<string, unknown>).email, true);
  assert.deepEqual((query?.select as Record<string, unknown>).deadlineTitle, true);
  assert.deepEqual((query?.select as Record<string, unknown>).deadlineDueDate, true);
  assert.deepEqual((query?.select as Record<string, unknown>).deliveryTimingKnown, true);
  assert.deepEqual((query?.select as Record<string, unknown>).providerIdempotencyKey, true);
});

test('quiesced cutover preparation releases pre-I/O reservations and quarantines in-flight sends', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const transactionClient = {
    deadlineReminderLog: {
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: updates.length };
      },
    },
  };
  const client = {
    deadlineReminderLog: { count: async () => 0 },
    $transaction: async (operation: (tx: typeof transactionClient) => Promise<unknown>) => (
      operation(transactionClient)
    ),
  };

  assert.deepEqual(
    await executeReminderReconciliation(client as never, {
      mode: 'prepare-cutover',
      schedulersQuiesced: true,
    }),
    { releasedReservations: 1, quarantinedProviderRequests: 2, unresolved: 0 },
  );
  assert.deepEqual(updates[0].where, { status: 'RESERVED' });
  assert.deepEqual(updates[0].data, {
    status: 'SKIPPED',
    error: 'Cutover released a quiesced reservation before provider I/O',
    attemptedAt: null,
    providerRequestStartedAt: null,
    sentAt: null,
  });
  assert.deepEqual(updates[1].where, { status: 'SENDING', reconciliationOutcome: null });
  assert.equal((updates[1].data as Record<string, unknown>).status, 'UNCERTAIN');
});
