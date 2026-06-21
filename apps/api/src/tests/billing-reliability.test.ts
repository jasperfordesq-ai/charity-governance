import assert from 'node:assert/strict';
import { test } from 'node:test';

// Stripe + JWT env are read by BillingService at *call* time (isConfigured/getStripe/
// getPriceId) and by jwt.ts at *import* time. Set a fully-configured baseline before any
// dynamic import; individual tests that prove the unconfigured/degraded paths mutate a
// single var and restore it in a finally block.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'billing-reliability-test-secret';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_billing_reliability';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_billing_reliability';
process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID ?? 'price_essentials_monthly';
process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID =
  process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID ?? 'price_essentials_yearly';
process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID ?? 'price_complete_monthly';
process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID =
  process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID ?? 'price_complete_yearly';
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://app.example.org';

const [{ default: Fastify }, { billingRoutes }, { BillingService }, { signAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/billing/index.js'),
  import('../services/billing.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

function activeSubscription() {
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000), plan: 'COMPLETE' };
}

function authModels(role: Role, subscription: unknown) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => subscription },
  };
}

async function buildApp(prismaOverrides: Record<string, unknown>, role: Role = 'OWNER', subscription: unknown = activeSubscription()) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', { ...authModels(role, subscription), ...prismaOverrides } as never);
  await app.register(billingRoutes, { prefix: '/billing' });
  return app;
}

// ── billing-input-validation-6 ──

test('POST /checkout with an invalid plan returns 400 VALIDATION_ERROR and never calls Stripe', async () => {
  let orgLookups = 0;
  const app = await buildApp({
    organisation: {
      findUniqueOrThrow: async () => {
        orgLookups += 1;
        return { id: 'org-1', name: 'Org', contactEmail: 'o@example.org', stripeCustomerId: 'cus_org_1' };
      },
    },
  });

  try {
    // Unsupported plan: createCheckoutSchema only accepts ESSENTIALS|COMPLETE.
    const invalidPlan = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { authorization: tokenFor('OWNER') },
      payload: { plan: 'PRO', interval: 'monthly' },
    });
    assert.equal(invalidPlan.statusCode, 400);
    assert.equal(invalidPlan.json().code, 'VALIDATION_ERROR');

    // Unsupported interval: schema only accepts monthly|yearly.
    const invalidInterval = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { authorization: tokenFor('OWNER') },
      payload: { plan: 'COMPLETE', interval: 'weekly' },
    });
    assert.equal(invalidInterval.statusCode, 400);
    assert.equal(invalidInterval.json().code, 'VALIDATION_ERROR');

    // Zod rejects before the handler reaches the BillingService / Stripe.
    assert.equal(orgLookups, 0, 'a malformed checkout body must not reach organisation.findUniqueOrThrow');
  } finally {
    await app.close();
  }
});

// ── billing-authz-boundary-8 + billing-authz-boundary-9 (shared proposedTitle) ──

test('checkout and portal require OWNER (MEMBER and ADMIN are rejected with FORBIDDEN)', async () => {
  for (const role of ['MEMBER', 'ADMIN'] as const) {
    let stripeReached = false;
    const app = await buildApp(
      {
        organisation: {
          findUniqueOrThrow: async () => {
            stripeReached = true;
            return { id: 'org-1', name: 'Org', contactEmail: 'o@example.org', stripeCustomerId: 'cus_org_1' };
          },
        },
      },
      role,
    );

    try {
      for (const url of ['/billing/checkout', '/billing/create-checkout']) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: tokenFor(role) },
          payload: { plan: 'COMPLETE', interval: 'monthly' },
        });
        assert.equal(res.statusCode, 403, `${role} must not POST ${url}`);
        assert.equal(res.json().code, 'FORBIDDEN');
      }

      for (const url of ['/billing/portal', '/billing/create-portal']) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: tokenFor(role) },
          payload: {},
        });
        assert.equal(res.statusCode, 403, `${role} must not POST ${url}`);
        assert.equal(res.json().code, 'FORBIDDEN');
      }

      assert.equal(stripeReached, false, `requireOwner must block ${role} before the BillingService runs`);
    } finally {
      await app.close();
    }
  }
});

// ── billing-authz-boundary-10 ──

test('authed billing routes reject unauthenticated requests with 401', async () => {
  let serviceReached = false;
  const sentinel = async () => {
    serviceReached = true;
    return { id: 'org-1', name: 'Org', contactEmail: 'o@example.org', stripeCustomerId: 'cus_org_1' };
  };
  const app = await buildApp({
    organisation: { findUniqueOrThrow: sentinel },
    // getStatus uses subscription.findUnique; flag it too so we prove the guard ran first.
    subscription: {
      findUnique: async () => {
        serviceReached = true;
        return null;
      },
    },
  });

  try {
    for (const route of [
      { method: 'POST' as const, url: '/billing/checkout', payload: { plan: 'COMPLETE', interval: 'monthly' } },
      { method: 'POST' as const, url: '/billing/create-checkout', payload: { plan: 'COMPLETE', interval: 'monthly' } },
      { method: 'POST' as const, url: '/billing/portal', payload: {} },
      { method: 'POST' as const, url: '/billing/create-portal', payload: {} },
      { method: 'GET' as const, url: '/billing/status' },
    ]) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} must require auth`);
      assert.equal(res.json().code, 'UNAUTHORIZED');
    }

    assert.equal(serviceReached, false, 'authGuard must reject before any BillingService query runs');
  } finally {
    await app.close();
  }
});

// ── billing-tenant-isolation-11 ──

test('GET /status scopes the subscription lookup to the caller\'s organisation', async () => {
  let recordedWhere: { organisationId?: string } | undefined;
  const app = await buildApp({
    subscription: {
      // authModels uses subscription.findUnique for the guard; override to also record
      // the where arg used by getStatus. Both callers key by organisationId, and the
      // guard's lookup returns an access-granting ACTIVE row.
      findUnique: async (args: { where?: { organisationId?: string } }) => {
        recordedWhere = args?.where;
        return activeSubscription();
      },
    },
  });

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/billing/status',
      headers: { authorization: tokenFor('OWNER') },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(recordedWhere, 'getStatus must query subscription.findUnique with a where clause');
    // The lookup is keyed by the authenticated token org ('org-1'), never a client id.
    assert.equal(recordedWhere?.organisationId, 'org-1');
  } finally {
    await app.close();
  }
});

// ── billing-tenant-isolation-13 (service level) ──

test('subscription.updated and .deleted reject a customer that does not own the local subscription and ignore unknown subscription ids', async () => {
  function harness(existingSubscription: Record<string, unknown> | null) {
    const calls: Array<{ name: string; args: unknown }> = [];
    const prisma = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
      stripeWebhookEvent: {
        findUnique: async () => null,
        create: async () => ({}),
      },
      subscription: {
        findUnique: async (args: unknown) => {
          calls.push({ name: 'subscription.findUnique', args });
          return existingSubscription;
        },
        update: async (args: unknown) => {
          calls.push({ name: 'subscription.update', args });
          return args;
        },
      },
    };
    const service = new BillingService(prisma as never);
    // handleWebhook calls getStripe() unconditionally; a non-checkout event never uses it,
    // but stub it so the configured/unconfigured env state is irrelevant to this test.
    (service as unknown as { getStripe: () => unknown }).getStripe = () => ({});
    return { service, calls };
  }

  function stripeSub(overrides: Record<string, unknown> = {}) {
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

  // (a) customer mismatch on the updated path -> STRIPE_WEBHOOK_MISMATCH, no write.
  {
    const { service, calls } = harness({
      id: 'sub_db_1',
      organisation: { stripeCustomerId: 'cus_org_1' },
    });
    await assert.rejects(
      () =>
        service.handleWebhook({
          id: 'evt_updated_mismatch',
          type: 'customer.subscription.updated',
          data: { object: stripeSub({ customer: 'cus_attacker' }) },
        } as never),
      /does not match/i,
    );
    assert.equal(calls.some((c) => c.name === 'subscription.update'), false, 'mismatched updated event must not write');
  }

  // (a') customer mismatch on the deleted path -> STRIPE_WEBHOOK_MISMATCH, no write.
  {
    const { service, calls } = harness({
      id: 'sub_db_1',
      organisation: { stripeCustomerId: 'cus_org_1' },
    });
    await assert.rejects(
      () =>
        service.handleWebhook({
          id: 'evt_deleted_mismatch',
          type: 'customer.subscription.deleted',
          data: { object: stripeSub({ customer: 'cus_attacker' }) },
        } as never),
      /does not match/i,
    );
    assert.equal(calls.some((c) => c.name === 'subscription.update'), false, 'mismatched deleted event must not write');
  }

  // (b) unknown stripeSubscriptionId (existing === null) -> resolves, no write.
  {
    const { service, calls } = harness(null);
    await service.handleWebhook({
      id: 'evt_updated_unknown',
      type: 'customer.subscription.updated',
      data: { object: stripeSub({ id: 'sub_unknown' }) },
    } as never);
    assert.equal(calls.some((c) => c.name === 'subscription.update'), false, 'unknown subscription id must not write');
  }
});

// ── billing-graceful-degradation-14 ──

test('checkout returns 503 BILLING_NOT_CONFIGURED when Stripe is unconfigured', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  let stripeCalls = 0;
  const app = await buildApp({
    organisation: {
      // createCheckoutSession looks up the org first, THEN constructs Stripe; the org
      // lookup may run, but no Stripe network call must occur before the 503 throw.
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: 'Org',
        contactEmail: 'o@example.org',
        stripeCustomerId: 'cus_org_1',
      }),
      update: async () => {
        stripeCalls += 1;
        return undefined;
      },
    },
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { authorization: tokenFor('OWNER') },
      payload: { plan: 'COMPLETE', interval: 'monthly' },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'BILLING_NOT_CONFIGURED');
    assert.equal(stripeCalls, 0, 'no Stripe customer mutation may occur when billing is unconfigured');
  } finally {
    await app.close();
    if (previousSecret === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = previousSecret;
    }
  }
});

// ── billing-graceful-degradation-15 ──

test('billing status reports billingConfigured:false without erroring when Stripe is unconfigured', async () => {
  const previousPrice = process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;
  delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;

  const prisma = {
    subscription: {
      findUnique: async () => null,
    },
  };
  const service = new BillingService(prisma as never);

  try {
    const status = await service.getStatus('org_1');

    assert.deepEqual(status, {
      plan: null,
      status: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      hasAccess: false,
      billingConfigured: false,
    });
  } finally {
    if (previousPrice === undefined) {
      delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;
    } else {
      process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = previousPrice;
    }
  }
});

// ── billing-observability-16 ──

test('isConfigured returns false when any required Stripe price id is missing', async () => {
  const service = new BillingService({} as never);

  const previousPrice = process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;

  try {
    // Baseline: secret + webhook + all four price ids are configured.
    assert.equal(service.isConfigured(), true);

    // Removing a single required price id flips the readiness signal to false.
    delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;
    assert.equal(service.isConfigured(), false);
  } finally {
    if (previousPrice === undefined) {
      delete process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID;
    } else {
      process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID = previousPrice;
    }
  }
});
