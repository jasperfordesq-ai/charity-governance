import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_billing_authority_claimant';
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_billing_authority_claimant';
process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID ??= 'bpc_billing_authority_claimant';
process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID ??= 'price_essentials_monthly';
process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID ??= 'price_essentials_yearly';
process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID ??= 'price_complete_monthly';
process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID ??= 'price_complete_yearly';
process.env.FRONTEND_URL ??= 'https://app.example.org';

const [{ BillingService }, { SubscriptionPlan }, { assertBillingAuthorityAllowsOwnershipChange }] =
  await Promise.all([
    import('../services/billing.service.js'),
    import('@charitypilot/shared'),
    import('../services/billing-authority-interlock.js'),
  ]);

type Grant = {
  id: string;
  organisationId: string;
  kind: 'CHECKOUT' | 'PORTAL';
  actorUserId: string;
  actorSessionId: string;
  actorMembershipVersion: number;
  state: 'CLAIMED' | 'PROVIDER_STARTED' | 'CAPABILITY_ISSUED' | 'RELEASED';
  providerResourceId: string | null;
  safeReleaseAfter: Date | null;
  claimedAt: Date;
  providerStartedAt: Date | null;
  capabilityIssuedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  releaseActor: string | null;
  releaseEvidence: Record<string, unknown> | null;
};

type Attempt = {
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

type HarnessOptions = {
  organisationStatus?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  actorAvailable?: boolean;
  sessionAvailable?: boolean;
  failAt?: 'customer-retrieve' | 'checkout-create' | 'portal-create' | 'portal-before-create';
  failCapabilityFinalization?: boolean;
  webhookDuringCheckoutCreate?: boolean;
  revokeSessionAfterProviderCreate?: boolean;
  pausePortalCreate?: boolean;
  grantClaimedAt?: Date;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function claimantHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const rawQueries: string[] = [];
  const checkoutRequestOptions: Array<Record<string, unknown>> = [];
  const checkoutParams: Array<Record<string, unknown>> = [];
  let transactionDepth = 0;
  let grant: Grant | null = null;
  let attempt: Attempt | null = null;
  let localSubscription: Record<string, unknown> | null = null;
  let webhookProcessed = false;
  let webhookSubscriptionResolved = false;
  let failCapabilityFinalization = options.failCapabilityFinalization ?? false;
  let failAt = options.failAt;
  let sessionAvailable = options.sessionAvailable !== false;
  let service: InstanceType<typeof BillingService>;
  let markPortalCreateEntered: (() => void) | undefined;
  let releasePausedPortalCreate: (() => void) | undefined;
  const portalCreateEntered = new Promise<void>((resolve) => {
    markPortalCreateEntered = resolve;
  });
  const pausedPortalCreateReleased = new Promise<void>((resolve) => {
    releasePausedPortalCreate = resolve;
  });

  const authorityGrant = {
    create: async ({ data }: { data: Omit<Grant, 'id' | 'state' | 'providerResourceId' | 'safeReleaseAfter' | 'claimedAt' | 'providerStartedAt' | 'capabilityIssuedAt' | 'releasedAt' | 'releaseReason' | 'releaseActor' | 'releaseEvidence'> }) => {
      const now = options.grantClaimedAt ?? new Date();
      grant = {
        id: '00000000-0000-4000-8000-000000000801',
        ...data,
        state: 'CLAIMED',
        providerResourceId: null,
        safeReleaseAfter: null,
        claimedAt: now,
        providerStartedAt: null,
        capabilityIssuedAt: null,
        releasedAt: null,
        releaseReason: null,
        releaseActor: null,
        releaseEvidence: null,
      };
      events.push('grant:claimed');
      return grant;
    },
    findUnique: async ({ where }: { where: { id: string } }) => (
      grant?.id === where.id ? grant : null
    ),
    findFirst: async () => (grant?.state === 'RELEASED' ? null : grant),
    updateMany: async ({ data }: { where: Record<string, unknown>; data: Partial<Grant> }) => {
      if (!grant) return { count: 0 };
      if (data.state === 'CAPABILITY_ISSUED' && failCapabilityFinalization) {
        events.push('grant:issue-finalization-failed');
        return { count: 0 };
      }
      if (data.state === 'PROVIDER_STARTED' && grant.state !== 'CLAIMED') return { count: 0 };
      if (data.state === 'CAPABILITY_ISSUED' && grant.state !== 'PROVIDER_STARTED') return { count: 0 };
      if (data.state === 'RELEASED' && grant.state === 'RELEASED') return { count: 0 };
      grant = { ...grant, ...data } as Grant;
      events.push(`grant:${String(data.state).toLowerCase()}`);
      return { count: 1 };
    },
  };

  const checkoutAttempt = {
    findUnique: async ({ where }: { where: { id?: string; organisationId?: string } }) => {
      if (!attempt) return null;
      if (where.id && where.id !== attempt.id) return null;
      if (where.organisationId && where.organisationId !== attempt.organisationId) return null;
      return attempt;
    },
    create: async ({ data }: { data: Omit<Attempt, 'status' | 'stripeCheckoutSessionId' | 'checkoutUrl'> }) => {
      attempt = {
        ...data,
        status: 'PENDING',
        stripeCheckoutSessionId: null,
        checkoutUrl: null,
      };
      events.push('attempt:claimed');
      return attempt;
    },
    delete: async () => {
      attempt = null;
      return {};
    },
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Attempt> }) => {
      if (!attempt || attempt.id !== where.id || attempt.status !== where.status) return { count: 0 };
      attempt = { ...attempt, ...data };
      events.push(`attempt:${String(data.status).toLowerCase()}`);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Attempt> }) => {
      if (!attempt || attempt.id !== where.id) throw new Error('attempt missing');
      attempt = { ...attempt, ...data };
      events.push(`attempt:${String(data.status).toLowerCase()}`);
      return attempt;
    },
  };

  const subscription = {
    findUnique: async () => localSubscription,
    upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      localSubscription = localSubscription ? { ...localSubscription, ...update } : create;
      events.push('subscription:upserted');
      return localSubscription;
    },
  };

  const organisation = {
    findUniqueOrThrow: async () => ({
      id: 'org-1',
      name: 'Authority Charity',
      contactEmail: 'owner@example.org',
      stripeCustomerId: 'cus_authority',
      subscription: localSubscription,
    }),
    findUnique: async () => ({ id: 'org-1', stripeCustomerId: 'cus_authority' }),
    update: async () => ({}),
  };

  const stripeWebhookEvent = {
    findUnique: async () => (webhookProcessed ? { id: 'evt-authority' } : null),
    create: async () => {
      webhookProcessed = true;
      events.push('webhook:recorded');
      return {};
    },
  };

  const transactionModels = {
    organisation,
    subscription,
    billingCheckoutAttempt: checkoutAttempt,
    billingAuthorityGrant: authorityGrant,
    stripeWebhookEvent,
  };

  const prisma = {
    ...transactionModels,
    $transaction: async (
      callback: (tx: typeof transactionModels & { $queryRaw: (query: unknown) => Promise<unknown[]> }) => Promise<unknown>,
      transactionOptions?: unknown,
    ) => {
      events.push('transaction:start');
      transactionDepth += 1;
      let rawCall = 0;
      const tx = {
        ...transactionModels,
        $queryRaw: async (query: unknown) => {
          rawCall += 1;
          const rawSql =
            Array.isArray(query)
              ? (query as string[]).join('?')
              : ((query as { sql?: string })?.sql ?? '');
          rawQueries.push(rawSql);
          if (rawCall === 1) {
            return [{ id: 'org-1', lifecycleStatus: options.organisationStatus ?? 'ACTIVE' }];
          }
          if (rawCall === 2) {
            if (rawSql.includes('WHERE "id" =')) return grant ? [grant] : [];
            return grant?.state === 'RELEASED' || !grant ? [] : [grant];
          }
          if (rawCall === 3) {
            return options.actorAvailable === false
              ? []
              : [{
                  id: 'owner-1',
                  organisationId: 'org-1',
                  role: 'OWNER',
                  lifecycleStatus: 'ACTIVE',
                  membershipVersion: 7,
                }];
          }
          return sessionAvailable ? [{ id: 'session-owner-1' }] : [];
        },
      };
      try {
        return await callback(tx);
      } finally {
        transactionDepth -= 1;
        events.push(`transaction:end:${JSON.stringify(transactionOptions ?? null)}`);
      }
    },
  };

  const subscriptionObject = () => ({
    id: 'sub_authority',
    customer: 'cus_authority',
    status: 'active',
    current_period_start: 1_783_670_400,
    current_period_end: 1_786_262_400,
    canceled_at: null,
    cancel_at_period_end: false,
    trial_end: null,
    items: { data: [{ quantity: 1, price: { id: 'price_complete_monthly' } }] },
  });

  const checkoutEvent = () => {
    if (!attempt || !grant) throw new Error('checkout event requires an attempt and grant');
    return {
      id: 'evt-authority',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_authority',
          customer: 'cus_authority',
          subscription: 'sub_authority',
          status: 'complete',
          created: 1_783_670_400,
          expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
          metadata: {
            organisationId: 'org-1',
            plan: 'COMPLETE',
            interval: 'monthly',
            checkoutAttemptId: attempt.id,
            billingAuthorityGrantId: grant.id,
          },
        },
      },
    };
  };

  const assertOutsideTransaction = (operation: string) => {
    assert.equal(transactionDepth, 0, `${operation} must run after the short authority transaction commits`);
    events.push(operation);
  };

  const stripe = {
    customers: {
      retrieve: async () => {
        assertOutsideTransaction('stripe:customer-retrieve');
        if (failAt === 'customer-retrieve') throw new Error('provider unavailable before capability');
        return { id: 'cus_authority', metadata: { organisationId: 'org-1' } };
      },
      search: async () => {
        assertOutsideTransaction('stripe:customer-search');
        if (failAt === 'portal-before-create') return { data: [], has_more: false };
        return { data: [{ id: 'cus_authority' }], has_more: false };
      },
      create: async () => {
        assertOutsideTransaction('stripe:customer-create');
        return { id: 'cus_authority' };
      },
    },
    subscriptions: {
      list: async () => {
        assertOutsideTransaction('stripe:subscription-list');
        return {
          data: webhookSubscriptionResolved ? [subscriptionObject()] : [],
          has_more: false,
        };
      },
      retrieve: async () => {
        assertOutsideTransaction('stripe:subscription-retrieve');
        webhookSubscriptionResolved = true;
        return subscriptionObject();
      },
    },
    checkout: {
      sessions: {
        retrieve: async () => ({ id: 'cs_authority', status: 'expired', metadata: {} }),
        expire: async () => ({ id: 'cs_authority', status: 'expired' }),
        create: async (params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
          assertOutsideTransaction('stripe:checkout-create');
          checkoutParams.push(params);
          checkoutRequestOptions.push(requestOptions);
          if (failAt === 'checkout-create') throw new Error('ambiguous checkout create failure');
          if (options.webhookDuringCheckoutCreate) {
            await service.handleWebhook(checkoutEvent() as never);
          }
          if (options.revokeSessionAfterProviderCreate) sessionAvailable = false;
          return { id: 'cs_authority', url: 'https://checkout.stripe.test/authority' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async () => {
          assertOutsideTransaction('stripe:portal-create');
          if (options.pausePortalCreate) {
            markPortalCreateEntered?.();
            await pausedPortalCreateReleased;
          }
          if (failAt === 'portal-create') throw new Error('ambiguous portal create failure');
          if (options.revokeSessionAfterProviderCreate) sessionAvailable = false;
          return { id: 'bps_authority', url: 'https://billing.stripe.test/authority' };
        },
      },
    },
  };

  service = new BillingService(prisma as never);
  (service as unknown as { getStripe: () => unknown }).getStripe = () => stripe;

  return {
    service,
    events,
    rawQueries,
    checkoutRequestOptions,
    checkoutParams,
    grant: () => grant,
    attempt: () => attempt,
    setFailCapabilityFinalization(value: boolean) {
      failCapabilityFinalization = value;
    },
    setFailAt(value: HarnessOptions['failAt']) {
      failAt = value;
    },
    waitForPortalCreate: () => portalCreateEntered,
    releasePortalCreate() {
      releasePausedPortalCreate?.();
    },
    checkoutEvent,
    interlockTx: () => ({
      $queryRaw: async () => grant?.state === 'RELEASED' || !grant ? [] : [grant],
      billingAuthorityGrant: authorityGrant,
    }),
  };
}

test('claim transaction is short and binds exact tenant, owner version, and active session predicates', async () => {
  const harness = claimantHarness();
  await harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1');

  const firstProvider = harness.events.findIndex((event) => event.startsWith('stripe:'));
  const firstTransactionEnd = harness.events.findIndex((event) => event.startsWith('transaction:end'));
  assert.ok(firstTransactionEnd >= 0 && firstTransactionEnd < firstProvider);
  assert.match(
    harness.events[firstTransactionEnd],
    /"isolationLevel":"Serializable"[\s\S]*"maxWait":10000[\s\S]*"timeout":10000/,
  );
  const sql = harness.rawQueries.join('\n');
  assert.match(sql, /FROM "Organisation"[\s\S]*WHERE "id"/);
  assert.match(sql, /FROM "BillingAuthorityGrant"[\s\S]*"state" <> 'RELEASED'[\s\S]*FOR UPDATE/);
  assert.match(sql, /FROM "User"[\s\S]*"id"[\s\S]*"organisationId"[\s\S]*FOR UPDATE/);
  assert.match(sql, /FROM "AuthSession"[\s\S]*"id"[\s\S]*"userId"[\s\S]*"revokedAt" IS NULL[\s\S]*"expiresAt" > NOW\(\)[\s\S]*FOR UPDATE/);
});

test('claim fails closed for inactive org, cross-tenant owner, and wrong, revoked, or expired session', async (t) => {
  const cases = [
    { name: 'inactive organisation', options: { organisationStatus: 'SUSPENDED' as const }, code: 'ORGANISATION_INACTIVE' },
    { name: 'cross-tenant or missing actor', options: { actorAvailable: false }, code: 'FORBIDDEN' },
    { name: 'wrong session', options: { sessionAvailable: false }, code: 'UNAUTHORIZED' },
    { name: 'revoked session', options: { sessionAvailable: false }, code: 'UNAUTHORIZED' },
    { name: 'expired session', options: { sessionAvailable: false }, code: 'UNAUTHORIZED' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const harness = claimantHarness(scenario.options);
      await assert.rejects(
        () => harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
        (error: unknown) => errorCode(error) === scenario.code,
      );
      assert.equal(harness.events.some((event) => event.startsWith('stripe:')), false);
    });
  }
});

test('provider capabilities are retained but never returned after the claimant session is revoked', async (t) => {
  await t.test('Checkout', async () => {
    const harness = claimantHarness({ revokeSessionAfterProviderCreate: true });
    await assert.rejects(
      () => harness.service.createCheckoutSessionForCurrentOwner(
        'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
      ),
      (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_SESSION_REVOKED',
    );
    assert.equal(harness.grant()?.state, 'CAPABILITY_ISSUED');
    assert.equal(harness.grant()?.providerResourceId, 'cs_authority');
  });

  await t.test('Portal', async () => {
    const harness = claimantHarness({ revokeSessionAfterProviderCreate: true });
    await assert.rejects(
      () => harness.service.createPortalSessionForCurrentOwner(
        'org-1', 'owner-1', 'session-owner-1',
      ),
      (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_SESSION_REVOKED',
    );
    assert.equal(harness.grant()?.state, 'CAPABILITY_ISSUED');
    assert.equal(harness.grant()?.providerResourceId, 'bps_authority');
  });
});

test('Checkout persists one durable grant and attempt with stable provider idempotency across retry', async () => {
  const harness = claimantHarness();
  const first = await harness.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  );
  const grantId = harness.grant()?.id;
  const attemptId = harness.attempt()?.id;
  const retry = await harness.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  );

  assert.deepEqual(first, retry);
  assert.equal(harness.grant()?.id, grantId);
  assert.equal(harness.attempt()?.id, attemptId);
  assert.equal(harness.grant()?.state, 'CAPABILITY_ISSUED');
  assert.equal(harness.grant()?.providerResourceId, 'cs_authority');
  assert.equal(harness.checkoutRequestOptions.length, 1);
  assert.equal(
    harness.checkoutRequestOptions[0].idempotencyKey,
    `charitypilot-checkout-${attemptId}`,
  );
  assert.equal(
    (harness.checkoutParams[0].metadata as Record<string, unknown>).billingAuthorityGrantId,
    grantId,
  );
});

test('provider success plus grant-finalization failure stays blocking and retry reuses grant and idempotency', async () => {
  const harness = claimantHarness({ failCapabilityFinalization: true });
  await assert.rejects(
    () => harness.service.createCheckoutSessionForCurrentOwner(
      'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
    ),
    (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_STATE_CONFLICT',
  );
  const grantId = harness.grant()?.id;
  const attemptId = harness.attempt()?.id;
  assert.equal(harness.grant()?.state, 'PROVIDER_STARTED');
  assert.equal(harness.attempt()?.status, 'SESSION_CREATED');

  harness.setFailCapabilityFinalization(false);
  const retry = await harness.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  );
  assert.deepEqual(retry, { url: 'https://checkout.stripe.test/authority' });
  assert.equal(harness.grant()?.id, grantId);
  assert.equal(harness.attempt()?.id, attemptId);
  assert.equal(harness.checkoutRequestOptions.length, 1);
});

test('definite pre-capability failure releases, while ambiguous provider-create failure remains blocking', async () => {
  const definite = claimantHarness({ failAt: 'customer-retrieve' });
  await assert.rejects(() => definite.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  ));
  assert.equal(definite.grant()?.state, 'RELEASED');
  assert.equal(definite.grant()?.releaseReason, 'PROVIDER_CONFIRMED_NOT_ISSUED');

  const ambiguous = claimantHarness({ failAt: 'checkout-create' });
  await assert.rejects(() => ambiguous.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  ));
  assert.equal(ambiguous.grant()?.state, 'PROVIDER_STARTED');
  assert.equal(ambiguous.attempt()?.status, 'PENDING');
  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(
      ambiguous.interlockTx() as never,
      'org-1',
    ),
    (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE',
  );
});

test('Portal capability never auto-releases and remains an ownership transfer/recovery interlock', async () => {
  const harness = claimantHarness();
  await harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1');
  assert.equal(harness.grant()?.state, 'CAPABILITY_ISSUED');
  assert.equal(harness.grant()?.safeReleaseAfter, null);

  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(
      harness.interlockTx() as never,
      'org-1',
      { now: new Date('2099-01-01T00:00:00.000Z') },
    ),
    (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE',
  );

  const lifecycle = readFileSync(join(process.cwd(), 'src', 'services', 'team-lifecycle.service.ts'), 'utf8');
  const recovery = readFileSync(join(process.cwd(), 'src', 'jobs', 'recover-team-ownership.ts'), 'utf8');
  assert.match(lifecycle, /transferOwnership[\s\S]*assertBillingAuthorityAllowsOwnershipChange/);
  assert.match(recovery, /executeOwnershipRecovery[\s\S]*assertBillingAuthorityAllowsOwnershipChange/);
});

test('Portal failure before create releases, while ambiguous create failure remains unresolved', async () => {
  const definite = claimantHarness({ failAt: 'customer-retrieve' });
  await assert.rejects(
    () => definite.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
  );
  assert.equal(definite.grant()?.state, 'RELEASED');

  const ambiguous = claimantHarness({ failAt: 'portal-create' });
  await assert.rejects(
    () => ambiguous.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
  );
  assert.equal(ambiguous.grant()?.state, 'PROVIDER_STARTED');
});

test('Portal retry cannot release a grant left ambiguous by an earlier provider attempt', async () => {
  const harness = claimantHarness({ failAt: 'portal-create' });
  await assert.rejects(
    () => harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
  );
  assert.equal(harness.grant()?.state, 'PROVIDER_STARTED');

  harness.setFailAt('customer-retrieve');
  await assert.rejects(
    () => harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
  );

  assert.equal(harness.grant()?.state, 'PROVIDER_STARTED');
  assert.equal(harness.grant()?.releaseReason, null);
  assert.equal(harness.events.filter((event) => event === 'grant:released').length, 0);
});

test('concurrent Portal requests allow only the provider-start CAS winner to reach create', async () => {
  const harness = claimantHarness({ failAt: 'portal-create', pausePortalCreate: true });
  const winner = harness.service.createPortalSessionForCurrentOwner(
    'org-1',
    'owner-1',
    'session-owner-1',
  );
  await harness.waitForPortalCreate();

  await assert.rejects(
    () => harness.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
    (error: unknown) => errorCode(error) === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE',
  );
  assert.equal(harness.events.filter((event) => event === 'stripe:portal-create').length, 1);
  assert.equal(harness.grant()?.state, 'PROVIDER_STARTED');

  harness.releasePortalCreate();
  await assert.rejects(() => winner);
  assert.equal(harness.grant()?.state, 'PROVIDER_STARTED');
  assert.equal(harness.events.filter((event) => event === 'grant:released').length, 0);
});

test('grant transition timestamps remain monotonic when the database clock is ahead', async () => {
  const claimedAt = new Date(Date.now() + 60_000);
  const issued = claimantHarness({ grantClaimedAt: claimedAt });
  await issued.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1');
  assert.ok((issued.grant()?.providerStartedAt?.getTime() ?? 0) >= claimedAt.getTime());
  assert.ok(
    (issued.grant()?.capabilityIssuedAt?.getTime() ?? 0) >=
      (issued.grant()?.providerStartedAt?.getTime() ?? Number.POSITIVE_INFINITY),
  );

  const released = claimantHarness({ grantClaimedAt: claimedAt, failAt: 'customer-retrieve' });
  await assert.rejects(
    () => released.service.createPortalSessionForCurrentOwner('org-1', 'owner-1', 'session-owner-1'),
  );
  assert.ok((released.grant()?.releasedAt?.getTime() ?? 0) >= claimedAt.getTime());
});

test('matching checkout webhook atomically completes subscription/attempt and terminal-releases the grant', async () => {
  const harness = claimantHarness();
  await harness.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  );
  await harness.service.handleWebhook(harness.checkoutEvent() as never);

  assert.equal(harness.attempt()?.status, 'COMPLETED');
  assert.equal(harness.grant()?.state, 'RELEASED');
  assert.equal(harness.grant()?.releaseReason, 'PROVIDER_CAPABILITY_TERMINAL');
  const recorded = harness.events.indexOf('webhook:recorded');
  const subscribed = harness.events.indexOf('subscription:upserted');
  const completed = harness.events.indexOf('attempt:completed');
  const released = harness.events.indexOf('grant:released');
  assert.ok(recorded >= 0 && recorded < subscribed && subscribed < completed && completed < released);
});

test('checkout completion webhook racing request finalization preserves a monotonic same-second timeline', async () => {
  const harness = claimantHarness({ webhookDuringCheckoutCreate: true });
  const result = await harness.service.createCheckoutSessionForCurrentOwner(
    'org-1', 'owner-1', 'session-owner-1', SubscriptionPlan.COMPLETE, 'monthly',
  );
  assert.deepEqual(result, { url: 'https://checkout.stripe.test/authority' });
  assert.equal(harness.attempt()?.status, 'COMPLETED');
  assert.equal(harness.grant()?.state, 'RELEASED');
  assert.equal(harness.grant()?.releaseReason, 'PROVIDER_CAPABILITY_TERMINAL');
  assert.ok(
    (harness.grant()?.capabilityIssuedAt?.getTime() ?? 0) >=
      (harness.grant()?.providerStartedAt?.getTime() ?? Number.POSITIVE_INFINITY),
  );
  assert.ok(
    (harness.grant()?.releasedAt?.getTime() ?? 0) >=
      (harness.grant()?.capabilityIssuedAt?.getTime() ?? Number.POSITIVE_INFINITY),
  );
  assert.equal(harness.checkoutRequestOptions.length, 1);
});
