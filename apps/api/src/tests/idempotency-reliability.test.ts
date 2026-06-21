import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unit';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_unit';
process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID ?? 'price_essentials_monthly';
process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID ?? 'price_essentials_yearly';
process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID ?? 'price_complete_monthly';
process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID ?? 'price_complete_yearly';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'idempotency-reliability-test-secret';
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://app.example.org';

const [
  { BillingService },
  { DeadlineRemindersService },
  { DocumentService },
  { runDeadlineReminders },
] = await Promise.all([
  import('../services/billing.service.js'),
  import('../services/deadline-reminders.service.js'),
  import('../services/document.service.js'),
  import('../jobs/production-scheduler.js'),
]);

// ---------------------------------------------------------------------------
// Billing webhook ledger harness (mirrors billing-reminders-hardening.test.ts)
// ---------------------------------------------------------------------------

type BillingHarnessOptions = {
  ledgerCreate?: (args: unknown) => Promise<unknown>;
  upsert?: (args: unknown) => Promise<unknown>;
};

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_org_1',
    status: 'active',
    current_period_start: 1_781_078_400,
    current_period_end: 1_783_670_400,
    canceled_at: null,
    trial_end: null,
    items: { data: [{ price: { id: 'price_complete_monthly' } }] },
    ...overrides,
  };
}

function billingHarness(options: BillingHarnessOptions = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];

  const prisma: Record<string, unknown> = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      calls.push({ name: 'transaction.start', args: null });
      try {
        return await callback(prisma);
      } finally {
        calls.push({ name: 'transaction.end', args: null });
      }
    },
    stripeWebhookEvent: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'stripeWebhookEvent.findUnique', args });
        return null;
      },
      create: async (args: unknown) => {
        calls.push({ name: 'stripeWebhookEvent.create', args });
        if (options.ledgerCreate) return options.ledgerCreate(args);
        return args;
      },
    },
    organisation: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'organisation.findUnique', args });
        return { id: 'org_1', stripeCustomerId: 'cus_org_1' };
      },
    },
    subscription: {
      upsert: async (args: unknown) => {
        calls.push({ name: 'subscription.upsert', args });
        if (options.upsert) return options.upsert(args);
        return args;
      },
    },
  };

  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push({ name: 'stripe.subscriptions.retrieve', args: { id } });
        return stripeSubscription();
      },
    },
  };

  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => stripe;

  return { service, calls };
}

function checkoutEvent() {
  return {
    id: 'evt_checkout_race',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_race',
        customer: 'cus_org_1',
        subscription: 'sub_stripe_1',
        metadata: { organisationId: 'org_1', plan: 'COMPLETE' },
      },
    },
  } as never;
}

// billing-idempotency-3
// A FAITHFUL transactional harness: a durable `committed` ledger plus a $transaction
// that buffers writes and only commits them if the callback resolves — discarding them
// (true rollback) if it throws. This proves the ledger row is not durably written when
// the subscription mutation fails, so the event remains retryable.
test('a failed subscription write rolls back the webhook ledger row so the event can be retried', async () => {
  const committed = new Map<string, { id: string; type: string }>(); // the durable StripeWebhookEvent table
  let upsertAttempts = 0;
  let failUpsert = true; // first delivery's subscription write fails; the retry succeeds

  function makeTx(pending: Map<string, { id: string; type: string }>) {
    return {
      stripeWebhookEvent: {
        create: async ({ data }: { data: { id: string; type: string } }) => {
          if (committed.has(data.id) || pending.has(data.id)) {
            throw Object.assign(new Error('duplicate webhook event'), { code: 'P2002' });
          }
          pending.set(data.id, data);
          return data;
        },
      },
      organisation: {
        findUnique: async () => ({ id: 'org_1', stripeCustomerId: 'cus_org_1' }),
      },
      subscription: {
        upsert: async (args: unknown) => {
          upsertAttempts += 1;
          if (failUpsert) {
            failUpsert = false;
            throw Object.assign(new Error('subscription write failed'), { code: 'P2010' });
          }
          return args;
        },
      },
    };
  }

  const prisma = {
    stripeWebhookEvent: {
      // The pre-transaction dedup check reads only durably-committed rows.
      findUnique: async ({ where }: { where: { id: string } }) => committed.get(where.id) ?? null,
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const pending = new Map<string, { id: string; type: string }>();
      const result = await callback(makeTx(pending)); // throws -> pending discarded (rollback)
      for (const [id, row] of pending) committed.set(id, row); // commit only on success
      return result;
    },
  };

  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => ({
    subscriptions: { retrieve: async () => stripeSubscription() },
  });

  // First delivery: the subscription write throws inside the transaction.
  await assert.rejects(() => service.handleWebhook(checkoutEvent()), /subscription write failed/);
  assert.equal(upsertAttempts, 1, 'the subscription write was attempted');

  // ROLLBACK: because the ledger create ran in the SAME transaction, the failed write
  // discarded it — the durable ledger does not contain the event, so a retry is not suppressed.
  assert.equal(committed.has('evt_checkout_race'), false, 'the ledger row was rolled back, not committed');

  // RETRY: re-delivering the same event now reprocesses it (dedup check still misses) and,
  // with the subscription write succeeding, commits the ledger row exactly once.
  await service.handleWebhook(checkoutEvent());
  assert.equal(upsertAttempts, 2, 'the retry re-attempted the subscription write');
  assert.equal(committed.has('evt_checkout_race'), true, 'the successful retry durably records the event');

  // And the now-recorded event is idempotent: a third delivery short-circuits at the dedup
  // check and never re-attempts the subscription write.
  await service.handleWebhook(checkoutEvent());
  assert.equal(upsertAttempts, 2, 'an already-processed event is not re-applied');
});

// x-idempotency-idempotency-2
test('concurrent delivery of the same Stripe event aborts the second transaction when the ledger insert collides', async () => {
  const { service, calls } = billingHarness({
    ledgerCreate: async () => {
      throw Object.assign(new Error('dup'), { code: 'P2002' });
    },
  });

  // The pre-transaction findUnique misses (row not yet visible to this delivery),
  // so both deliveries enter the transaction; this one's ledger insert collides.
  await service.handleWebhook(checkoutEvent());

  // handleWebhook resolves (the P2002 on the ledger create is swallowed) and the
  // subscription is never upserted, so the event is processed at most once.
  assert.equal(calls.some((call) => call.name === 'stripeWebhookEvent.create'), true);
  assert.equal(calls.some((call) => call.name === 'subscription.upsert'), false);
});

// ---------------------------------------------------------------------------
// Deadline reminder reclaim-race harness
// ---------------------------------------------------------------------------

function reminderDeadline() {
  const dueDate = new Date();
  dueDate.setUTCHours(0, 0, 0, 0);
  dueDate.setUTCDate(dueDate.getUTCDate() + 7);

  return {
    id: 'deadline_1',
    organisationId: 'org_1',
    title: 'Annual report',
    dueDate,
    reminderDays: [7],
    organisation: {
      id: 'org_1',
      name: 'Governance Charity',
      subscription: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null },
      users: [{ id: 'user_1', email: 'owner@example.org', emailVerified: true }],
    },
  };
}

// x-idempotency-idempotency-5
test('deadline reminders skip when a concurrent worker wins the reclaim race', async () => {
  const operations: string[] = [];
  // A stale (>15min) SKIPPED 'Reserved before delivery' reservation is, in
  // principle, reclaimable — but another worker reclaims it first, so updateMany
  // matches 0 rows and this run must NOT send a duplicate email.
  const staleSentAt = new Date(Date.now() - 30 * 60 * 1000);
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      create: async () => {
        operations.push('reserve');
        throw Object.assign(new Error('duplicate reminder'), { code: 'P2002' });
      },
      findUnique: async () => {
        operations.push('findUnique');
        return {
          id: 'log_stale',
          status: 'SKIPPED',
          error: 'Reserved before delivery',
          sentAt: staleSentAt,
        };
      },
      updateMany: async () => {
        operations.push('reclaim');
        return { count: 0 };
      },
      update: async () => {
        operations.push('finalize');
      },
    },
  };

  const service = new DeadlineRemindersService(prisma as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return true;
    },
  } as never);

  await service.sendDueReminders();

  // The lost reclaim race short-circuits: no 'send' and no 'finalize'.
  assert.deepEqual(operations, ['reserve', 'findUnique', 'reclaim']);
});

// ---------------------------------------------------------------------------
// Document storage cleanup claim-query shape
// ---------------------------------------------------------------------------

// x-idempotency-idempotency-9
test('claim query reclaims rows whose claim is older than the stale window', async () => {
  let query = '';
  let queryValues: unknown[] = [];
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    async $queryRaw(this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
      query = strings.join('?');
      queryValues = values;
      return [{ id: 'deletion-1', organisationId: 'org-1', storagePath: 'org-1/policy.pdf' }];
    },
    documentStorageDeletion: {
      update: async () => ({}),
    },
  };
  const service = new DocumentService(prisma as never);

  const result = await service.retryPendingStorageDeletions(async () => undefined, 10);

  // The atomic-claim WHERE clause must include the stale-reclaim predicate so a
  // row whose claimedAt is older than the 10-minute stale window is re-claimable
  // after a worker crash (not only rows with claimedAt IS NULL).
  assert.match(query, /"processedAt" IS NULL/);
  assert.match(query, /"claimedAt" IS NULL OR/);
  assert.match(query, /"claimedAt" < CURRENT_TIMESTAMP - \(\?\s*\* INTERVAL '1 millisecond'\)/);
  // And it must still be a single atomic claim bound with the 600000ms stale
  // window and the caller's limit.
  assert.match(query, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(queryValues, [600000, 10]);
  assert.deepEqual(result, { processed: 1, failed: 0 });
});

// ---------------------------------------------------------------------------
// Scheduler alert-pipeline graceful degradation
// ---------------------------------------------------------------------------

// x-idempotency-graceful-degradation-12
test('job failure alerting tolerates a throwing alert sender without crashing the run', async () => {
  const logs: Array<{ message: string; error?: unknown }> = [];

  const failed = await runDeadlineReminders({
    deadlineService: {
      async sendDueReminders() {
        throw new Error('reminder run blew up');
      },
    },
    logger: {
      info() {},
      error(message: string, error?: unknown) {
        logs.push({ message, error });
      },
    },
    // The alert pipeline itself is broken; this must NOT turn a recoverable job
    // failure into an unhandled rejection.
    alertSender: async () => {
      throw new Error('alert webhook unreachable');
    },
  });

  // The run still reports the failed signal (true) and resolves cleanly.
  assert.equal(failed, true);

  // The alerting error is swallowed and logged, not rethrown.
  const alertLog = logs.find((entry) =>
    entry.message.includes('Failed to send deadline-reminders failure alert'),
  );
  assert.ok(alertLog, 'a contained alerting-failure log is emitted');
});
