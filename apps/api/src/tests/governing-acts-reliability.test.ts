import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'governing-acts-reliability-test-secret';

const [
  { default: Fastify },
  { governingActRoutes },
  { GoverningActService },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/governing-acts/index.js'),
  import('../services/governing-act.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

const PREFIX = '/governing-acts';
const NOW = new Date('2026-08-07T12:00:00.000Z');

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

function activeSubscription(plan: string) {
  return {
    status: 'ACTIVE',
    trialEndsAt: null,
    currentPeriodEnd: new Date(Date.now() + 1_000_000_000),
    plan,
  };
}

function authModels(role: Role, subscription: unknown) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => subscription },
  };
}

async function buildApp(
  prismaOverrides: Record<string, unknown>,
  role: Role = 'ADMIN',
  subscription: unknown = activeSubscription('COMPLETE'),
) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    ...authModels(role, subscription),
    ...prismaOverrides,
  } as never);
  await app.register(governingActRoutes, { prefix: PREFIX });
  return app;
}

function spy(): { called: boolean; fn: (...a: unknown[]) => Promise<unknown> } {
  const state = { called: false, fn: async (..._a: unknown[]) => ({ id: 'x' }) };
  state.fn = async (..._a: unknown[]) => {
    state.called = true;
    return { id: 'x' };
  };
  return state;
}

const APPROVED_ACT = {
  id: 'act-1',
  organisationId: 'org-1',
  kind: 'BOARD_MEETING',
  status: 'APPROVED',
  actDate: new Date('2026-07-03'),
  reference: 'BM-2026-07-03',
  title: 'Board meeting July 2026',
  updatedAt: NOW,
};

const DRAFT_ACT = {
  ...APPROVED_ACT,
  id: 'act-draft',
  status: 'DRAFT',
  reference: 'BM-2026-03-18',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation (service level)
// ─────────────────────────────────────────────────────────────────────────────

type Call = { name: string; args: unknown };

function buildService() {
  const calls: Call[] = [];
  const prisma = {
    governingAct: {
      findMany: async (args: unknown) => {
        calls.push({ name: 'governingAct.findMany', args });
        return [];
      },
      create: async (args: unknown) => {
        calls.push({ name: 'governingAct.create', args });
        return { id: 'act-new', ...(args as { data: object }).data };
      },
      findFirst: async (args: unknown) => {
        calls.push({ name: 'governingAct.findFirst', args });
        return null;
      },
      updateMany: async (args: unknown) => {
        calls.push({ name: 'governingAct.updateMany', args });
        return { count: 1 };
      },
    },
    resolution: {
      create: async (args: unknown) => {
        calls.push({ name: 'resolution.create', args });
        return { id: 'res-new', ...(args as { data: object }).data };
      },
      findFirst: async (args: unknown) => {
        calls.push({ name: 'resolution.findFirst', args });
        return null;
      },
      updateMany: async (args: unknown) => {
        calls.push({ name: 'resolution.updateMany', args });
        return { count: 1 };
      },
    },
    document: {
      findMany: async (args: unknown) => {
        calls.push({ name: 'document.findMany', args });
        return [];
      },
      findFirst: async (args: unknown) => {
        calls.push({ name: 'document.findFirst', args });
        return null;
      },
      updateMany: async (args: unknown) => {
        calls.push({ name: 'document.updateMany', args });
        return { count: 1 };
      },
    },
  };
  return { service: new GoverningActService(prisma as never), calls };
}

test('governingAct.findMany is scoped to the caller organisation', async () => {
  const { service, calls } = buildService();

  await service.list('org-1', {}).catch(() => {});

  const call = calls.find((c) => c.name === 'governingAct.findMany');
  assert.ok(call, 'governingAct.findMany must be issued');
  const where = (call.args as { where: { organisationId?: string } }).where;
  assert.equal(where.organisationId, 'org-1', 'findMany must be scoped to org-1');
});

test('board-submissions document query is scoped to the caller organisation', async () => {
  const { service, calls } = buildService();

  await service.getBoardSubmissions('org-1');

  const call = calls.find((c) => c.name === 'document.findMany');
  assert.ok(call, 'document.findMany must be issued');
  const where = (call.args as { where: { organisationId?: string } }).where;
  assert.equal(where.organisationId, 'org-1', 'document.findMany must be scoped to org-1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2: minutes are not evidence until APPROVED
// ─────────────────────────────────────────────────────────────────────────────

test('setDocumentApproval rejects a resolution whose governing act is DRAFT', async () => {

  const draftPrisma = {
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', updatedAt: NOW }),
      updateMany: async () => ({ count: 1 }),
    },
    resolution: {
      findFirst: async () => ({
        id: 'res-1',
        organisationId: 'org-1',
        governingAct: DRAFT_ACT,
      }),
    },
  };

  const svc = new GoverningActService(draftPrisma as never);

  await assert.rejects(
    () => svc.setDocumentApproval('org-1', 'doc-1', 'res-1', undefined, NOW.toISOString()),
    (err: { code?: string }) => {
      assert.equal(err.code, 'MINUTES_NOT_YET_APPROVED');
      return true;
    },
    'Must reject when the governing act is DRAFT',
  );
});

test('setDocumentApproval accepts a resolution from an APPROVED governing act', async () => {
  let updated = false;
  const approvedPrisma = {
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', updatedAt: NOW }),
      updateMany: async () => {
        updated = true;
        return { count: 1 };
      },
    },
    resolution: {
      findFirst: async () => ({
        id: 'res-1',
        organisationId: 'org-1',
        governingAct: APPROVED_ACT,
      }),
    },
  };

  const svc = new GoverningActService(approvedPrisma as never);

  await assert.doesNotReject(
    () => svc.setDocumentApproval('org-1', 'doc-1', 'res-1', undefined, NOW.toISOString()),
    'Must succeed when the governing act is APPROVED',
  );
  assert.equal(updated, true, 'document.updateMany must be called on success');
});

// ─────────────────────────────────────────────────────────────────────────────
// AuthZ boundary: MEMBER cannot write; ADMIN can
// ─────────────────────────────────────────────────────────────────────────────

const validActBody = {
  kind: 'BOARD_MEETING',
  actDate: '2026-08-07',
  reference: 'BM-2026-08-07',
  title: 'Board meeting August 2026',
};

const validResolutionBody = {
  text: 'Resolved: that the financial statements be approved.',
};

test('a MEMBER cannot create governing acts (requireAdmin)', async () => {
  const create = spy();
  const app = await buildApp({ governingAct: { create: create.fn, findFirst: spy().fn } }, 'MEMBER');
  try {
    const res = await app.inject({
      method: 'POST',
      url: PREFIX,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validActBody,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(create.called, false, 'governingAct.create must not run for a MEMBER');
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot update governing acts (requireAdmin)', async () => {
  const update = spy();
  const app = await buildApp(
    {
      governingAct: {
        findFirst: async () => ({ ...APPROVED_ACT, updatedAt: NOW }),
        updateMany: update.fn,
      },
    },
    'MEMBER',
  );
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/act-1`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: { expectedUpdatedAt: NOW.toISOString(), title: 'Renamed' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(update.called, false);
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot add resolutions (requireAdmin)', async () => {
  const create = spy();
  const app = await buildApp(
    { governingAct: { findFirst: async () => APPROVED_ACT }, resolution: { create: create.fn } },
    'MEMBER',
  );
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/act-1/resolutions`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validResolutionBody,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(create.called, false);
  } finally {
    await app.close();
  }
});

test('an ADMIN can create a governing act', async () => {
  const create = spy();
  const app = await buildApp({
    governingAct: {
      findFirst: async () => null,
      create: async (args: unknown) => {
        create.called = true;
        return { id: 'act-new', resolutions: [], ...(args as { data: object }).data };
      },
    },
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: PREFIX,
      headers: { authorization: tokenFor('ADMIN') },
      payload: validActBody,
    });
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    assert.equal(create.called, true, 'governingAct.create must be called');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan gating: ESSENTIALS cannot access governing acts
// ─────────────────────────────────────────────────────────────────────────────

test('an ESSENTIALS plan cannot list governing acts (requireCompletePlan)', async () => {
  const findMany = spy();
  const app = await buildApp(
    { governingAct: { findMany: findMany.fn } },
    'ADMIN',
    activeSubscription('ESSENTIALS'),
  );
  try {
    const res = await app.inject({
      method: 'GET',
      url: PREFIX,
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'PLAN_FEATURE_UNAVAILABLE');
    assert.equal(findMany.called, false, 'findMany must not run under ESSENTIALS plan');
  } finally {
    await app.close();
  }
});

test('an ESSENTIALS plan cannot create governing acts (requireCompletePlan fires before requireAdmin)', async () => {
  const create = spy();
  const app = await buildApp(
    { governingAct: { create: create.fn } },
    'ADMIN',
    activeSubscription('ESSENTIALS'),
  );
  try {
    const res = await app.inject({
      method: 'POST',
      url: PREFIX,
      headers: { authorization: tokenFor('ADMIN') },
      payload: validActBody,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'PLAN_FEATURE_UNAVAILABLE');
    assert.equal(create.called, false);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation: bad bodies get 400, write spy is never called
// ─────────────────────────────────────────────────────────────────────────────

test('creating a governing act with a missing required field returns 400', async () => {
  const create = spy();
  const app = await buildApp({ governingAct: { create: create.fn } });
  try {
    const res = await app.inject({
      method: 'POST',
      url: PREFIX,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { title: 'Missing kind and date' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(create.called, false, 'create must not run on invalid input');
  } finally {
    await app.close();
  }
});

test('creating a resolution with empty text returns 400', async () => {
  const create = spy();
  const app = await buildApp(
    { governingAct: { findFirst: async () => APPROVED_ACT }, resolution: { create: create.fn } },
  );
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/act-1/resolutions`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { text: '' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(create.called, false);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth: unauthenticated requests are rejected
// ─────────────────────────────────────────────────────────────────────────────

test('unauthenticated GET /governing-acts returns 401', async () => {
  const app = await buildApp({
    governingAct: { findMany: async () => [] },
    // override authSession to simulate missing session
    authSession: { findFirst: async () => null },
  });
  try {
    const res = await app.inject({ method: 'GET', url: PREFIX });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Optimistic locking: PATCH requires expectedUpdatedAt
// ─────────────────────────────────────────────────────────────────────────────

test('PATCH /governing-acts/:id without expectedUpdatedAt returns 400', async () => {
  const update = spy();
  const app = await buildApp({
    governingAct: { findFirst: async () => APPROVED_ACT, updateMany: update.fn },
  });
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/act-1`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { title: 'No concurrency token' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(update.called, false, 'updateMany must not run without expectedUpdatedAt');
  } finally {
    await app.close();
  }
});
