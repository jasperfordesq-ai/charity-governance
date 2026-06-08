import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit';
process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID = 'price_essentials_monthly';
process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID = 'price_essentials_yearly';
process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID = 'price_complete_monthly';
process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = 'price_complete_yearly';
process.env.JWT_SECRET = 'unit-test-jwt-secret-with-enough-entropy';
process.env.FRONTEND_URL = 'https://app.example.org';

const { BillingService } = await import('../services/billing.service.js');
const { DeadlineRemindersService } = await import('../services/deadline-reminders.service.js');
const { default: Fastify } = await import('fastify');
const { billingRoutes } = await import('../routes/billing/index.js');

type BillingHarnessOptions = {
  existingSubscription?: Record<string, unknown> | null;
  existingWebhookEvent?: Record<string, unknown> | null;
  organisation?: Record<string, unknown> | null;
  retrievedSubscription?: Record<string, unknown>;
  ledgerCreate?: (args: unknown) => Promise<unknown>;
};

type StripeSessionArgs = {
  success_url?: string;
  cancel_url?: string;
  return_url?: string;
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
    items: {
      data: [
        {
          price: {
            id: 'price_complete_monthly',
          },
        },
      ],
    },
    ...overrides,
  };
}

function billingHarness(options: BillingHarnessOptions = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const retrievedSubscription = options.retrievedSubscription ?? stripeSubscription();
  let inTransaction = false;

  const prisma: Record<string, unknown> = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      calls.push({ name: 'transaction.start', args: null });
      inTransaction = true;
      try {
        return await callback(prisma);
      } finally {
        inTransaction = false;
        calls.push({ name: 'transaction.end', args: null });
      }
    },
    stripeWebhookEvent: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'stripeWebhookEvent.findUnique', args });
        return options.existingWebhookEvent ?? null;
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
        return options.organisation ?? { id: 'org_1', stripeCustomerId: 'cus_org_1' };
      },
    },
    subscription: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'subscription.findUnique', args });
        return (
          options.existingSubscription ?? {
            id: 'sub_db_1',
            organisationId: 'org_1',
            stripeSubscriptionId: 'sub_stripe_1',
            plan: 'COMPLETE',
            organisation: { stripeCustomerId: 'cus_org_1' },
          }
        );
      },
      upsert: async (args: unknown) => {
        calls.push({ name: 'subscription.upsert', args });
        return args;
      },
      update: async (args: unknown) => {
        calls.push({ name: 'subscription.update', args });
        return args;
      },
      updateMany: async (args: unknown) => {
        calls.push({ name: 'subscription.updateMany', args });
        return { count: 1 };
      },
    },
  };

  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push({ name: 'stripe.subscriptions.retrieve', args: { id, inTransaction } });
        return retrievedSubscription;
      },
    },
  };

  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => stripe;

  return { service, calls };
}

test('invalid Stripe webhook signatures return a client error', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {} as never);
  await app.register(billingRoutes, { prefix: '/billing' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhooks',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid',
      },
      payload: JSON.stringify({
        id: 'evt_invalid_signature',
        type: 'checkout.session.completed',
        data: { object: {} },
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: 'Invalid Stripe signature',
      code: 'INVALID_STRIPE_SIGNATURE',
    });
  } finally {
    await app.close();
  }
});

test('missing Stripe webhook signatures return a client error', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {} as never);
  await app.register(billingRoutes, { prefix: '/billing' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhooks',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        id: 'evt_missing_signature',
        type: 'checkout.session.completed',
        data: { object: {} },
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: 'Missing Stripe signature header',
      code: 'MISSING_STRIPE_SIGNATURE',
    });
  } finally {
    await app.close();
  }
});

test('checkout.session.completed derives subscription status from the retrieved Stripe subscription', async () => {
  const { service, calls } = billingHarness({
    retrievedSubscription: stripeSubscription({ status: 'past_due' }),
  });

  await service.handleWebhook({
    id: 'evt_checkout_status',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        customer: 'cus_org_1',
        subscription: 'sub_stripe_1',
        metadata: { organisationId: 'org_1', plan: 'COMPLETE' },
      },
    },
  } as never);

  const upsert = calls.find((call) => call.name === 'subscription.upsert');
  assert.ok(upsert);
  assert.equal((upsert.args as { create: { status: string } }).create.status, 'PAST_DUE');
  assert.equal((upsert.args as { update: { status: string } }).update.status, 'PAST_DUE');

  const retrieve = calls.find((call) => call.name === 'stripe.subscriptions.retrieve');
  assert.ok(retrieve);
  assert.equal((retrieve.args as { inTransaction: boolean }).inTransaction, false);
});

test('subscription.updated maps unhandled Stripe statuses to an access-denying status', async () => {
  const { service, calls } = billingHarness();

  await service.handleWebhook({
    id: 'evt_subscription_incomplete',
    type: 'customer.subscription.updated',
    data: {
      object: stripeSubscription({ status: 'incomplete' }),
    },
  } as never);

  const update = calls.find((call) => call.name === 'subscription.update');
  assert.ok(update);
  assert.equal((update.args as { data: { status: string } }).data.status, 'EXPIRED');
});

test('checkout.session.completed rejects metadata when the customer or price does not match the organisation plan', async () => {
  const { service, calls } = billingHarness({
    retrievedSubscription: stripeSubscription({
      customer: 'cus_attacker',
      items: { data: [{ price: { id: 'price_essentials_monthly' } }] },
    }),
  });

  await assert.rejects(
    () =>
      service.handleWebhook({
        id: 'evt_checkout_mismatch',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_2',
            customer: 'cus_attacker',
            subscription: 'sub_stripe_1',
            metadata: { organisationId: 'org_1', plan: 'COMPLETE' },
          },
        },
      } as never),
    /does not match/i,
  );

  assert.equal(calls.some((call) => call.name === 'subscription.upsert'), false);
});

test('duplicate Stripe webhook event ids are ignored before subscription mutation', async () => {
  const { service, calls } = billingHarness({
    existingWebhookEvent: { id: 'evt_duplicate' },
  });

  await service.handleWebhook({
    id: 'evt_duplicate',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_3',
        customer: 'cus_org_1',
        subscription: 'sub_stripe_1',
        metadata: { organisationId: 'org_1', plan: 'COMPLETE' },
      },
    },
  } as never);

  assert.equal(calls.some((call) => call.name === 'stripe.subscriptions.retrieve'), false);
  assert.equal(calls.some((call) => call.name === 'stripeWebhookEvent.create'), false);
  assert.equal(calls.some((call) => call.name === 'subscription.upsert'), false);
});

test('Stripe webhook unique errors outside the event ledger are rethrown', async () => {
  const uniqueError = Object.assign(new Error('duplicate subscription'), {
    code: 'P2002',
    meta: { modelName: 'Subscription', target: ['stripeSubscriptionId'] },
  });
  const { service } = billingHarness({
    retrievedSubscription: stripeSubscription({
      customer: 'cus_org_1',
      items: { data: [{ price: { id: 'price_complete_monthly' } }] },
    }),
  });

  (service as unknown as { prisma: Record<string, unknown> }).prisma = {
    ...(service as unknown as { prisma: Record<string, unknown> }).prisma,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        stripeWebhookEvent: { create: async () => ({}) },
        organisation: { findUnique: async () => ({ id: 'org_1', stripeCustomerId: 'cus_org_1' }) },
        subscription: {
          upsert: async () => {
            throw uniqueError;
          },
        },
      };
      return callback(tx);
    },
  };

  await assert.rejects(
    () =>
      service.handleWebhook({
        id: 'evt_subscription_collision',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_collision',
            customer: 'cus_org_1',
            subscription: 'sub_stripe_1',
            metadata: { organisationId: 'org_1', plan: 'COMPLETE' },
          },
        },
      } as never),
    /duplicate subscription/,
  );
});

test('billing status only allows past-due access inside the grace window', async () => {
  const now = Date.now();
  let subscription = {
    plan: 'COMPLETE',
    status: 'PAST_DUE',
    trialEndsAt: null,
    currentPeriodEnd: new Date(now - 8 * 24 * 60 * 60 * 1000),
  };
  const prisma = {
    subscription: {
      findUnique: async () => subscription,
    },
  };
  const service = new BillingService(prisma as never);

  const expired = await service.getStatus('org_1');

  assert.equal(expired.hasAccess, false);

  subscription = {
    plan: 'COMPLETE',
    status: 'PAST_DUE',
    trialEndsAt: null,
    currentPeriodEnd: new Date(now - 6 * 24 * 60 * 60 * 1000),
  };

  const inGrace = await service.getStatus('org_1');

  assert.equal(inGrace.hasAccess, true);
});

test('billing redirects use the primary frontend origin when multiple browser origins are configured', async () => {
  process.env.FRONTEND_URL = 'https://app.example.org, https://admin.example.org';
  const checkoutSessions: StripeSessionArgs[] = [];
  const portalSessions: StripeSessionArgs[] = [];
  const prisma = {
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org_1',
        name: 'Good Works',
        contactEmail: 'owner@example.org',
        stripeCustomerId: 'cus_existing',
      }),
      update: async () => undefined,
    },
  };
  const stripe = {
    customers: {
      create: async () => ({ id: 'cus_new' }),
    },
    checkout: {
      sessions: {
        create: async (args: StripeSessionArgs) => {
          checkoutSessions.push(args);
          return { url: 'https://checkout.stripe.example/session' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (args: StripeSessionArgs) => {
          portalSessions.push(args);
          return { url: 'https://billing.stripe.example/session' };
        },
      },
    },
  };
  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => stripe;

  await service.createCheckoutSession('org_1', 'COMPLETE' as never, 'monthly');
  await service.createPortalSession('org_1');

  assert.equal(checkoutSessions[0]?.success_url, 'https://app.example.org/billing?success=true');
  assert.equal(checkoutSessions[0]?.cancel_url, 'https://app.example.org/billing?cancelled=true');
  assert.equal(portalSessions[0]?.return_url, 'https://app.example.org/billing');
});

test('subscriptionGuard denies past-due tenants after the grace window', async () => {
  const { subscriptionGuard } = await import('../middleware/subscription.js');
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  const request = {
    user: { organisationId: 'org_1' },
    server: {
      prisma: {
        subscription: {
          findUnique: async () => ({
            status: 'PAST_DUE',
            trialEndsAt: null,
            currentPeriodEnd: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          }),
        },
      },
    },
  };

  await subscriptionGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 403);
  assert.deepEqual(reply.payload, {
    error: 'Your payment is past due and the grace period has ended. Please update billing to continue.',
    code: 'PAST_DUE_GRACE_EXPIRED',
  });
});

function reminderDeadline(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

test('deadline reminder lookup is scoped to entitled subscriptions and verified owner emails', async () => {
  let findManyArgs: Record<string, unknown> | undefined;
  const prisma = {
    deadline: {
      findMany: async (args: Record<string, unknown>) => {
        findManyArgs = args;
        return [];
      },
    },
  };

  const service = new DeadlineRemindersService(prisma as never, {
    sendDeadlineReminder: async () => true,
  } as never);

  await service.sendDueReminders();

  assert.ok(findManyArgs);
  const where = findManyArgs.where as {
    organisation?: { subscription?: { is: { OR: Array<Record<string, unknown>> } } };
  };
  assert.ok(where.organisation?.subscription, 'deadline lookup must filter by subscription entitlement');
  assert.deepEqual(where.organisation.subscription.is.OR[0], { status: 'ACTIVE' });
  assert.equal(where.organisation.subscription.is.OR[1]?.status, 'PAST_DUE');
  assert.ok(where.organisation.subscription.is.OR[1]?.currentPeriodEnd);
  assert.equal(where.organisation.subscription.is.OR[2]?.status, 'TRIALING');

  const users = (findManyArgs.include as {
    organisation: { include: { users: { where: Record<string, unknown> } } };
  }).organisation.include.users;
  assert.deepEqual(users.where, { role: 'OWNER', emailVerified: true });
});

test('deadline reminders skip ineligible tenants and unverified owner emails returned by the database', async () => {
  const emailCalls: unknown[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [
        reminderDeadline({
          id: 'deadline_cancelled',
          organisation: {
            id: 'org_cancelled',
            name: 'Cancelled Charity',
            subscription: { status: 'CANCELLED', trialEndsAt: null },
            users: [{ id: 'user_cancelled', email: 'cancelled@example.org', emailVerified: true }],
          },
        }),
        reminderDeadline({
          id: 'deadline_unverified',
          organisation: {
            id: 'org_unverified',
            name: 'Unverified Charity',
            subscription: { status: 'ACTIVE', trialEndsAt: null },
            users: [{ id: 'user_unverified', email: 'unverified@example.org', emailVerified: false }],
          },
        }),
      ],
    },
    deadlineReminderLog: {
      findUnique: async () => null,
      upsert: async () => undefined,
      create: async () => {
        throw new Error('should not reserve ineligible reminders');
      },
    },
  };

  const service = new DeadlineRemindersService(prisma as never, {
    sendDeadlineReminder: async (...args: unknown[]) => {
      emailCalls.push(args);
      return true;
    },
  } as never);

  await service.sendDueReminders();

  assert.equal(emailCalls.length, 0);
});

test('deadline reminders reserve the unique reminder log before sending email', async () => {
  const operations: string[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      create: async (args: unknown) => {
        operations.push('reserve');
        return { id: 'log_1', ...(args as { data: Record<string, unknown> }).data };
      },
      update: async () => {
        operations.push('finalize');
      },
      findUnique: async () => {
        operations.push('findUnique');
        return null;
      },
      upsert: async () => {
        operations.push('upsert');
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

  assert.deepEqual(operations, ['reserve', 'send', 'finalize']);
});

test('deadline reminders skip sending when another worker already reserved the reminder log', async () => {
  const uniqueError = Object.assign(new Error('duplicate reminder'), { code: 'P2002' });
  const operations: string[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      findUnique: async () => null,
      create: async () => {
        operations.push('reserve');
        throw uniqueError;
      },
      update: async () => {
        operations.push('finalize');
      },
      upsert: async () => {
        operations.push('upsert');
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

  assert.deepEqual(operations, ['reserve']);
});

test('deadline reminders retry a previously failed reminder log instead of suppressing it', async () => {
  const operations: string[] = [];
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
        return { id: 'log_failed', status: 'FAILED', sentAt: new Date(Date.now() - 60_000) };
      },
      updateMany: async () => {
        operations.push('reclaim');
        return { count: 1 };
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

  assert.deepEqual(operations, ['reserve', 'findUnique', 'reclaim', 'send', 'finalize']);
});

test('deadline reminders reclaim stale reservations that were never finalized', async () => {
  const operations: string[] = [];
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
        return { id: 'log_stale', status: 'SKIPPED', error: 'Reserved before delivery', sentAt: staleSentAt };
      },
      updateMany: async () => {
        operations.push('reclaim');
        return { count: 1 };
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

  assert.deepEqual(operations, ['reserve', 'findUnique', 'reclaim', 'send', 'finalize']);
});
