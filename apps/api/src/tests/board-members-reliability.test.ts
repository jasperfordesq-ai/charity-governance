import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'board-members-reliability-test-secret';

const [
  { default: Fastify },
  { boardMemberRoutes },
  { BoardMemberService },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/board-members/index.js'),
  import('../services/board-member.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
type Call = { name: string; args: unknown };

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

// ── board-members-tenant-isolation-4 (service level: list scopes findMany + count) ──

test('board member list scopes findMany and count to the organisation', async () => {
  const calls: Call[] = [];
  const prisma = {
    boardMember: {
      findMany: async (args: unknown) => { calls.push({ name: 'boardMember.findMany', args }); return []; },
      count: async (args: unknown) => { calls.push({ name: 'boardMember.count', args }); return 0; },
    },
  };
  const service = new BoardMemberService(prisma as never);

  await service.list('org_1', 1, 50);

  const findMany = calls.find((c) => c.name === 'boardMember.findMany');
  const count = calls.find((c) => c.name === 'boardMember.count');
  assert.deepEqual((findMany?.args as { where: unknown }).where, { organisationId: 'org_1' });
  assert.deepEqual((count?.args as { where: unknown }).where, { organisationId: 'org_1' });
});

// ── route-level harness for ids 7, 8, 9, 10 ──

type WriteFlags = { createCalled: boolean; updateCalled: boolean; findFirstCalled: boolean; deleteCalled: boolean };

async function buildBoardApp(role: Role, subscription: unknown = activeSubscription()) {
  const flags: WriteFlags = { createCalled: false, updateCalled: false, findFirstCalled: false, deleteCalled: false };
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels(role, subscription),
    boardMember: {
      findMany: async () => [],
      count: async () => 0,
      create: async (a: { data: Record<string, unknown> }) => { flags.createCalled = true; return { id: 'bm-1', ...a.data }; },
      findFirst: async () => { flags.findFirstCalled = true; return { id: 'bm-1', organisationId: 'org-1' }; },
      update: async () => { flags.updateCalled = true; return { id: 'bm-1' }; },
      delete: async () => { flags.deleteCalled = true; return {}; },
    },
  } as never);
  await app.register(boardMemberRoutes);
  return { app, flags };
}

// ── board-members-auth-session-7 ──

test('board-member write routes reject unauthenticated requests', async () => {
  const { app, flags } = await buildBoardApp('ADMIN');
  try {
    const create = await app.inject({
      method: 'POST', url: '/',
      payload: { name: 'Mary', role: 'Chair', appointedDate: '2026-01-01' },
    });
    assert.equal(create.statusCode, 401, 'POST / must require auth');
    assert.equal(create.json().code, 'UNAUTHORIZED');

    const patch = await app.inject({ method: 'PATCH', url: '/bm-1', payload: { name: 'Renamed' } });
    assert.equal(patch.statusCode, 401, 'PATCH /:id must require auth');
    assert.equal(patch.json().code, 'UNAUTHORIZED');

    const del = await app.inject({ method: 'DELETE', url: '/bm-1' });
    assert.equal(del.statusCode, 401, 'DELETE /:id must require auth');
    assert.equal(del.json().code, 'UNAUTHORIZED');

    // The guard runs before the handler, so no write mock is reached.
    assert.equal(flags.createCalled, false);
    assert.equal(flags.updateCalled, false);
    assert.equal(flags.deleteCalled, false);
  } finally {
    await app.close();
  }
});

// ── board-members-plan-gating-8 ──

test('board-member routes reject an expired trial and inactive subscription', async () => {
  const expiredTrial = { status: 'TRIALING', trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: null };
  const trialApp = await buildBoardApp('ADMIN', expiredTrial);
  try {
    const res = await trialApp.app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'TRIAL_EXPIRED');
  } finally {
    await trialApp.app.close();
  }

  const canceled = { status: 'CANCELED', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000) };
  const inactiveApp = await buildBoardApp('ADMIN', canceled);
  try {
    const res = await inactiveApp.app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'SUBSCRIPTION_INACTIVE');
  } finally {
    await inactiveApp.app.close();
  }
});

// ── board-members-input-validation-9 ──

test('POST /board-members rejects malformed bodies with VALIDATION_ERROR and does not create', async () => {
  const { app, flags } = await buildBoardApp('ADMIN');
  try {
    const res = await app.inject({
      method: 'POST', url: '/',
      headers: { authorization: tokenFor('ADMIN') },
      // Violates two rules at once: empty name (min 1) and non-ISO appointedDate.
      payload: { name: '', role: 'Chair', appointedDate: 'not-a-date' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(flags.createCalled, false, 'create must not run on invalid input');
  } finally {
    await app.close();
  }
});

// ── board-members-input-validation-10 ──

test('PATCH /board-members/:id rejects an invalid email with VALIDATION_ERROR and does not update', async () => {
  const { app, flags } = await buildBoardApp('ADMIN');
  try {
    const res = await app.inject({
      method: 'PATCH', url: '/bm-1',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { email: 'not-an-email' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    // Validation happens before the service, so neither the foreign lookup nor the write runs.
    assert.equal(flags.findFirstCalled, false, 'findFirst must not run on invalid input');
    assert.equal(flags.updateCalled, false, 'update must not run on invalid input');
  } finally {
    await app.close();
  }
});
