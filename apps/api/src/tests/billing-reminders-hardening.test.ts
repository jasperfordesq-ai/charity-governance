import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit';
process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_unit';
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

function testOnlyBillingInternals(service: InstanceType<typeof BillingService>) {
  return service as unknown as {
    createCheckoutSession: (
      organisationId: string,
      plan: never,
      interval: 'monthly' | 'yearly',
    ) => Promise<{ url: string }>;
    createPortalSession: (organisationId: string) => Promise<{ url: string }>;
  };
}

type BillingHarnessOptions = {
  existingSubscription?: Record<string, unknown> | null;
  checkoutExistingSubscription?: Record<string, unknown> | null;
  checkoutAttempt?: Record<string, unknown> | null;
  existingWebhookEvent?: Record<string, unknown> | null;
  organisation?: Record<string, unknown> | null;
  retrievedSubscription?: Record<string, unknown>;
  ledgerCreate?: (args: unknown) => Promise<unknown>;
};

type StripeSessionArgs = {
  success_url?: string;
  cancel_url?: string;
  return_url?: string;
  configuration?: string;
};

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_org_1',
    status: 'active',
    current_period_start: 1_781_078_400,
    current_period_end: 1_783_670_400,
    canceled_at: null,
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          quantity: 1,
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
    billingCheckoutAttempt: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'billingCheckoutAttempt.findUnique', args });
        return options.checkoutAttempt === undefined
          ? {
              id: 'attempt_1',
              organisationId: 'org_1',
              requestedPlan: 'COMPLETE',
              interval: 'monthly',
              status: 'SESSION_CREATED',
              stripeCheckoutSessionId: null,
              checkoutUrl: 'https://checkout.stripe.test/session',
              expectedPreviousStripeSubscriptionId: null,
              expiresAt: new Date(Date.now() + 60_000),
            }
          : options.checkoutAttempt;
      },
      update: async (args: unknown) => {
        calls.push({ name: 'billingCheckoutAttempt.update', args });
        return args;
      },
    },
    subscription: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'subscription.findUnique', args });
        const where = (args as { where?: Record<string, unknown> }).where;
        if (where && 'organisationId' in where) {
          return options.checkoutExistingSubscription ?? null;
        }
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
      list: async (args: unknown) => {
        calls.push({ name: 'stripe.subscriptions.list', args });
        return { data: [retrievedSubscription], has_more: false };
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
        metadata: {
          organisationId: 'org_1',
          plan: 'COMPLETE',
          interval: 'monthly',
          checkoutAttemptId: 'attempt_1',
        },
      },
    },
  } as never);

  const upsert = calls.find((call) => call.name === 'subscription.upsert');
  assert.ok(upsert);
  assert.equal((upsert.args as { create: { status: string } }).create.status, 'PAST_DUE');
  assert.equal((upsert.args as { update: { status: string } }).update.status, 'PAST_DUE');
  assert.equal((upsert.args as { create: { stripeStatus: string } }).create.stripeStatus, 'past_due');
  assert.equal((upsert.args as { create: { billingInterval: string } }).create.billingInterval, 'monthly');
  assert.equal((upsert.args as { create: { cancelAtPeriodEnd: boolean } }).create.cancelAtPeriodEnd, false);

  const retrieve = calls.find((call) => call.name === 'stripe.subscriptions.retrieve');
  assert.ok(retrieve);
  assert.equal((retrieve.args as { inTransaction: boolean }).inTransaction, false);
});

test('subscription.updated maps unhandled Stripe statuses to an access-denying status', async () => {
  const { service, calls } = billingHarness({
    retrievedSubscription: stripeSubscription({ status: 'incomplete' }),
  });

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

test('subscription.updated ignores stale event state and persists the authoritative Stripe subscription', async () => {
  const { service, calls } = billingHarness({
    retrievedSubscription: stripeSubscription({
      status: 'canceled',
      canceled_at: 1_783_670_400,
      cancel_at_period_end: false,
      items: {
        data: [{ quantity: 1, price: { id: 'price_essentials_yearly' } }],
      },
    }),
  });

  await service.handleWebhook({
    id: 'evt_stale_subscription_update',
    type: 'customer.subscription.updated',
    data: {
      object: stripeSubscription({
        status: 'active',
        items: {
          data: [{ quantity: 1, price: { id: 'price_complete_monthly' } }],
        },
      }),
    },
  } as never);

  const update = calls.find((call) => call.name === 'subscription.update');
  assert.ok(update);
  const data = (update.args as { data: Record<string, unknown> }).data;
  assert.equal(data.status, 'CANCELLED');
  assert.equal(data.stripeStatus, 'canceled');
  assert.equal(data.plan, 'ESSENTIALS');
  assert.equal(data.billingInterval, 'yearly');
});

test('checkout.session.completed rejects metadata when the customer or price does not match the organisation plan', async () => {
  const { service, calls } = billingHarness({
    retrievedSubscription: stripeSubscription({
      customer: 'cus_attacker',
      items: { data: [{ quantity: 1, price: { id: 'price_essentials_monthly' } }] },
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
            metadata: {
              organisationId: 'org_1',
              plan: 'COMPLETE',
              interval: 'monthly',
              checkoutAttemptId: 'attempt_1',
            },
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
        metadata: {
          organisationId: 'org_1',
          plan: 'COMPLETE',
          interval: 'monthly',
          checkoutAttemptId: 'attempt_1',
        },
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
      items: { data: [{ quantity: 1, price: { id: 'price_complete_monthly' } }] },
    }),
  });

  (service as unknown as { prisma: Record<string, unknown> }).prisma = {
    ...(service as unknown as { prisma: Record<string, unknown> }).prisma,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        stripeWebhookEvent: { create: async () => ({}) },
        organisation: { findUnique: async () => ({ id: 'org_1', stripeCustomerId: 'cus_org_1' }) },
        billingCheckoutAttempt: {
          findUnique: async () => ({
            id: 'attempt_1',
            organisationId: 'org_1',
            requestedPlan: 'COMPLETE',
            interval: 'monthly',
            status: 'SESSION_CREATED',
            stripeCheckoutSessionId: 'cs_test_collision',
            checkoutUrl: 'https://checkout.stripe.test/session',
            expectedPreviousStripeSubscriptionId: null,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        },
        subscription: {
          findUnique: async () => null,
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
            metadata: {
              organisationId: 'org_1',
              plan: 'COMPLETE',
              interval: 'monthly',
              checkoutAttemptId: 'attempt_1',
            },
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
    organisation: {
      findUnique: async () => ({ stripeCustomerId: 'cus_org_1' }),
    },
    subscription: {
      findUnique: async () => subscription,
    },
    billingAuthorityGrant: {
      findFirst: async () => null,
    },
  };
  const service = new BillingService(prisma as never);

  const expired = await service.getStatus('org_1', { id: 'u1', sessionId: 'sess-1', role: 'OWNER' });

  assert.equal(expired.hasAccess, false);

  subscription = {
    plan: 'COMPLETE',
    status: 'PAST_DUE',
    trialEndsAt: null,
    currentPeriodEnd: new Date(now - 6 * 24 * 60 * 60 * 1000),
  };

  const inGrace = await service.getStatus('org_1', { id: 'u1', sessionId: 'sess-1', role: 'OWNER' });

  assert.equal(inGrace.hasAccess, true);
});

test('billing redirects use the primary frontend origin when multiple browser origins are configured', async () => {
  process.env.FRONTEND_URL = 'https://app.example.org, https://admin.example.org';
  const checkoutSessions: StripeSessionArgs[] = [];
  const portalSessions: StripeSessionArgs[] = [];
  let checkoutAttempt: Record<string, unknown> | null = null;
  const subscription = { findUnique: async () => null };
  const billingCheckoutAttempt = {
    findUnique: async () => checkoutAttempt,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      checkoutAttempt = {
        ...data,
        status: 'PENDING',
        stripeCheckoutSessionId: null,
        checkoutUrl: null,
      };
      return checkoutAttempt;
    },
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      checkoutAttempt = { ...checkoutAttempt, ...data };
      return { count: 1 };
    },
  };
  const prisma = {
    subscription,
    billingCheckoutAttempt,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ subscription, billingCheckoutAttempt }),
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
    subscriptions: {
      list: async () => ({ data: [], has_more: false }),
    },
    customers: {
      create: async () => ({ id: 'cus_new' }),
    },
    checkout: {
      sessions: {
        create: async (args: StripeSessionArgs) => {
          checkoutSessions.push(args);
          return { id: 'cs_redirect_test', url: 'https://checkout.stripe.example/session' };
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

  await testOnlyBillingInternals(service).createCheckoutSession('org_1', 'COMPLETE' as never, 'monthly');
  await testOnlyBillingInternals(service).createPortalSession('org_1');

  assert.equal(checkoutSessions[0]?.success_url, 'https://app.example.org/billing?success=true');
  assert.equal(checkoutSessions[0]?.cancel_url, 'https://app.example.org/billing?cancelled=true');
  assert.equal(portalSessions[0]?.return_url, 'https://app.example.org/billing');
  assert.equal(portalSessions[0]?.configuration, 'bpc_unit');
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
    scheduleVersion: 1,
    reminderDays: [7],
    organisation: {
      id: 'org_1',
      name: 'Governance Charity',
      subscription: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null },
      users: [{ id: 'user_1', email: 'owner@example.org', role: 'OWNER', emailVerified: true }],
    },
    ...overrides,
  };
}

function withReminderClaim<T extends { deadline: Record<string, unknown> }>(prisma: T) {
  const suppliedReminderLog = 'deadlineReminderLog' in prisma
    ? (prisma as { deadlineReminderLog: Record<string, unknown> }).deadlineReminderLog
    : {};
  const suppliedUpdateMany = suppliedReminderLog.updateMany as
    | ((args: Record<string, unknown>) => Promise<{ count: number }>)
    | undefined;
  const client = {
    ...prisma,
    deadline: {
      findFirst: async () => ({ id: 'current-deadline' }),
      ...prisma.deadline,
    },
    deadlineReminderLog: {
      findFirst: async () => null,
      count: async () => 0,
      ...suppliedReminderLog,
      updateMany: async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown> | undefined;
        if (where?.status === 'SENDING' && 'providerRequestStartedAt' in where) {
          return { count: 0 };
        }
        return suppliedUpdateMany ? suppliedUpdateMany(args) : { count: 1 };
      },
    },
    user: {
      findFirst: async () => ({ id: 'user_1' }),
      ...('user' in prisma ? (prisma as { user: Record<string, unknown> }).user : {}),
    },
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null }),
      ...('subscription' in prisma
        ? (prisma as { subscription: Record<string, unknown> }).subscription
        : {}),
    },
    organisation: {
      findUnique: async () => ({ name: 'Governance Charity' }),
      ...('organisation' in prisma
        ? (prisma as { organisation: Record<string, unknown> }).organisation
        : {}),
    },
    $queryRaw:
      '$queryRaw' in prisma
        ? (prisma as { $queryRaw: () => Promise<Array<{ id: string }>> }).$queryRaw
        : async () => [{ id: 'current-deadline' }],
  } as T & {
    $queryRaw: () => Promise<Array<{ id: string }>>;
    $transaction?: (operation: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  client.$transaction = async (operation) => operation(client);
  return client;
}

let acceptedReminderSequence = 0;
function acceptedReminder() {
  acceptedReminderSequence += 1;
  return {
    outcome: 'ACCEPTED' as const,
    providerMessageId: `provider-test-accepted-${acceptedReminderSequence}`,
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

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => acceptedReminder(),
  } as never);

  await service.sendDueReminders();

  assert.ok(findManyArgs);
  const where = findManyArgs.where as {
    supersededAt?: null;
    archivedAt?: null;
    organisation?: { subscription?: { is: { OR: Array<Record<string, unknown>> } } };
  };
  assert.equal(where.supersededAt, null);
  assert.equal(where.archivedAt, null);
  assert.ok(where.organisation?.subscription, 'deadline lookup must filter by subscription entitlement');
  assert.deepEqual(where.organisation.subscription.is.OR[0], { status: 'ACTIVE' });
  assert.equal(where.organisation.subscription.is.OR[1]?.status, 'PAST_DUE');
  assert.ok(where.organisation.subscription.is.OR[1]?.currentPeriodEnd);
  assert.equal(where.organisation.subscription.is.OR[2]?.status, 'TRIALING');

  const users = (findManyArgs.include as {
    organisation: { include: { users: { where: Record<string, unknown> } } };
  }).organisation.include.users;
  assert.deepEqual(users.where, {
    role: 'OWNER',
    emailVerified: true,
    lifecycleStatus: 'ACTIVE',
  });
  assert.deepEqual((users as { orderBy?: unknown }).orderBy, { id: 'asc' });
});

test('deadline reminder pagination uses immutable ids across a boundary-row reschedule', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const rows = Array.from({ length: 101 }, (_, index) => reminderDeadline({
    id: `deadline_${String(index + 1).padStart(3, '0')}`,
    organisation: {
      id: `org_${index + 1}`,
      name: `Charity ${index + 1}`,
      subscription: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null },
      users: [],
    },
  }));
  const prisma = {
    deadline: {
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        if (queries.length === 1) return rows.slice(0, 100);
        // A concurrent admin reschedules the page-1 boundary row after it was
        // read. The next page must still use its immutable id, never dueDate.
        rows[99].dueDate = new Date('2040-01-01T00:00:00.000Z');
        return rows.slice(100);
      },
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => acceptedReminder(),
  } as never).sendDueReminders();

  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].orderBy, { id: 'asc' });
  assert.deepEqual(queries[1].cursor, { id: 'deadline_100' });
  assert.equal(queries[1].skip, 1);
});

test('deadline reminder visibility uses the Europe/Dublin civil day across the DST rollover', async () => {
  let daysUntilDue: number | undefined;
  const candidate = reminderDeadline({
    dueDate: new Date('2026-04-06T00:00:00.000Z'),
    reminderDays: [7],
  });
  const prisma = {
    deadline: { findMany: async () => [candidate] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'dst-log', ...args.data }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async (_email: string, _organisation: string, details: { daysUntilDue: number }) => {
      daysUntilDue = details.daysUntilDue;
      return acceptedReminder();
    },
  } as never);

  await service.sendDueReminders(new Date('2026-03-29T23:30:00.000Z'));

  assert.equal(daysUntilDue, 7);
});

test('deadline reminders deliver once to every verified owner in the deterministic candidate list', async () => {
  const recipients: string[] = [];
  const candidate = reminderDeadline({
    organisation: {
      id: 'org_1',
      name: 'Governance Charity',
      subscription: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null },
      users: [
        { id: 'owner_1', email: 'first@example.org', role: 'OWNER', emailVerified: true },
        { id: 'owner_2', email: 'second@example.org', role: 'OWNER', emailVerified: true },
      ],
    },
  });
  const prisma = {
    deadline: { findMany: async () => [candidate] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({
        id: `log-${String(args.data.email)}`,
        ...args.data,
      }),
      updateMany: async () => ({ count: 1 }),
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async (email: string) => {
      recipients.push(email);
      return acceptedReminder();
    },
  } as never).sendDueReminders();

  assert.deepEqual(recipients, ['first@example.org', 'second@example.org']);
});

test('deadline reminder default logger is silent in test environment', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInfo = console.info;
  let infoCalls = 0;

  process.env.NODE_ENV = 'test';
  console.info = ((..._args: unknown[]) => {
    infoCalls += 1;
  }) as typeof console.info;

  try {
    const prisma = {
      deadline: {
        findMany: async () => [],
      },
    };

    const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
      sendDeadlineReminder: async () => acceptedReminder(),
    } as never);

    await service.sendDueReminders();

    assert.equal(infoCalls, 0);
  } finally {
    console.info = originalInfo;
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
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

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async (...args: unknown[]) => {
      emailCalls.push(args);
      return acceptedReminder();
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
      updateMany: async (args: { data: { status: string } }) => {
        operations.push(args.data.status === 'SENDING' ? 'start' : 'finalize');
        return { count: 1 };
      },
      findFirst: async () => {
        operations.push('findActive');
        return null;
      },
    },
  };

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never);

  await service.sendDueReminders();

  assert.deepEqual(operations, ['findActive', 'reserve', 'start', 'send', 'finalize']);
});

test('deadline reminder claim binds the due date as a timezone-independent civil string', async () => {
  const rawValues: unknown[][] = [];
  const candidate = reminderDeadline({ dueDate: new Date('2030-01-15T00:00:00.000Z') });
  const prisma = {
    deadline: { findMany: async () => [candidate] },
    deadlineReminderLog: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'log_1', ...args.data }),
      updateMany: async () => ({ count: 1 }),
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      rawValues.push(values);
      return [{ id: 'current-deadline' }];
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => acceptedReminder(),
  } as never).sendDueReminders(new Date('2030-01-08T12:00:00.000Z'));

  assert.equal(rawValues.length, 2);
  assert.ok(rawValues[1].includes('2030-01-15'));
  assert.equal(rawValues[1].some((value) => value instanceof Date), false);
});

test('deadline reminder snapshots and provider keys are scoped to the manual schedule occurrence', async () => {
  async function run(scheduleVersion: number) {
    let reservedData: Record<string, unknown> | undefined;
    let providerOptions: { idempotencyKey?: string } | undefined;
    const candidate = reminderDeadline({ scheduleVersion });
    const prisma = {
      deadline: { findMany: async () => [candidate] },
      deadlineReminderLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          reservedData = args.data;
          return { id: `log_${scheduleVersion}`, ...args.data };
        },
        updateMany: async () => ({ count: 1 }),
      },
    };
    await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
      sendDeadlineReminder: async (...args: unknown[]) => {
        providerOptions = args[3] as { idempotencyKey?: string };
        return acceptedReminder();
      },
    } as never).sendDueReminders();
    return { reservedData, providerOptions };
  }

  const first = await run(1);
  const rescheduled = await run(2);

  assert.equal(first.reservedData?.deadlineScheduleVersion, 1);
  assert.equal(first.reservedData?.deadlineTitle, 'Annual report');
  assert.equal(first.reservedData?.deadlineSnapshotKnown, true);
  assert.equal(first.reservedData?.deliveryTimingKnown, true);
  assert.equal(first.reservedData?.legacyDeliveryStatus, null);
  assert.ok(first.reservedData?.deadlineDueDate instanceof Date);
  assert.match(first.providerOptions?.idempotencyKey ?? '', /^deadline-reminder\/[0-9a-f]{64}$/);
  assert.notEqual(first.providerOptions?.idempotencyKey, rescheduled.providerOptions?.idempotencyKey);
});

test('deadline reminders skip sending when another worker already reserved the reminder log', async () => {
  const operations: string[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      findFirst: async () => {
        operations.push('findActive');
        return {
          id: 'active-log',
          status: 'RESERVED',
          reservationToken: 'active-token',
          reservedAt: new Date(),
        };
      },
      create: async () => {
        operations.push('reserve');
        throw new Error('must not create over a current reservation');
      },
    },
  };

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never);

  await service.sendDueReminders();

  assert.deepEqual(operations, ['findActive']);
});

test('deadline reminders cancel a claim when the occurrence changes before provider delivery', async () => {
  const operations: string[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
      findFirst: async (args: { where: { reminderDays: { has: number } } }) => {
        assert.deepEqual(args.where.reminderDays, { has: 7 });
        return null;
      },
    },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        operations.push('reserve');
        return { id: 'log_changed', ...args.data };
      },
      updateMany: async (args: { data: { status: string; error: string } }) => {
        operations.push('cancel');
        assert.equal(args.data.status, 'SKIPPED');
        assert.equal(
          args.data.error,
          'Deadline, recipient or subscription changed before reminder delivery',
        );
        return { count: 1 };
      },
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never).sendDueReminders();

  assert.deepEqual(operations, ['reserve', 'cancel']);
});

test('deadline reminders do not email a recipient who loses verified owner access after the scan', async () => {
  const operations: string[] = [];
  let recipientReads = 0;
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    user: {
      findFirst: async () => {
        recipientReads += 1;
        return recipientReads === 1 ? { id: 'user_1' } : null;
      },
    },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        operations.push('reserve');
        return { id: 'recipient-changed', ...args.data };
      },
      updateMany: async (args: { data: { status: string } }) => {
        operations.push('cancel');
        assert.equal(args.data.status, 'SKIPPED');
        return { count: 1 };
      },
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never).sendDueReminders();

  assert.deepEqual(operations, ['reserve', 'cancel']);
});

test('deadline reminder provider rejection stays retryable and fails the run with a count-only signal', async () => {
  let started: { data: Record<string, unknown> } | undefined;
  let finalized: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'log_failed', ...args.data }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (args.data.status === 'SENDING') started = args;
        else finalized = args;
        return { count: 1 };
      },
    },
  };

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => ({ outcome: 'REJECTED' }),
  } as never);

  await assert.rejects(
    () => service.sendDueReminders(),
    (error: unknown) => {
      assert.equal((error as Error).name, 'DeadlineReminderDeliveryFailure');
      assert.match((error as Error).message, /1 failed, 0 uncertain/);
      assert.doesNotMatch((error as Error).message, /owner@example\.org|Annual report|Governance Charity/);
      return true;
    },
  );

  assert.equal(finalized?.where.id, 'log_failed');
  assert.equal(finalized?.data.status, 'FAILED');
  assert.equal(
    finalized?.data.error,
    'Email provider was not configured or definitely rejected the message',
  );
  assert.ok(started?.data.attemptedAt instanceof Date);
  assert.ok(started?.data.providerRequestStartedAt instanceof Date);
  assert.equal(finalized?.data.sentAt, null);
});

test('deadline reminder retries create a new immutable attempt after a previous failure', async () => {
  const operations: string[] = [];
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        operations.push('reserve');
        return { id: 'log_retry', ...args.data };
      },
      updateMany: async (args: { data: { status: string } }) => {
        operations.push(args.data.status === 'SENDING' ? 'start' : 'finalize');
        return { count: 1 };
      },
    },
  };

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never);

  await service.sendDueReminders();

  assert.deepEqual(operations, ['reserve', 'start', 'send', 'finalize']);
});

test('deadline reminders reclaim stale reservations that were never finalized', async () => {
  const operations: string[] = [];
  const staleReservedAt = new Date(Date.now() - 30 * 60 * 1000);
  let updateAttempts = 0;
  const prisma = {
    deadline: {
      findMany: async () => [reminderDeadline()],
    },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        operations.push('reserve');
        return { id: 'log_retry', ...args.data };
      },
      findFirst: async () => {
        operations.push('findActive');
        return {
          id: 'log_stale',
          status: 'RESERVED',
          reservationToken: 'stale-token',
          reservedAt: staleReservedAt,
        };
      },
      updateMany: async (args: { data: { status: string } }) => {
        updateAttempts += 1;
        operations.push(
          updateAttempts === 1 ? 'expire' : args.data.status === 'SENDING' ? 'start' : 'finalize',
        );
        return { count: 1 };
      },
    },
  };

  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never);

  await service.sendDueReminders();

  assert.deepEqual(operations, ['findActive', 'expire', 'reserve', 'start', 'send', 'finalize']);
});

test('stale provider requests are quarantined globally and raise a count-only alert', async () => {
  let emailCalls = 0;
  const service = new DeadlineRemindersService({
    deadline: { findMany: async () => [] },
    deadlineReminderLog: {
      count: async () => 2,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        assert.equal(args.where.status, 'SENDING');
        assert.ok(args.where.providerRequestStartedAt);
        assert.equal(args.data.status, 'UNCERTAIN');
        return { count: 2 };
      },
    },
  } as never, {
    sendDeadlineReminder: async () => {
      emailCalls += 1;
      return { outcome: 'ACCEPTED', providerMessageId: 'must-not-send' };
    },
  } as never);

  await assert.rejects(
    () => service.sendDueReminders(),
    (error: unknown) => {
      assert.equal((error as Error).name, 'DeadlineReminderDeliveryFailure');
      assert.match((error as Error).message, /0 failed, 2 uncertain/);
      assert.doesNotMatch(
        (error as Error).message,
        /owner@example\.org|Annual report|Governance Charity/,
      );
      return true;
    },
  );
  assert.equal(emailCalls, 0);
});

test('ambiguous provider outcomes become terminal UNCERTAIN rather than retryable FAILED', async () => {
  let finalStatus = '';
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'log_uncertain', ...args.data }),
      updateMany: async (args: { data: { status: string } }) => {
        if (args.data.status !== 'SENDING') finalStatus = args.data.status;
        return { count: 1 };
      },
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => ({ outcome: 'UNCERTAIN' }),
  } as never);

  await assert.rejects(() => service.sendDueReminders(), /0 failed, 1 uncertain/);
  assert.equal(finalStatus, 'UNCERTAIN');
});

test('an unexpected provider adapter throw after SENDING is quarantined as UNCERTAIN', async () => {
  const statuses: string[] = [];
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'log_throw', ...args.data }),
      updateMany: async (args: { data: { status: string } }) => {
        statuses.push(args.data.status);
        return { count: 1 };
      },
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      throw new Error('socket closed after request write');
    },
  } as never);

  await assert.rejects(() => service.sendDueReminders(), /0 failed, 1 uncertain/);
  assert.deepEqual(statuses, ['SENDING', 'UNCERTAIN']);
});

test('an unreconciled uncertain delivery suppresses automatic resend', async () => {
  const operations: string[] = [];
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      count: async () => 1,
      findFirst: async () => {
        operations.push('findActive');
        return {
          id: 'uncertain-log',
          status: 'UNCERTAIN',
          reservationToken: 'uncertain-token',
          reservedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        };
      },
      create: async () => {
        operations.push('reserve');
        throw new Error('must not reserve over an uncertain provider outcome');
      },
    },
  };

  await assert.rejects(
    () => new DeadlineRemindersService(withReminderClaim(prisma) as never, {
      sendDeadlineReminder: async () => {
        operations.push('send');
        return acceptedReminder();
      },
    } as never).sendDueReminders(),
    /0 failed, 1 uncertain/,
  );

  assert.deepEqual(operations, ['findActive']);
});

test('definite rejection retries use a new attempt-scoped provider key', async () => {
  const providerKeys: string[] = [];
  let attempt = 0;
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => ({
        id: `retry-${++attempt}`,
        ...args.data,
      }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async (...args: unknown[]) => {
      providerKeys.push((args[3] as { idempotencyKey: string }).idempotencyKey);
      return { outcome: 'REJECTED' };
    },
  } as never);

  await assert.rejects(() => service.sendDueReminders(), /1 failed, 0 uncertain/);
  await assert.rejects(() => service.sendDueReminders(), /1 failed, 0 uncertain/);
  assert.equal(providerKeys.length, 2);
  assert.match(providerKeys[0], /^deadline-reminder\/[0-9a-f]{64}$/);
  assert.notEqual(providerKeys[0], providerKeys[1]);
});

test('a definitive slow-provider result can finalize a concurrently quarantined attempt', async () => {
  let state = 'RESERVED';
  let providerMessageId: unknown;
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'slow-log', ...args.data }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (args.data.status === 'SENDING') {
          assert.equal(state, 'RESERVED');
          state = 'SENDING';
          return { count: 1 };
        }
        assert.deepEqual(args.where.status, { in: ['SENDING', 'UNCERTAIN'] });
        assert.equal(args.where.reconciliationOutcome, null);
        assert.equal(state, 'UNCERTAIN');
        state = String(args.data.status);
        providerMessageId = args.data.providerMessageId;
        return { count: 1 };
      },
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      state = 'UNCERTAIN';
      return { outcome: 'ACCEPTED', providerMessageId: 'provider-slow-accepted' };
    },
  } as never);

  await service.sendDueReminders();

  assert.equal(state, 'SENT');
  assert.equal(providerMessageId, 'provider-slow-accepted');
});

test('reconciled provider-accepted and acknowledged-unknown outcomes remain active resend suppressors', async () => {
  for (const reconciliationOutcome of ['ACCEPTED_CONFIRMED', 'UNKNOWN_ACKNOWLEDGED'] as const) {
    const operations: string[] = [];
    const prisma = {
      deadline: { findMany: async () => [reminderDeadline()] },
      deadlineReminderLog: {
        count: async (args: { where: Record<string, unknown> }) => {
          assert.deepEqual(args.where, { status: 'UNCERTAIN', reconciliationOutcome: null });
          return 0;
        },
        findFirst: async (args: { where: { OR: unknown[] } }) => {
          operations.push('findActive');
          assert.ok(args.where.OR, 'active lookup must use the reconciliation-aware predicate');
          return {
            id: `reconciled-${reconciliationOutcome}`,
            status: 'UNCERTAIN',
            reconciliationOutcome,
            reservationToken: 'existing-token',
            reservedAt: new Date(),
          };
        },
        create: async () => {
          operations.push('reserve');
          throw new Error('must not reserve over a reconciled suppressor');
        },
      },
    };

    await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
      sendDeadlineReminder: async () => {
        operations.push('send');
        return acceptedReminder();
      },
    } as never).sendDueReminders();

    assert.deepEqual(operations, ['findActive']);
  }
});

test('NOT_ACCEPTED_CONFIRMED reconciliation permits one fresh immutable reminder attempt', async () => {
  const operations: string[] = [];
  let activeLookupWhere: Record<string, unknown> | undefined;
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        activeLookupWhere = args.where;
        operations.push('findActive');
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        operations.push('reserve');
        return { id: 'retry-after-not-accepted', ...args.data };
      },
      updateMany: async (args: { data: { status: string } }) => {
        operations.push(args.data.status === 'SENDING' ? 'start' : 'finalize');
        return { count: 1 };
      },
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => {
      operations.push('send');
      return acceptedReminder();
    },
  } as never).sendDueReminders();

  assert.deepEqual(activeLookupWhere?.OR, [
    { status: { in: ['RESERVED', 'SENDING', 'SENT'] } },
    {
      status: 'UNCERTAIN',
      OR: [
        { reconciliationOutcome: null },
        { reconciliationOutcome: { in: ['ACCEPTED_CONFIRMED', 'UNKNOWN_ACKNOWLEDGED'] } },
      ],
    },
  ]);
  assert.deepEqual(operations, ['findActive', 'reserve', 'start', 'send', 'finalize']);
});

test('a legacy boolean delivery adapter cannot fabricate provider acceptance evidence', async () => {
  let finalized: Record<string, unknown> | undefined;
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'boolean-adapter', ...args.data }),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        if (args.data.status !== 'SENDING') finalized = args.data;
        return { count: 1 };
      },
    },
  };
  const service = new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => true,
  } as never);

  await assert.rejects(() => service.sendDueReminders(), /0 failed, 1 uncertain/);
  assert.equal(finalized?.status, 'UNCERTAIN');
  assert.equal(finalized?.providerMessageId, null);
  assert.equal(finalized?.sentAt, null);
});

test('operator reconciliation wins the compare-and-set race against a late provider finalizer', async () => {
  let state = 'RESERVED';
  const prisma = {
    deadline: { findMany: async () => [reminderDeadline()] },
    deadlineReminderLog: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'operator-race', ...args.data }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (args.data.status === 'SENDING') {
          state = 'SENDING';
          return { count: 1 };
        }
        assert.equal(args.where.reconciliationOutcome, null);
        state = 'RECONCILED_DELIVERED';
        return { count: 0 };
      },
    },
  };

  await new DeadlineRemindersService(withReminderClaim(prisma) as never, {
    sendDeadlineReminder: async () => ({
      outcome: 'ACCEPTED',
      providerMessageId: 'provider-too-late',
    }),
  } as never).sendDueReminders();

  assert.equal(state, 'RECONCILED_DELIVERED');
});
