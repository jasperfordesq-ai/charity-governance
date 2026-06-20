import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'route-guards-test-secret';
// teamRoutes constructs an EmailService (new Resend(...)), which throws without a
// key. Sibling tests default these too; CI has no ambient .env so they're required.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_route_guards_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [
  { default: Fastify },
  { default: rateLimit },
  { boardMemberRoutes },
  { teamRoutes },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/rate-limit'),
  import('../routes/board-members/index.js'),
  import('../routes/team/index.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

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

async function buildBoardApp(role: Role, subscription: unknown = activeSubscription()) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels(role, subscription),
    boardMember: {
      findMany: async () => [],
      count: async () => 0,
      create: async (a: { data: Record<string, unknown> }) => ({ id: 'bm-1', ...a.data }),
      findFirst: async () => ({ id: 'bm-1', organisationId: 'org-1' }),
      update: async () => ({ id: 'bm-1' }),
      delete: async () => ({}),
    },
  } as never);
  await app.register(boardMemberRoutes);
  return app;
}

// ── board-member route guards ──

test('board-member routes require authentication', async () => {
  const app = await buildBoardApp('ADMIN');
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

test('board-member routes require an active subscription', async () => {
  const app = await buildBoardApp('ADMIN', null);
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'NO_SUBSCRIPTION');
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot create, update, or delete board members (requireAdmin)', async () => {
  const app = await buildBoardApp('MEMBER');
  try {
    const create = await app.inject({
      method: 'POST', url: '/',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { name: 'Mary', role: 'Chair', appointedDate: '2026-01-01' },
    });
    assert.equal(create.statusCode, 403, 'MEMBER must not create board members');
    assert.equal(create.json().code, 'FORBIDDEN');

    const patch = await app.inject({
      method: 'PATCH', url: '/bm-1',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { name: 'Renamed' },
    });
    assert.equal(patch.statusCode, 403, 'MEMBER must not update board members');

    const del = await app.inject({
      method: 'DELETE', url: '/bm-1',
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(del.statusCode, 403, 'MEMBER must not delete board members');
  } finally {
    await app.close();
  }
});

test('a MEMBER can still read board members, and an ADMIN can create them', async () => {
  const memberApp = await buildBoardApp('MEMBER');
  try {
    const read = await memberApp.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(read.statusCode, 200);
  } finally {
    await memberApp.close();
  }

  const adminApp = await buildBoardApp('ADMIN');
  try {
    const create = await adminApp.inject({
      method: 'POST', url: '/',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { name: 'Mary', role: 'Chair', appointedDate: '2026-01-01' },
    });
    assert.equal(create.statusCode, 201, 'ADMIN may create board members');
  } finally {
    await adminApp.close();
  }
});

// ── team route guards (public accept-invite vs auth-gated rest) ──

async function buildTeamApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels('OWNER', activeSubscription()),
    teamInvite: {
      findUnique: async () => null, // invalid token -> handler returns INVALID_INVITE
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role: 'OWNER', emailVerified: true }),
      findMany: async () => [],
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(teamRoutes);
  return app;
}

test('team accept-invite is public (reaches the handler without auth) and validates the token', async () => {
  const app = await buildTeamApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/accept-invite',
      payload: { token: 'bogus-token', name: 'New User', password: 'Password1' },
    });
    // Public route: must NOT be 401; an invalid token is a 400 INVALID_INVITE.
    assert.notEqual(res.statusCode, 401, 'accept-invite must be reachable without authentication');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_INVITE');
  } finally {
    await app.close();
  }
});

test('authenticated team routes reject unauthenticated requests', async () => {
  const app = await buildTeamApp();
  try {
    for (const route of [
      { method: 'GET' as const, url: '/' },
      { method: 'POST' as const, url: '/invites', payload: { email: 'x@example.org', role: 'MEMBER' } },
      { method: 'PATCH' as const, url: '/members/m1/role', payload: { role: 'ADMIN' } },
    ]) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} must require auth`);
    }
  } finally {
    await app.close();
  }
});
