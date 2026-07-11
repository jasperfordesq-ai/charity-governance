import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_billing_integrity';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_billing_integrity';
process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID =
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID ?? 'bpc_billing_integrity';
process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID ?? 'price_essentials_monthly';
process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID ?? 'price_essentials_yearly';
process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID ?? 'price_complete_monthly';
process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID ?? 'price_complete_yearly';
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://app.example.org';

const [{ BillingService }, { SubscriptionPlan }] = await Promise.all([
  import('../services/billing.service.js'),
  import('@charitypilot/shared'),
]);

function testOnlyCheckout(service: InstanceType<typeof BillingService>) {
  return (service as unknown as {
    createCheckoutSession: (
      organisationId: string,
      plan: typeof SubscriptionPlan.ESSENTIALS | typeof SubscriptionPlan.COMPLETE,
      interval: 'monthly' | 'yearly',
    ) => Promise<{ url: string }>;
  }).createCheckoutSession.bind(service);
}

type LocalSubscription = {
  stripeSubscriptionId: string | null;
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
};

type CheckoutAttempt = {
  id: string;
  organisationId: string;
  requestedPlan: 'ESSENTIALS' | 'COMPLETE';
  interval: 'monthly' | 'yearly';
  status: 'PENDING' | 'SESSION_CREATED' | 'COMPLETED';
  stripeCheckoutSessionId: string | null;
  checkoutUrl: string | null;
  expectedPreviousStripeSubscriptionId: string | null;
  expiresAt: Date;
};

type StripeSubscriptionSummary = {
  id: string;
  status: string;
};

type CheckoutHarnessOptions = {
  localSubscription?: LocalSubscription | null;
  remoteSubscriptions?: StripeSubscriptionSummary[];
  searchedCustomers?: Array<{ id: string }>;
  customerSearchHasMore?: boolean;
  storedCustomerId?: string | null;
  existingAttempt?: CheckoutAttempt | null;
  retrievedCheckoutSession?: {
    id: string;
    status: 'open' | 'complete' | 'expired';
    metadata: Record<string, string>;
  };
  expiredCheckoutSessionStatus?: 'open' | 'complete' | 'expired';
  completeDuringFinalization?: boolean;
  checkoutSessionCreate?: (args: unknown, requestOptions: unknown) => Promise<{ id: string; url: string }>;
};

function appErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function checkoutHarness(options: CheckoutHarnessOptions = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const localSubscription = options.localSubscription === undefined
    ? { stripeSubscriptionId: null, status: 'TRIALING' as const }
    : options.localSubscription;
  let storedCustomerId = options.storedCustomerId === undefined ? 'cus_org_1' : options.storedCustomerId;
  let attempt = options.existingAttempt ?? null;

  const subscription = {
    findUnique: async (args: unknown) => {
      calls.push({ name: 'subscription.findUnique', args });
      return localSubscription;
    },
  };

  const billingCheckoutAttempt = {
    findUnique: async (args: { where: { id?: string; organisationId?: string } }) => {
      calls.push({ name: 'billingCheckoutAttempt.findUnique', args });
      if (!attempt) return null;
      if (args.where.id && args.where.id !== attempt.id) return null;
      if (args.where.organisationId && args.where.organisationId !== attempt.organisationId) return null;
      return attempt;
    },
    create: async (args: { data: Omit<CheckoutAttempt, 'status' | 'stripeCheckoutSessionId' | 'checkoutUrl'> }) => {
      calls.push({ name: 'billingCheckoutAttempt.create', args });
      attempt = {
        ...args.data,
        status: 'PENDING',
        stripeCheckoutSessionId: null,
        checkoutUrl: null,
      };
      return attempt;
    },
    delete: async (args: { where: { id: string } }) => {
      calls.push({ name: 'billingCheckoutAttempt.delete', args });
      if (attempt?.id === args.where.id) attempt = null;
      return {};
    },
    updateMany: async (args: {
      where: { id: string; status: CheckoutAttempt['status'] };
      data: Partial<CheckoutAttempt>;
    }) => {
      calls.push({ name: 'billingCheckoutAttempt.updateMany', args });
      if (!attempt || attempt.id !== args.where.id || attempt.status !== args.where.status) {
        return { count: 0 };
      }
      if (options.completeDuringFinalization) {
        attempt = {
          ...attempt,
          status: 'COMPLETED',
          stripeCheckoutSessionId: 'cs_integrity_1',
          checkoutUrl: null,
        };
        return { count: 0 };
      }
      attempt = { ...attempt, ...args.data };
      return { count: 1 };
    },
  };

  const transactionModels = { subscription, billingCheckoutAttempt };
  const prisma = {
    organisation: {
      findUniqueOrThrow: async (args: unknown) => {
        calls.push({ name: 'organisation.findUniqueOrThrow', args });
        return {
          id: 'org_1',
          name: 'Governance Charity',
          contactEmail: 'owner@example.org',
          stripeCustomerId: storedCustomerId,
          subscription: localSubscription,
        };
      },
      update: async (args: { data: { stripeCustomerId: string } }) => {
        calls.push({ name: 'organisation.update', args });
        storedCustomerId = args.data.stripeCustomerId;
        return {};
      },
    },
    subscription,
    billingCheckoutAttempt,
    $transaction: async (
      callback: (tx: typeof transactionModels) => Promise<unknown>,
      transactionOptions: unknown,
    ) => {
      calls.push({ name: 'transaction.start', args: transactionOptions });
      return callback(transactionModels);
    },
  };

  const stripe = {
    customers: {
      retrieve: async (customerId: string) => {
        calls.push({ name: 'stripe.customers.retrieve', args: customerId });
        return { id: customerId, metadata: { organisationId: 'org_1' } };
      },
      search: async (args: unknown) => {
        calls.push({ name: 'stripe.customers.search', args });
        return {
          data: options.searchedCustomers ?? (storedCustomerId ? [{ id: storedCustomerId }] : []),
          has_more: options.customerSearchHasMore ?? false,
        };
      },
      create: async (args: unknown, requestOptions: unknown) => {
        calls.push({ name: 'stripe.customers.create', args: [args, requestOptions] });
        return { id: 'cus_created' };
      },
    },
    subscriptions: {
      retrieve: async (subscriptionId: string) => {
        calls.push({ name: 'stripe.subscriptions.retrieve', args: subscriptionId });
        const summary = options.remoteSubscriptions?.find((candidate) => candidate.id === subscriptionId);
        return {
          id: subscriptionId,
          customer: 'cus_org_1',
          status: summary?.status ?? 'canceled',
          current_period_start: 1_781_078_400,
          current_period_end: 1_783_670_400,
          canceled_at: summary?.status === 'canceled' ? 1_783_670_400 : null,
          cancel_at_period_end: false,
          trial_end: null,
          items: { data: [{ quantity: 1, price: { id: 'price_complete_monthly' } }] },
        };
      },
      list: async (args: unknown) => {
        calls.push({ name: 'stripe.subscriptions.list', args });
        return { data: options.remoteSubscriptions ?? [], has_more: false };
      },
    },
    checkout: {
      sessions: {
        retrieve: async (sessionId: string) => {
          calls.push({ name: 'stripe.checkout.sessions.retrieve', args: sessionId });
          return options.retrievedCheckoutSession ?? {
            id: sessionId,
            status: 'expired',
            metadata: {
              organisationId: 'org_1',
              checkoutAttemptId: attempt?.id ?? '',
            },
          };
        },
        expire: async (sessionId: string) => {
          calls.push({ name: 'stripe.checkout.sessions.expire', args: sessionId });
          return {
            id: sessionId,
            status: options.expiredCheckoutSessionStatus ?? 'expired',
          };
        },
        create: async (args: unknown, requestOptions: unknown) => {
          calls.push({ name: 'stripe.checkout.sessions.create', args: [args, requestOptions] });
          if (options.checkoutSessionCreate) {
            return options.checkoutSessionCreate(args, requestOptions);
          }
          return { id: 'cs_integrity_1', url: 'https://checkout.stripe.test/integrity' };
        },
      },
    },
  };

  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => stripe;

  return {
    service,
    calls,
    currentAttempt: () => attempt,
  };
}

test('checkout is blocked when Stripe reports any nonterminal subscription for the organisation customer', async () => {
  const { service, calls } = checkoutHarness({
    localSubscription: { stripeSubscriptionId: 'sub_active', status: 'ACTIVE' },
    remoteSubscriptions: [{ id: 'sub_active', status: 'active' }],
  });

  await assert.rejects(
    () => testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly'),
    (error: unknown) => appErrorCode(error) === 'STRIPE_SUBSCRIPTION_ALREADY_EXISTS',
  );

  assert.equal(calls.some((call) => call.name === 'billingCheckoutAttempt.create'), false);
  assert.equal(calls.some((call) => call.name === 'stripe.checkout.sessions.create'), false);
});

test('a local trial with no Stripe subscription can create one attempt-bound Checkout session', async () => {
  const { service, calls, currentAttempt } = checkoutHarness();

  const result = await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');

  assert.deepEqual(result, { url: 'https://checkout.stripe.test/integrity' });
  const attempt = currentAttempt();
  assert.ok(attempt);
  assert.equal(attempt.status, 'SESSION_CREATED');
  assert.equal(attempt.expectedPreviousStripeSubscriptionId, null);

  const checkoutCall = calls.find((call) => call.name === 'stripe.checkout.sessions.create');
  assert.ok(checkoutCall);
  const [sessionArgs, requestOptions] = checkoutCall.args as [
    { metadata: Record<string, string>; subscription_data: { metadata: Record<string, string> } },
    { idempotencyKey: string },
  ];
  assert.deepEqual(sessionArgs.metadata, {
    organisationId: 'org_1',
    plan: 'COMPLETE',
    interval: 'monthly',
    checkoutAttemptId: attempt.id,
  });
  assert.deepEqual(sessionArgs.subscription_data.metadata, {
    organisationId: 'org_1',
    checkoutAttemptId: attempt.id,
  });
  assert.equal(requestOptions.idempotencyKey, `charitypilot-checkout-${attempt.id}`);
});

test('Checkout creation accepts a matching webhook completion that wins the finalization race', async () => {
  const { service, calls, currentAttempt } = checkoutHarness({ completeDuringFinalization: true });

  const result = await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');

  assert.deepEqual(result, { url: 'https://checkout.stripe.test/integrity' });
  assert.equal(currentAttempt()?.status, 'COMPLETED');
  assert.equal(currentAttempt()?.stripeCheckoutSessionId, 'cs_integrity_1');
  assert.equal(calls.filter((call) => call.name === 'stripe.checkout.sessions.create').length, 1);
});

test('a cancelled Stripe subscription can restart only when the saved subscription is remotely terminal', async () => {
  const reconciled = checkoutHarness({
    localSubscription: { stripeSubscriptionId: 'sub_cancelled', status: 'CANCELLED' },
    remoteSubscriptions: [{ id: 'sub_cancelled', status: 'canceled' }],
  });

  await testOnlyCheckout(reconciled.service)('org_1', SubscriptionPlan.COMPLETE, 'yearly');
  assert.equal(reconciled.currentAttempt()?.expectedPreviousStripeSubscriptionId, 'sub_cancelled');
  assert.equal(reconciled.calls.some((call) => call.name === 'stripe.checkout.sessions.create'), true);

  const unreconciled = checkoutHarness({
    localSubscription: { stripeSubscriptionId: 'sub_missing', status: 'CANCELLED' },
    remoteSubscriptions: [{ id: 'sub_other', status: 'canceled' }],
  });

  await assert.rejects(
    () => testOnlyCheckout(unreconciled.service)('org_1', SubscriptionPlan.COMPLETE, 'yearly'),
    (error: unknown) => appErrorCode(error) === 'BILLING_ACCOUNT_REVIEW_REQUIRED',
  );
  assert.equal(unreconciled.calls.some((call) => call.name === 'stripe.checkout.sessions.create'), false);
});

test('multiple Stripe customers for one organisation require review before checkout', async () => {
  const { service, calls } = checkoutHarness({
    storedCustomerId: null,
    searchedCustomers: [{ id: 'cus_first' }, { id: 'cus_second' }],
  });

  await assert.rejects(
    () => testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly'),
    (error: unknown) => appErrorCode(error) === 'BILLING_ACCOUNT_REVIEW_REQUIRED',
  );

  assert.equal(calls.some((call) => call.name === 'stripe.subscriptions.list'), false);
  assert.equal(calls.some((call) => call.name === 'stripe.checkout.sessions.create'), false);
});

test('a saved Stripe subscription recovers its verified customer before any new customer is created', async () => {
  const { service, calls } = checkoutHarness({
    storedCustomerId: null,
    searchedCustomers: [],
    localSubscription: { stripeSubscriptionId: 'sub_cancelled', status: 'CANCELLED' },
    remoteSubscriptions: [{ id: 'sub_cancelled', status: 'canceled' }],
  });

  await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');

  assert.equal(calls.some((call) => call.name === 'stripe.subscriptions.retrieve'), true);
  assert.equal(calls.some((call) => call.name === 'stripe.customers.create'), false);
  const remembered = calls.find((call) => call.name === 'organisation.update');
  assert.ok(remembered);
  assert.equal(
    (remembered.args as { data: { stripeCustomerId: string } }).data.stripeCustomerId,
    'cus_org_1',
  );
});

test('a live Checkout attempt reuses one Stripe session and rejects a conflicting plan', async () => {
  const { service, calls } = checkoutHarness();

  const first = await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');
  const retried = await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');

  assert.deepEqual(retried, first);
  assert.equal(
    calls.filter((call) => call.name === 'stripe.checkout.sessions.create').length,
    1,
    'retries must reuse the active attempt instead of creating another Stripe subscription Checkout',
  );

  await assert.rejects(
    () => testOnlyCheckout(service)('org_1', SubscriptionPlan.ESSENTIALS, 'monthly'),
    (error: unknown) => appErrorCode(error) === 'CHECKOUT_ALREADY_PENDING',
  );
  assert.equal(calls.filter((call) => call.name === 'stripe.checkout.sessions.create').length, 1);
});

test('concurrent Checkout requests share one attempt-bound Stripe idempotency key', async () => {
  let releaseStripe!: () => void;
  let markStripeStarted!: () => void;
  let markBothStripeCallsStarted!: () => void;
  let stripeCallCount = 0;
  const stripeStartedPromise = new Promise<void>((resolve) => {
    markStripeStarted = resolve;
  });
  const bothStripeCallsStartedPromise = new Promise<void>((resolve) => {
    markBothStripeCallsStarted = resolve;
  });
  const stripeReleasePromise = new Promise<void>((resolve) => {
    releaseStripe = resolve;
  });
  const harness = checkoutHarness({
    checkoutSessionCreate: async () => {
      stripeCallCount += 1;
      if (stripeCallCount === 1) {
        markStripeStarted();
      }
      if (stripeCallCount === 2) {
        markBothStripeCallsStarted();
      }
      await stripeReleasePromise;
      return { id: 'cs_concurrent', url: 'https://checkout.stripe.test/concurrent' };
    },
  });

  const first = testOnlyCheckout(harness.service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');
  await stripeStartedPromise;
  const second = testOnlyCheckout(harness.service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');
  await bothStripeCallsStartedPromise;
  releaseStripe();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  const checkoutCalls = harness.calls.filter((call) => call.name === 'stripe.checkout.sessions.create');
  assert.equal(checkoutCalls.length, 2, 'both requests may reach Stripe while the first response is pending');
  const idempotencyKeys = checkoutCalls.map((call) => (
    (call.args as [unknown, { idempotencyKey: string }])[1].idempotencyKey
  ));
  assert.equal(new Set(idempotencyKeys).size, 1, 'concurrent requests must use the same Stripe idempotency key');
});

test('an expired open Checkout is expired at Stripe before a replacement attempt is created', async () => {
  const oldAttempt: CheckoutAttempt = {
    id: 'attempt_expired',
    organisationId: 'org_1',
    requestedPlan: 'COMPLETE',
    interval: 'monthly',
    status: 'SESSION_CREATED',
    stripeCheckoutSessionId: 'cs_expired_open',
    checkoutUrl: 'https://checkout.stripe.test/old',
    expectedPreviousStripeSubscriptionId: null,
    expiresAt: new Date(Date.now() - 60_000),
  };
  const { service, calls, currentAttempt } = checkoutHarness({
    existingAttempt: oldAttempt,
    retrievedCheckoutSession: {
      id: 'cs_expired_open',
      status: 'open',
      metadata: {
        organisationId: 'org_1',
        checkoutAttemptId: 'attempt_expired',
      },
    },
  });

  await testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly');

  const expireIndex = calls.findIndex((call) => call.name === 'stripe.checkout.sessions.expire');
  const deleteIndex = calls.findIndex((call) => call.name === 'billingCheckoutAttempt.delete');
  const createIndex = calls.findIndex((call) => call.name === 'stripe.checkout.sessions.create');
  assert.ok(expireIndex >= 0, 'the old open Checkout must be expired at Stripe');
  assert.ok(deleteIndex > expireIndex, 'the old attempt must not be replaced until Stripe confirms expiry');
  assert.ok(createIndex > deleteIndex, 'the new Checkout must be created only after the expired attempt is replaced');
  assert.notEqual(currentAttempt()?.id, oldAttempt.id);
});

test('an expired attempt whose Stripe Checkout completed blocks replacement pending webhook reconciliation', async () => {
  const completedAttempt: CheckoutAttempt = {
    id: 'attempt_completed_remote',
    organisationId: 'org_1',
    requestedPlan: 'COMPLETE',
    interval: 'monthly',
    status: 'SESSION_CREATED',
    stripeCheckoutSessionId: 'cs_completed_remote',
    checkoutUrl: 'https://checkout.stripe.test/completed',
    expectedPreviousStripeSubscriptionId: null,
    expiresAt: new Date(Date.now() - 60_000),
  };
  const { service, calls } = checkoutHarness({
    existingAttempt: completedAttempt,
    retrievedCheckoutSession: {
      id: 'cs_completed_remote',
      status: 'complete',
      metadata: {
        organisationId: 'org_1',
        checkoutAttemptId: 'attempt_completed_remote',
      },
    },
  });

  await assert.rejects(
    () => testOnlyCheckout(service)('org_1', SubscriptionPlan.COMPLETE, 'monthly'),
    (error: unknown) => appErrorCode(error) === 'BILLING_ACCOUNT_REVIEW_REQUIRED',
  );

  assert.equal(calls.some((call) => call.name === 'billingCheckoutAttempt.delete'), false);
  assert.equal(calls.some((call) => call.name === 'stripe.subscriptions.list'), false);
  assert.equal(calls.some((call) => call.name === 'stripe.checkout.sessions.create'), false);
});

test('billing status offers Checkout only after the Stripe-managed subscription is terminal', async () => {
  let subscription = {
    stripeSubscriptionId: 'sub_active',
    plan: 'COMPLETE',
    status: 'ACTIVE',
    stripeStatus: 'active' as string | null,
    billingInterval: 'monthly',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
  };
  const service = new BillingService({
    organisation: {
      findUnique: async () => ({ stripeCustomerId: 'cus_org_1' }),
    },
    subscription: {
      findUnique: async () => subscription,
    },
    billingAuthorityGrant: {
      findFirst: async () => null,
    },
  } as never);

  const activeStatus = await service.getStatus('org_1', { id: 'u1', sessionId: 'sess-1', role: 'OWNER' });

  assert.equal(activeStatus.billingConfigured, true);
  assert.equal(activeStatus.canStartCheckout, false);
  assert.equal(activeStatus.canOpenPortal, true);

  subscription = {
    ...subscription,
    status: 'CANCELLED',
    stripeStatus: null,
    currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
  };
  const unverifiedTerminalStatus = await service.getStatus('org_1', { id: 'u1', sessionId: 'sess-1', role: 'OWNER' });
  assert.equal(
    unverifiedTerminalStatus.canStartCheckout,
    false,
    'a local cancelled state is insufficient without a persisted terminal Stripe status',
  );

  subscription = {
    ...subscription,
    stripeStatus: 'canceled',
  };
  const terminalStatus = await service.getStatus('org_1', { id: 'u1', sessionId: 'sess-1', role: 'OWNER' });

  assert.equal(terminalStatus.canStartCheckout, true);
  assert.equal(terminalStatus.canOpenPortal, true);
  assert.equal(terminalStatus.stripeStatus, 'canceled');
  assert.equal(terminalStatus.billingInterval, 'monthly');
});

type WebhookHarnessOptions = {
  checkoutAttempt: CheckoutAttempt | null;
  remoteSubscriptions?: StripeSubscriptionSummary[];
  retrievedSubscriptionOverrides?: Record<string, unknown>;
};

function webhookHarness(options: WebhookHarnessOptions) {
  const calls: string[] = [];
  const currentSubscription = {
    stripeSubscriptionId: 'sub_current',
    status: 'CANCELLED',
  };
  const tx = {
    stripeWebhookEvent: {
      create: async () => {
        calls.push('stripeWebhookEvent.create');
        return {};
      },
    },
    organisation: {
      findUnique: async () => ({ id: 'org_1', stripeCustomerId: 'cus_org_1' }),
    },
    billingCheckoutAttempt: {
      findUnique: async () => options.checkoutAttempt,
      update: async () => {
        calls.push('billingCheckoutAttempt.update');
        return {};
      },
    },
    subscription: {
      findUnique: async () => currentSubscription,
      upsert: async () => {
        calls.push('subscription.upsert');
        return {};
      },
    },
  };
  const prisma = {
    stripeWebhookEvent: { findUnique: async () => null },
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => ({
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_stale_checkout',
        customer: 'cus_org_1',
        status: 'active',
        current_period_start: 1_781_078_400,
        current_period_end: 1_783_670_400,
        canceled_at: null,
        cancel_at_period_end: false,
        trial_end: null,
        items: { data: [{ quantity: 1, price: { id: 'price_complete_monthly' } }] },
        ...options.retrievedSubscriptionOverrides,
      }),
      list: async () => {
        calls.push('stripe.subscriptions.list');
        return {
          data: options.remoteSubscriptions ?? [{ id: 'sub_stale_checkout', status: 'active' }],
          has_more: false,
        };
      },
    },
  });
  return { service, calls };
}

function staleCheckoutWebhook() {
  return {
    id: 'evt_stale_checkout',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_stale_checkout',
        customer: 'cus_org_1',
        subscription: 'sub_stale_checkout',
        metadata: {
          organisationId: 'org_1',
          plan: 'COMPLETE',
          interval: 'monthly',
          checkoutAttemptId: 'attempt_stale',
        },
      },
    },
  } as never;
}

test('unknown and superseded Checkout webhooks cannot overwrite the current subscription', async () => {
  for (const checkoutAttempt of [
    null,
    {
      id: 'attempt_current',
      organisationId: 'org_1',
      requestedPlan: 'COMPLETE' as const,
      interval: 'monthly' as const,
      status: 'SESSION_CREATED' as const,
      stripeCheckoutSessionId: 'cs_current',
      checkoutUrl: 'https://checkout.stripe.test/current',
      expectedPreviousStripeSubscriptionId: 'sub_current',
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]) {
    const { service, calls } = webhookHarness({ checkoutAttempt });

    await assert.rejects(
      () => service.handleWebhook(staleCheckoutWebhook()),
      (error: unknown) => appErrorCode(error) === 'STRIPE_WEBHOOK_MISMATCH',
    );

    assert.equal(calls.includes('subscription.upsert'), false);
    assert.equal(calls.includes('billingCheckoutAttempt.update'), false);
  }
});

test('Checkout webhook refuses to reconcile when Stripe reports another nonterminal subscription', async () => {
  const matchingAttempt: CheckoutAttempt = {
    id: 'attempt_stale',
    organisationId: 'org_1',
    requestedPlan: 'COMPLETE',
    interval: 'monthly',
    status: 'SESSION_CREATED',
    stripeCheckoutSessionId: 'cs_stale_checkout',
    checkoutUrl: 'https://checkout.stripe.test/stale',
    expectedPreviousStripeSubscriptionId: 'sub_current',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const { service, calls } = webhookHarness({
    checkoutAttempt: matchingAttempt,
    remoteSubscriptions: [
      { id: 'sub_stale_checkout', status: 'active' },
      { id: 'sub_other_active', status: 'trialing' },
    ],
  });

  await assert.rejects(
    () => service.handleWebhook(staleCheckoutWebhook()),
    (error: unknown) => appErrorCode(error) === 'STRIPE_SUBSCRIPTION_ALREADY_EXISTS',
  );

  assert.equal(calls.includes('stripe.subscriptions.list'), true);
  assert.equal(calls.includes('stripeWebhookEvent.create'), false, 'uniqueness must be checked before the event transaction');
  assert.equal(calls.includes('subscription.upsert'), false);
});

test('Checkout webhook rejects subscription quantities that do not match the configured single-plan contract', async () => {
  const { service, calls } = webhookHarness({
    checkoutAttempt: {
      id: 'attempt_stale',
      organisationId: 'org_1',
      requestedPlan: 'COMPLETE',
      interval: 'monthly',
      status: 'SESSION_CREATED',
      stripeCheckoutSessionId: 'cs_stale_checkout',
      checkoutUrl: 'https://checkout.stripe.test/stale',
      expectedPreviousStripeSubscriptionId: 'sub_current',
      expiresAt: new Date(Date.now() + 60_000),
    },
    retrievedSubscriptionOverrides: {
      items: { data: [{ quantity: 2, price: { id: 'price_complete_monthly' } }] },
    },
  });

  await assert.rejects(
    () => service.handleWebhook(staleCheckoutWebhook()),
    (error: unknown) => appErrorCode(error) === 'STRIPE_WEBHOOK_MISMATCH',
  );

  assert.equal(calls.includes('subscription.upsert'), false);
  assert.equal(calls.includes('billingCheckoutAttempt.update'), false);
});
