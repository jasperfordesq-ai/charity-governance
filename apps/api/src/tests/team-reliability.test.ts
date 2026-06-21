import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
// teamRoutes constructs an EmailService (new Resend(...)), which throws without a key.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'team-reliability-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_team_reliability_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [
  { default: Fastify },
  { default: rateLimit },
  { TeamService },
  { teamRoutes },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/rate-limit'),
  import('../services/team.service.js'),
  import('../routes/team/index.js'),
  import('../utils/jwt.js'),
]);

const TEAM_INVITE_ACCEPTED_MESSAGE = 'If the invite can be sent, we will email the recipient.';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

const noopEmail = { sendTeamInvite: async () => true } as never;
const codeOf = (err: unknown) => (err as { code?: string })?.code;

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

function activeSubscription() {
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000) };
}

function authModels(role: Role, subscription: unknown) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => subscription },
  };
}

function futureDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d;
}

// ── team-tenant-isolation-4 ──

test("list scopes members and invites to the caller's organisation", async () => {
  const seen: { users?: string; invites?: string } = {};
  const prisma = {
    user: {
      findMany: async (args: { where: { organisationId: string } }) => {
        seen.users = args.where.organisationId;
        return [
          {
            id: 'u_self',
            email: 'self@example.org',
            name: 'Self',
            role: 'OWNER',
            emailVerified: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ];
      },
    },
    teamInvite: {
      findMany: async (args: { where: { organisationId: string } }) => {
        seen.invites = args.where.organisationId;
        return [];
      },
    },
  };
  const service = new TeamService(prisma as never, noopEmail);

  await service.list('org_1');

  assert.equal(seen.users, 'org_1', 'user.findMany must be scoped to the caller organisation');
  assert.equal(seen.invites, 'org_1', 'teamInvite.findMany must be scoped to the caller organisation');
});

// ── team-authz-boundary-9 ──

test('a MEMBER cannot revoke an invite', async () => {
  const calls: string[] = [];
  const prisma = {
    teamInvite: {
      findFirst: async () => {
        calls.push('findFirst');
        return null;
      },
      update: async () => {
        calls.push('update');
        return {};
      },
    },
  };
  const service = new TeamService(prisma as never, noopEmail);

  await assert.rejects(
    () => service.revoke('org_1', 'inv_1', 'MEMBER'),
    (e: unknown) => codeOf(e) === 'FORBIDDEN',
  );
  assert.equal(calls.includes('findFirst'), false, 'must not look up the invite for an unauthorised actor');
  assert.equal(calls.includes('update'), false, 'must not revoke the invite for an unauthorised actor');
});

// ── team-authz-boundary-10 ──

test('revoke rejects an already-accepted invite', async () => {
  let updateCalled = false;
  const prisma = {
    teamInvite: {
      findFirst: async () => ({ id: 'inv_1', organisationId: 'org_1', acceptedAt: new Date() }),
      update: async () => {
        updateCalled = true;
        return {};
      },
    },
  };
  const service = new TeamService(prisma as never, noopEmail);

  await assert.rejects(
    () => service.revoke('org_1', 'inv_1', 'OWNER'),
    (e: unknown) => codeOf(e) === 'INVITE_ACCEPTED',
  );
  assert.equal(updateCalled, false, 'an accepted invite must never be updated/revoked');
});

// ── team-plan-gating-11 ──

async function buildTeamApp(subscription: unknown = activeSubscription()) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', subscription),
    teamInvite: {
      findUnique: async () => null,
      findMany: async () => [],
      create: async () => {
        throw new Error('teamInvite.create must not be reached');
      },
    },
    user: {
      findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role: 'OWNER', emailVerified: true }),
      findMany: async () => [],
      update: async () => {
        throw new Error('user.update must not be reached');
      },
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  return app;
}

test('authenticated team routes require an active subscription', async () => {
  const app = await buildTeamApp(null);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'NO_SUBSCRIPTION');
  } finally {
    await app.close();
  }
});

// ── team-plan-gating-14 ──

test('acceptInvite rejects when the organisation has no subscription', async () => {
  let createCalled = false;
  const invite = {
    id: 'inv_1',
    email: 'invitee@example.org',
    organisationId: 'org_1',
    role: 'MEMBER',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: futureDate(),
  };
  const prisma = {
    teamInvite: { findUnique: async () => invite },
    user: { findUnique: async () => null },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        subscription: { findUnique: async () => null },
        user: {
          count: async () => 0,
          create: async () => {
            createCalled = true;
            return {};
          },
        },
        teamInvite: {
          count: async () => 0,
          updateMany: async () => ({ count: 1 }),
        },
      }),
  };
  const service = new TeamService(prisma as never, noopEmail);

  await assert.rejects(
    () => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (e: unknown) => codeOf(e) === 'NO_SUBSCRIPTION',
  );
  assert.equal(createCalled, false, 'the user must not be created without a subscription');
});

// ── team-input-validation-15 ──

test('accept-invite rejects a weak password with VALIDATION_ERROR', async () => {
  let lookupCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    teamInvite: {
      findUnique: async () => {
        lookupCalled = true;
        return null;
      },
      findMany: async () => [],
    },
    user: { findUnique: async () => null, findMany: async () => [] },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/accept-invite',
      payload: { token: 't', name: 'New User', password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(lookupCalled, false, 'a malformed body must be rejected before any invite lookup');
  } finally {
    await app.close();
  }
});

// ── team-input-validation-16 ──

test('invite rejects an invalid email with VALIDATION_ERROR', async () => {
  let createCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    teamInvite: {
      findUnique: async () => null,
      findMany: async () => [],
      create: async () => {
        createCalled = true;
        return {};
      },
    },
    user: {
      findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role: 'OWNER', emailVerified: true }),
      findMany: async () => [],
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/invites',
      headers: { authorization: tokenFor('OWNER') },
      payload: { email: 'not-an-email', role: 'MEMBER' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(createCalled, false, 'an invalid invite body must not create a teamInvite');
  } finally {
    await app.close();
  }
});

// ── team-input-validation-17 ──

test('member role update rejects an invalid role with VALIDATION_ERROR', async () => {
  let updateCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    teamInvite: { findUnique: async () => null, findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role: 'OWNER', emailVerified: true }),
      findMany: async () => [],
      findFirst: async () => ({ id: 'm1', organisationId: 'org-1', role: 'MEMBER' }),
      update: async () => {
        updateCalled = true;
        return {};
      },
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/members/m1/role',
      headers: { authorization: tokenFor('OWNER') },
      payload: { role: 'SUPERADMIN' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(updateCalled, false, 'an invalid role must not reach user.update');
  } finally {
    await app.close();
  }
});

// ── team-graceful-degradation-18 ──

test('invite still succeeds when the email provider fails', async () => {
  let createCalled = false;
  const prisma = {
    organisation: { findUnique: async () => ({ name: 'Org' }) },
    subscription: { findUnique: async () => ({ plan: 'COMPLETE' }) },
    user: {
      findUnique: async () => null,
      count: async () => 0,
    },
    teamInvite: {
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async () => {
        createCalled = true;
        return {};
      },
    },
  };
  // The service dispatches the email fire-and-forget (void this.emailService.sendTeamInvite),
  // so a genuine provider rejection is never awaited by the caller. Install a scoped
  // unhandledRejection listener to deterministically absorb that escaping rejection (proving
  // it does not surface to the caller) and restore the original handlers afterwards.
  let invoked = false;
  const failingEmail = {
    sendTeamInvite: async () => {
      invoked = true;
      throw new Error('resend down');
    },
  } as never;
  const service = new TeamService(prisma as never, failingEmail);

  const priorListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  let absorbed: Error | null = null;
  process.on('unhandledRejection', (reason) => {
    absorbed = reason as Error;
  });
  try {
    const result = await service.invite('org-1', 'owner-1', 'OWNER', {
      email: 'x@example.org',
      role: 'MEMBER',
    });

    assert.deepEqual(result, { message: TEAM_INVITE_ACCEPTED_MESSAGE });
    assert.equal(createCalled, true, 'the invite must have been created');
    assert.equal(invoked, true, 'the email provider was invoked');

    // Drain microtasks/ticks so the fire-and-forget rejection is delivered to our listener.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(absorbed, 'the provider rejection was raised asynchronously, not to the caller');
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of priorListeners) {
      process.on('unhandledRejection', listener);
    }
  }
});
