import assert from 'node:assert/strict';
import test from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dashboard-reliability-test-secret';

const [
  { default: Fastify },
  { dashboardRoutes },
  { ComplianceService },
  { ActivityService },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/dashboard/index.js'),
  import('../services/compliance.service.js'),
  import('../services/activity.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

function tokenFor(role: Role = 'OWNER') {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

function activeSubscription() {
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000), plan: 'ESSENTIALS' };
}

function authModels(role: Role, subscription: unknown, emailVerified = true) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified }) },
    subscription: { findUnique: async () => subscription },
  };
}

// A prisma stub that satisfies every read the dashboard handler performs once the
// guards have passed: the inline deadline/board-member reads, plus the prisma calls
// inside ComplianceService.getSummary and ActivityService.getRecentActivity.
function dashboardReadStubs() {
  return {
    organisation: { findUniqueOrThrow: async () => ({ id: 'org-1', complexity: 'SIMPLE' }) },
    governanceStandard: { findMany: async () => [] },
    complianceRecord: { findMany: async () => [] },
    document: { findMany: async () => [] },
    boardMember: { findMany: async () => [] },
    deadline: { findMany: async () => [] },
  };
}

// ── dashboard-auth-session-1 ──

test('dashboard route rejects unauthenticated requests', async () => {
  let aggregateRead = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => null },
    user: { findUnique: async () => null },
    subscription: { findUnique: async () => activeSubscription() },
    deadline: { findMany: async () => { aggregateRead = true; return []; } },
    boardMember: { findMany: async () => { aggregateRead = true; return []; } },
  } as never);
  await app.register(dashboardRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'UNAUTHORIZED');
    assert.equal(aggregateRead, false, 'no aggregate read may run for an unauthenticated request');
  } finally {
    await app.close();
  }
});

// ── dashboard-auth-session-2 ──

test('dashboard route rejects users with an unverified email', async () => {
  let aggregateRead = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription(), false),
    deadline: { findMany: async () => { aggregateRead = true; return []; } },
    boardMember: { findMany: async () => { aggregateRead = true; return []; } },
  } as never);
  await app.register(dashboardRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'EMAIL_NOT_VERIFIED');
    assert.equal(aggregateRead, false, 'no aggregate read may run for an unverified user');
  } finally {
    await app.close();
  }
});

// ── dashboard-plan-gating-3 ──

test('dashboard route requires an active subscription', async () => {
  const now = Date.now();
  const cases: Array<{ subscription: unknown; code: string }> = [
    { subscription: null, code: 'NO_SUBSCRIPTION' },
    {
      subscription: { status: 'TRIALING', trialEndsAt: new Date(now - 1000), currentPeriodEnd: null, plan: 'ESSENTIALS' },
      code: 'TRIAL_EXPIRED',
    },
    {
      subscription: { status: 'PAST_DUE', trialEndsAt: null, currentPeriodEnd: new Date(now - 1_000_000_000), plan: 'ESSENTIALS' },
      code: 'PAST_DUE_GRACE_EXPIRED',
    },
    {
      subscription: { status: 'CANCELED', trialEndsAt: null, currentPeriodEnd: null, plan: 'ESSENTIALS' },
      code: 'SUBSCRIPTION_INACTIVE',
    },
  ];

  for (const { subscription, code } of cases) {
    let aggregateRead = false;
    const app = Fastify({ logger: false });
    app.decorate('prisma', {
      ...authModels('OWNER', subscription),
      deadline: { findMany: async () => { aggregateRead = true; return []; } },
      boardMember: { findMany: async () => { aggregateRead = true; return []; } },
    } as never);
    await app.register(dashboardRoutes);
    try {
      const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
      assert.equal(res.statusCode, 403, `${code} must reject with 403`);
      assert.equal(res.json().code, code);
      assert.equal(aggregateRead, false, `no aggregate read may run when guard returns ${code}`);
    } finally {
      await app.close();
    }
  }
});

// ── dashboard-tenant-isolation-4 ──

test('dashboard scopes upcoming deadlines to the requesting organisation', async () => {
  // ActivityService.getRecentActivity also reads deadline.findMany (with only an
  // organisationId filter), so identify the inline upcoming-deadlines read by its
  // distinguishing isComplete:false clause.
  let upcomingWhere: { organisationId?: string; isComplete?: boolean } | undefined;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    ...dashboardReadStubs(),
    deadline: {
      findMany: async (args: { where?: { organisationId?: string; isComplete?: boolean } }) => {
        if (args.where && 'isComplete' in args.where) {
          upcomingWhere = args.where;
        }
        return [];
      },
    },
  } as never);
  await app.register(dashboardRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 200);
    assert.equal(upcomingWhere?.organisationId, 'org-1');
    assert.equal(upcomingWhere?.isComplete, false);
  } finally {
    await app.close();
  }
});

// ── dashboard-tenant-isolation-5 ──

test('dashboard scopes board-alert source members to the requesting organisation', async () => {
  let capturedWhere: { organisationId?: string } | undefined;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    ...dashboardReadStubs(),
    boardMember: {
      // ActivityService.getRecentActivity also calls boardMember.findMany; both
      // calls must carry the caller org. The dashboard handler's own call drives
      // boardAlerts, so we return an unsigned member to confirm the alert source.
      findMany: async (args: { where?: { organisationId?: string } }) => {
        capturedWhere = args.where;
        return [
          {
            id: 'bm-org1',
            name: 'Trustee One',
            organisationId: 'org-1',
            conductSigned: false,
            inductionCompleted: true,
            isActive: true,
            appointedDate: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ];
      },
    },
  } as never);
  await app.register(dashboardRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 200);
    assert.equal(capturedWhere?.organisationId, 'org-1');
    const alerts = res.json().data.boardAlerts as Array<{ memberId: string }>;
    assert.ok(alerts.length >= 1, 'the unsigned org-scoped member should produce an alert');
    for (const alert of alerts) {
      assert.equal(alert.memberId, 'bm-org1', 'alerts may only reference the org-scoped member');
    }
  } finally {
    await app.close();
  }
});

// ── dashboard-tenant-isolation-6 ──

test('getSummary scopes the compliance-record query to the requested organisation', async () => {
  let capturedWhere: { organisationId?: string; reportingYear?: number } | undefined;
  const prisma = {
    organisation: { findUniqueOrThrow: async () => ({ id: 'org-1', complexity: 'SIMPLE' }) },
    subscription: { findUnique: async () => ({ plan: 'ESSENTIALS' }) },
    governanceStandard: { findMany: async () => [] },
    complianceRecord: {
      findMany: async (args: { where?: { organisationId?: string; reportingYear?: number } }) => {
        capturedWhere = args.where;
        return [];
      },
    },
  };
  const service = new ComplianceService(prisma as never);

  await service.getSummary('org-1', 2026);

  assert.equal(capturedWhere?.organisationId, 'org-1');
  assert.equal(capturedWhere?.reportingYear, 2026);
});

// ── dashboard-tenant-isolation-7 ──

test('recent activity scopes every source query to the requested organisation', async () => {
  const captured: Record<string, { organisationId?: string } | undefined> = {};
  let orgLookupId: string | undefined;
  let subscriptionLookupOrg: string | undefined;
  const prisma = {
    organisation: {
      findUniqueOrThrow: async (args: { where?: { id?: string } }) => {
        orgLookupId = args.where?.id;
        return { id: 'org-1', complexity: 'SIMPLE' };
      },
    },
    subscription: {
      findUnique: async (args: { where?: { organisationId?: string } }) => {
        subscriptionLookupOrg = args.where?.organisationId;
        return { plan: 'ESSENTIALS' };
      },
    },
    complianceRecord: {
      findMany: async (args: { where?: { organisationId?: string } }) => {
        captured.complianceRecord = args.where;
        return [];
      },
    },
    document: {
      findMany: async (args: { where?: { organisationId?: string } }) => {
        captured.document = args.where;
        return [];
      },
    },
    boardMember: {
      findMany: async (args: { where?: { organisationId?: string } }) => {
        captured.boardMember = args.where;
        return [];
      },
    },
    deadline: {
      findMany: async (args: { where?: { organisationId?: string } }) => {
        captured.deadline = args.where;
        return [];
      },
    },
  };
  const service = new ActivityService(prisma as never);

  await service.getRecentActivity('org-1', 10);

  assert.equal(orgLookupId, 'org-1');
  assert.equal(subscriptionLookupOrg, 'org-1');
  for (const model of ['complianceRecord', 'document', 'boardMember', 'deadline'] as const) {
    assert.equal(captured[model]?.organisationId, 'org-1', `${model}.findMany must be scoped to org-1`);
  }
});

// ── dashboard-graceful-degradation-9 ──

test('dashboard route returns a clean error when an aggregate read fails', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    ...dashboardReadStubs(),
    deadline: {
      findMany: async () => {
        throw new Error('database connection lost at /var/secret/path/db.ts:42');
      },
    },
  } as never);
  await app.register(dashboardRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 500, 'a generic read failure is surfaced as a controlled 500');
    const body = res.json() as { code?: string; error?: string; stack?: unknown };
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.stack, undefined, 'no stack must be serialised');
    assert.ok(!res.payload.includes('db.ts:42'), 'the underlying stack/path must not leak in the body');
  } finally {
    await app.close();
  }
});
