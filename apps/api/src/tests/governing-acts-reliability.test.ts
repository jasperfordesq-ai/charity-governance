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

// ─────────────────────────────────────────────────────────────────────────────
// Optimistic locking: a guarded write that matched no row is a conflict
// ─────────────────────────────────────────────────────────────────────────────

test('setDocumentApproval reports a conflict when the guarded write matches no row', async () => {
  // The document moved between the version read and the guarded write. Every
  // other optimistic-locking path raises 409 here; approval evidence must not
  // be the one that reports success after writing nothing.
  let updateArgs: unknown;
  const racingPrisma = {
    document: {
      findFirst: async () => ({ id: 'doc-1', organisationId: 'org-1', updatedAt: NOW }),
      updateMany: async (args: unknown) => {
        updateArgs = args;
        return { count: 0 };
      },
    },
    resolution: {
      findFirst: async () => ({ id: 'res-1', organisationId: 'org-1', governingAct: APPROVED_ACT }),
    },
  };

  const svc = new GoverningActService(racingPrisma as never);

  await assert.rejects(
    () => svc.setDocumentApproval('org-1', 'doc-1', 'res-1', undefined, NOW.toISOString()),
    (err: { statusCode?: number; code?: string }) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'DOCUMENT_UPDATE_CONFLICT');
      return true;
    },
    'a zero-row guarded update must surface as a conflict, not as success',
  );

  const where = (updateArgs as { where: Record<string, unknown> }).where;
  assert.equal(where.organisationId, 'org-1');
  assert.deepEqual(where.updatedAt, NOW, 'the write must stay guarded by the caller version');
});

test('an ISO-less expectedUpdatedAt is a validation error, not a phantom conflict', async () => {
  const update = spy();
  const app = await buildApp({
    governingAct: { findFirst: async () => APPROVED_ACT, updateMany: update.fn },
  });
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/act-1`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { expectedUpdatedAt: 'not-a-timestamp', title: 'Renamed' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(update.called, false);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Void: removal is refused under the same transaction that would delete
// ─────────────────────────────────────────────────────────────────────────────

const ACT_WITH_RESOLUTIONS = {
  ...APPROVED_ACT,
  statutoryBasis: null,
  notes: null,
  approvedAtActId: null,
  approvedAt: null,
  documentId: null,
  createdAt: new Date('2026-07-03T09:00:00.000Z'),
  resolutions: [
    {
      id: 'res-1',
      itemNumber: '1',
      text: 'Resolved: that the financial statements be approved.',
      carried: true,
      abstentions: null,
      conflictRecordId: null,
      createdAt: new Date('2026-07-03T09:05:00.000Z'),
    },
  ],
};

const VALID_VOID_REASON = 'Recorded in error: this board meeting never took place.';

type VoidStubOverrides = {
  dependents?: Array<{ reference: string }>;
  evidencedDocuments?: Array<{ name: string }>;
};

function buildVoidService(overrides: VoidStubOverrides = {}) {
  const calls: string[] = [];
  const tx = {
    governingAct: {
      findFirst: async () => {
        calls.push('governingAct.findFirst');
        return ACT_WITH_RESOLUTIONS;
      },
      findMany: async () => {
        calls.push('governingAct.findMany');
        return overrides.dependents ?? [];
      },
      deleteMany: async () => {
        calls.push('governingAct.deleteMany');
        return { count: 1 };
      },
    },
    document: {
      findMany: async () => {
        calls.push('document.findMany');
        return overrides.evidencedDocuments ?? [];
      },
    },
    resolution: {
      deleteMany: async () => {
        calls.push('resolution.deleteMany');
        return { count: 1 };
      },
    },
    governingActVoid: {
      create: async (args: unknown) => {
        calls.push('governingActVoid.create');
        return { id: 'void-1', ...(args as { data: object }).data };
      },
    },
  };

  const prisma = {
    user: {
      findFirst: async () => {
        calls.push('user.findFirst');
        return { id: 'u1', email: 'owner@example.org' };
      },
    },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      calls.push('$transaction');
      return fn(tx);
    },
  };

  return { service: new GoverningActService(prisma as never), calls };
}

test('voidAct refuses an act whose minutes approved another act, without deleting anything', async () => {
  const { service, calls } = buildVoidService({ dependents: [{ reference: 'BM-2026-09-04' }] });

  await assert.rejects(
    () =>
      service.voidAct('org-1', 'act-1', 'u1', {
        expectedUpdatedAt: NOW.toISOString(),
        reason: VALID_VOID_REASON,
      }),
    (err: { statusCode?: number; code?: string; message?: string }) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'GOVERNING_ACT_HAS_DEPENDENTS');
      assert.match(String(err.message), /BM-2026-09-04/);
      return true;
    },
  );

  assert.ok(!calls.includes('resolution.deleteMany'), 'no resolution may be deleted');
  assert.ok(!calls.includes('governingAct.deleteMany'), 'the act may not be deleted');
  assert.ok(!calls.includes('governingActVoid.create'), 'no audit snapshot may be written');
});

test('voidAct refuses an act whose resolutions evidence a document approval', async () => {
  const { service, calls } = buildVoidService({
    evidencedDocuments: [{ name: 'Reserves policy 2026' }],
  });

  await assert.rejects(
    () =>
      service.voidAct('org-1', 'act-1', 'u1', {
        expectedUpdatedAt: NOW.toISOString(),
        reason: VALID_VOID_REASON,
      }),
    (err: { statusCode?: number; code?: string; message?: string }) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'GOVERNING_ACT_EVIDENCES_DOCUMENTS');
      assert.match(String(err.message), /Reserves policy 2026/);
      return true;
    },
  );

  assert.ok(!calls.includes('governingAct.deleteMany'), 'the act may not be deleted');
});

test('voidAct runs both refusal checks inside the deleting transaction', async () => {
  // Read the links outside the transaction and a concurrently created
  // dependent or approval is severed as a side effect - the exact damage these
  // checks exist to prevent.
  const { service, calls } = buildVoidService();

  await service.voidAct('org-1', 'act-1', 'u1', {
    expectedUpdatedAt: NOW.toISOString(),
    reason: VALID_VOID_REASON,
  });

  const transactionIndex = calls.indexOf('$transaction');
  assert.ok(transactionIndex >= 0, 'removal must run in a transaction');
  for (const call of [
    'governingAct.findFirst',
    'governingAct.findMany',
    'document.findMany',
    'governingActVoid.create',
    'resolution.deleteMany',
    'governingAct.deleteMany',
  ]) {
    assert.ok(calls.indexOf(call) > transactionIndex, `${call} must run inside the transaction`);
  }
});

test('voidAct writes the audit snapshot before removing the act', async () => {
  const { service, calls } = buildVoidService();

  const record = await service.voidAct('org-1', 'act-1', 'u1', {
    expectedUpdatedAt: NOW.toISOString(),
    reason: VALID_VOID_REASON,
  });

  assert.ok(
    calls.indexOf('governingActVoid.create') < calls.indexOf('governingAct.deleteMany'),
    'the snapshot must exist before the act is removed',
  );
  const snapshot = record as unknown as {
    reference: string;
    resolutionCount: number;
    reason: string;
    voidedByEmail: string;
  };
  assert.equal(snapshot.reference, 'BM-2026-07-03');
  assert.equal(snapshot.resolutionCount, 1);
  assert.equal(snapshot.reason, VALID_VOID_REASON);
  assert.equal(snapshot.voidedByEmail, 'owner@example.org', 'the actor is resolved from the user row');
});

test('voidAct rejects a stale expectedUpdatedAt before any write', async () => {
  const { service, calls } = buildVoidService();

  await assert.rejects(
    () =>
      service.voidAct('org-1', 'act-1', 'u1', {
        expectedUpdatedAt: new Date('2026-08-07T11:00:00.000Z').toISOString(),
        reason: VALID_VOID_REASON,
      }),
    (err: { statusCode?: number; code?: string }) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'GOVERNING_ACT_UPDATE_CONFLICT');
      return true;
    },
  );

  assert.ok(!calls.includes('governingActVoid.create'));
  assert.ok(!calls.includes('governingAct.deleteMany'));
});
