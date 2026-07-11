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
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }]
        : [{ id: 'u_self', role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
    },
    user: {
      findMany: async (args: { where: { organisationId: string } }) => {
        seen.users = args.where.organisationId;
        return [{
          id: 'u_self',
          email: 'self@example.org',
          name: 'Self',
          role: 'OWNER' as const,
          emailVerified: true,
          lifecycleStatus: 'ACTIVE' as const,
          membershipVersion: 1,
          membershipChangedAt: new Date('2026-01-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }];
      },
    },
    authSession: { groupBy: async () => [] },
    teamInvite: {
      findMany: async (args: { where: { organisationId: string } }) => {
        seen.invites = args.where.organisationId;
        return [];
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };

  await new TeamService(prisma as never, noopEmail).list('org_1', 'u_self');

  assert.equal(seen.users, 'org_1', 'user.findMany must be scoped to the caller organisation');
  assert.equal(seen.invites, 'org_1', 'teamInvite.findMany must be scoped to the caller organisation');
});

test('MEMBER team lists omit invite rows and every member active-session count', async () => {
  let inviteRead = false;
  let sessionCountRead = false;
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }]
        : [{ id: 'member-self', role: 'MEMBER', lifecycleStatus: 'ACTIVE' }];
    },
    user: {
      findMany: async () => [
        {
          id: 'member-self', email: 'member@example.org', name: 'Member', role: 'MEMBER' as const,
          emailVerified: true, lifecycleStatus: 'ACTIVE' as const, membershipVersion: 2,
          membershipChangedAt: new Date('2026-07-11T01:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'owner', email: 'owner@example.org', name: 'Owner', role: 'OWNER' as const,
          emailVerified: true, lifecycleStatus: 'ACTIVE' as const, membershipVersion: 4,
          membershipChangedAt: new Date('2026-07-11T01:00:00.000Z'),
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ],
    },
    authSession: {
      groupBy: async () => {
        sessionCountRead = true;
        return [];
      },
    },
    teamInvite: {
      findMany: async () => {
        inviteRead = true;
        return [{ id: 'sensitive-invite' }];
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamService(prisma as never, noopEmail).list('org_1', 'member-self');

  assert.equal(inviteRead, false);
  assert.equal(sessionCountRead, false);
  assert.deepEqual(result.invites, []);
  assert.equal(result.members.some((member) => 'activeSessionCount' in member), false);
});

test('ADMIN team lists expose counts only for self and MEMBER targets using the live role', async () => {
  const members = [
    { id: 'owner', role: 'OWNER' as const },
    { id: 'admin-self', role: 'ADMIN' as const },
    { id: 'admin-other', role: 'ADMIN' as const },
    { id: 'member-1', role: 'MEMBER' as const },
  ].map((member, index) => ({
    ...member,
    email: `${member.id}@example.org`, name: member.id, emailVerified: true,
    lifecycleStatus: 'ACTIVE' as const, membershipVersion: index + 1,
    membershipChangedAt: new Date('2026-07-11T01:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  let rawCall = 0;
  let countedIds: string[] = [];
  let inviteRead = false;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }]
        : [{ id: 'admin-self', role: 'ADMIN', lifecycleStatus: 'ACTIVE' }];
    },
    user: { findMany: async () => members },
    authSession: {
      groupBy: async (args: { where: { userId: { in: string[] } } }) => {
        countedIds = args.where.userId.in;
        return [
          { userId: 'admin-self', _count: { _all: 2 } },
          { userId: 'member-1', _count: { _all: 1 } },
        ];
      },
    },
    teamInvite: { findMany: async () => { inviteRead = true; return []; } },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamService(prisma as never, noopEmail).list('org_1', 'admin-self');
  const adminResult = result.members.find((member) => member.id === 'admin-self') as {
    activeSessionCount?: number;
  };
  const memberResult = result.members.find((member) => member.id === 'member-1') as {
    activeSessionCount?: number;
  };

  assert.deepEqual(countedIds.sort(), ['admin-self', 'member-1']);
  assert.equal(inviteRead, true);
  assert.equal(adminResult.activeSessionCount, 2);
  assert.equal(memberResult.activeSessionCount, 1);
  assert.equal('activeSessionCount' in (result.members.find((member) => member.id === 'owner') ?? {}), false);
  assert.equal('activeSessionCount' in (result.members.find((member) => member.id === 'admin-other') ?? {}), false);
});

test('OWNER team lists expose counts for self and every non-owner session target', async () => {
  const members = [
    { id: 'owner-self', role: 'OWNER' as const },
    { id: 'admin-1', role: 'ADMIN' as const },
    { id: 'member-1', role: 'MEMBER' as const },
  ].map((member, index) => ({
    ...member,
    email: `${member.id}@example.org`, name: member.id, emailVerified: true,
    lifecycleStatus: 'ACTIVE' as const, membershipVersion: index + 1,
    membershipChangedAt: new Date('2026-07-11T01:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  let rawCall = 0;
  let countedIds: string[] = [];
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }]
        : [{ id: 'owner-self', role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
    },
    user: { findMany: async () => members },
    authSession: {
      groupBy: async (args: { where: { userId: { in: string[] } } }) => {
        countedIds = args.where.userId.in;
        return [];
      },
    },
    teamInvite: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamService(prisma as never, noopEmail).list('org_1', 'owner-self');

  assert.deepEqual(countedIds.sort(), ['admin-1', 'member-1', 'owner-self']);
  assert.equal(result.members.every((member) => 'activeSessionCount' in member), true);
});

test('team list fails closed before metadata reads when the live actor is absent or inactive', async (t) => {
  for (const actorRows of [[], [{ id: 'actor', role: 'OWNER', lifecycleStatus: 'SUSPENDED' }]]) {
    await t.test(actorRows.length === 0 ? 'absent actor' : 'inactive actor', async () => {
      let rawCall = 0;
      let metadataRead = false;
      const tx = {
        $queryRaw: async () => {
          rawCall += 1;
          return rawCall === 1
            ? [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }]
            : actorRows;
        },
        user: { findMany: async () => { metadataRead = true; return []; } },
      };
      const prisma = {
        $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      };
      await assert.rejects(
        () => new TeamService(prisma as never, noopEmail).list('org_1', 'actor'),
        (error: unknown) => codeOf(error) === 'FORBIDDEN',
      );
      assert.equal(metadataRead, false);
    });
  }
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
    () => service.revoke(
      'org_1',
      'inv_1',
      'member-actor',
      'MEMBER',
      'This invitation should no longer be available.',
    ),
    (e: unknown) => codeOf(e) === 'FORBIDDEN',
  );
  assert.equal(calls.includes('findFirst'), false, 'must not look up the invite for an unauthorised actor');
  assert.equal(calls.includes('update'), false, 'must not revoke the invite for an unauthorised actor');
});

// ── team-authz-boundary-10 ──

test('revoke rejects an already-accepted invite', async () => {
  let updateCalled = false;
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [{ id: 'owner-1', name: 'Owner', role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
      return [{
        id: 'inv_1',
        email: 'accepted@example.org',
        role: 'MEMBER',
        acceptedAt: new Date(),
        revokedAt: null,
      }];
    },
    teamInvite: {
      updateMany: async () => {
        updateCalled = true;
        return { count: 1 };
      },
    },
    securityAuditEvent: { create: async () => ({}) },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };
  const service = new TeamService(prisma as never, noopEmail);

  await assert.rejects(
    () => service.revoke(
      'org_1',
      'inv_1',
      'owner-1',
      'OWNER',
      'The accepted invitation cannot be revoked.',
    ),
    (e: unknown) => codeOf(e) === 'INVITE_ACCEPTED',
  );
  assert.equal(updateCalled, false, 'an accepted invite must never be updated/revoked');
});

// ── team-plan-gating-11 ──

async function buildTeamApp(subscription: unknown = activeSubscription()) {
  const app = Fastify({ logger: false });
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall % 2 === 1
        ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }]
        : [{ id: 'u1', role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
    },
    user: { findMany: async () => [] },
    authSession: { groupBy: async () => [] },
    teamInvite: { findMany: async () => [] },
  };
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
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  return app;
}

test('team security reads remain available while new invitations require an active subscription', async () => {
  const app = await buildTeamApp(null);
  try {
    const read = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(read.statusCode, 200);

    const invite = await app.inject({
      method: 'POST',
      url: '/invites',
      headers: { authorization: tokenFor('OWNER') },
      payload: { email: 'new-member@example.org', role: 'MEMBER' },
    });
    assert.equal(invite.statusCode, 403);
    assert.equal(invite.json().code, 'NO_SUBSCRIPTION');
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
    (e: unknown) => codeOf(e) === 'INVALID_INVITE',
  );
  assert.equal(createCalled, false, 'the user must not be created without a subscription');
});

test('acceptInvite returns the generic failure when the organisation became inactive during hashing', async () => {
  let inviteConsumed = false;
  const invite = {
    id: 'inv_inactive',
    email: 'inactive-invitee@example.org',
    organisationId: 'org_inactive',
    role: 'MEMBER',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: futureDate(),
  };
  const prisma = {
    teamInvite: { findUnique: async () => invite },
    user: { findUnique: async () => null },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [{ id: 'org_inactive', lifecycleStatus: 'SUSPENDED' }],
      subscription: {
        findUnique: async () => ({
          plan: 'COMPLETE',
          status: 'ACTIVE',
          trialEndsAt: null,
          currentPeriodEnd: null,
        }),
      },
      user: { count: async () => 0 },
      teamInvite: {
        count: async () => 0,
        updateMany: async () => {
          inviteConsumed = true;
          return { count: 1 };
        },
      },
    }),
  };
  const service = new TeamService(prisma as never, noopEmail);

  await assert.rejects(
    () => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (error: unknown) => codeOf(error) === 'INVALID_INVITE',
  );
  assert.equal(inviteConsumed, false);
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

test('member role update rejects invalid and ownership roles with VALIDATION_ERROR', async () => {
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
    for (const role of ['SUPERADMIN', 'OWNER']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/members/m1/role',
        headers: { authorization: tokenFor('OWNER') },
        payload: {
          role,
          expectedMembershipVersion: 1,
          reason: 'Routine team governance change',
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().code, 'VALIDATION_ERROR');
    }
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
      findUnique: async (args: { where: { id?: string; email?: string } }) =>
        args.where.id
          ? {
              id: 'owner-1',
              name: 'Owner',
              role: 'OWNER',
              organisationId: 'org-1',
              lifecycleStatus: 'ACTIVE',
            }
          : null,
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
  // EmailService contains both resolved provider errors and thrown SDK failures,
  // returning false so this enumeration-resistant endpoint stays neutral.
  let invoked = false;
  const failingEmail = {
    sendTeamInvite: async () => {
      invoked = true;
      return false;
    },
  } as never;
  const service = new TeamService(prisma as never, failingEmail);

  const result = await service.invite('org-1', 'owner-1', 'OWNER', {
    email: 'x@example.org',
    role: 'MEMBER',
  });

  assert.deepEqual(result, { message: TEAM_INVITE_ACCEPTED_MESSAGE });
  assert.equal(createCalled, true, 'the invite must have been created');
  assert.equal(invoked, true, 'the email provider was invoked');
});
