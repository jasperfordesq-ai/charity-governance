import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'gov-registers-reliability-test-secret';

const [
  { default: Fastify },
  { governanceRegisterRoutes },
  { GovernanceRegisterService },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/governance-registers/index.js'),
  import('../services/governance-register.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

const PREFIX = '/governance-registers';

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

// A subscription that passes subscriptionGuard (ACTIVE, future period end). `plan`
// controls requireCompletePlan: COMPLETE passes the plan gate, anything else 403s
// with PLAN_FEATURE_UNAVAILABLE.
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
  await app.register(governanceRegisterRoutes, { prefix: PREFIX });
  return app;
}

// A write-spy helper: records that it was called and returns a benign row.
function spy(): { called: boolean; fn: (...a: unknown[]) => Promise<unknown> } {
  const state = { called: false, fn: async (..._a: unknown[]) => ({ id: 'x' }) };
  state.fn = async (...a: unknown[]) => {
    state.called = true;
    return { id: 'x', ...(typeof a[0] === 'object' && a[0] !== null ? (a[0] as { data?: object }).data ?? {} : {}) };
  };
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation (service level)
// ─────────────────────────────────────────────────────────────────────────────

type Call = { name: string; args: unknown };

function buildService() {
  const calls: Call[] = [];
  const registerModel = (name: string) => ({
    findMany: async (args: unknown) => {
      calls.push({ name: `${name}.findMany`, args });
      return [];
    },
  });
  const upsertModel = (name: string) => ({
    findUnique: async (args: unknown) => {
      calls.push({ name: `${name}.findUnique`, args });
      return null;
    },
    upsert: async (args: unknown) => {
      calls.push({ name: `${name}.upsert`, args });
      // upsert returns the saved row; the service re-reads via getXxx using the
      // returned organisationId/reportingYear, so echo them back.
      const a = args as { create: { organisationId: string; reportingYear: number } };
      return { organisationId: a.create.organisationId, reportingYear: a.create.reportingYear };
    },
  });
  const prisma = {
    conflictRecord: registerModel('conflictRecord'),
    riskRecord: registerModel('riskRecord'),
    complaintRecord: registerModel('complaintRecord'),
    fundraisingRecord: registerModel('fundraisingRecord'),
    annualReportReadiness: upsertModel('annualReportReadiness'),
    financialControlReview: upsertModel('financialControlReview'),
  };
  return { service: new GovernanceRegisterService(prisma as never), calls };
}

test('list register methods scope findMany to the caller organisation', async () => {
  const { service, calls } = buildService();

  await service.listConflicts('org_1');
  await service.listRisks('org_1');
  await service.listComplaints('org_1');
  await service.listFundraising('org_1');

  for (const model of ['conflictRecord', 'riskRecord', 'complaintRecord', 'fundraisingRecord']) {
    const findMany = calls.find((c) => c.name === `${model}.findMany`);
    assert.ok(findMany, `${model}.findMany must be issued`);
    assert.deepEqual(
      (findMany.args as { where: unknown }).where,
      { organisationId: 'org_1' },
      `${model}.findMany must be scoped to the caller organisation`,
    );
  }
});

test('annual report readiness reads and upserts are scoped to organisationId_reportingYear', async () => {
  const { service, calls } = buildService();

  await service.getAnnualReportReadiness('org_1', 2026);
  await service.upsertAnnualReportReadiness('org_1', { reportingYear: 2026 } as never);

  const read = calls.find((c) => c.name === 'annualReportReadiness.findUnique');
  assert.ok(read);
  assert.deepEqual((read.args as { where: unknown }).where, {
    organisationId_reportingYear: { organisationId: 'org_1', reportingYear: 2026 },
  });

  const upsert = calls.find((c) => c.name === 'annualReportReadiness.upsert');
  assert.ok(upsert);
  const upsertArgs = upsert.args as { where: unknown; create: { organisationId: string } };
  assert.deepEqual(upsertArgs.where, {
    organisationId_reportingYear: { organisationId: 'org_1', reportingYear: 2026 },
  });
  assert.equal(upsertArgs.create.organisationId, 'org_1');
});

test('financial control review reads and upserts are scoped to organisationId_reportingYear', async () => {
  const { service, calls } = buildService();

  await service.getFinancialControlReview('org_1', 2026);
  await service.upsertFinancialControlReview('org_1', { reportingYear: 2026 } as never);

  const read = calls.find((c) => c.name === 'financialControlReview.findUnique');
  assert.ok(read);
  assert.deepEqual((read.args as { where: unknown }).where, {
    organisationId_reportingYear: { organisationId: 'org_1', reportingYear: 2026 },
  });

  const upsert = calls.find((c) => c.name === 'financialControlReview.upsert');
  assert.ok(upsert);
  const upsertArgs = upsert.args as { where: unknown; create: { organisationId: string } };
  assert.deepEqual(upsertArgs.where, {
    organisationId_reportingYear: { organisationId: 'org_1', reportingYear: 2026 },
  });
  assert.equal(upsertArgs.create.organisationId, 'org_1');
});

// ─────────────────────────────────────────────────────────────────────────────
// AuthZ boundary (route level): a MEMBER cannot write; an ADMIN can.
// requireCompletePlan is a plugin-level preHandler, so a COMPLETE plan + MEMBER
// reaches requireAdmin (per-route preHandler) which is the guard under test.
// ─────────────────────────────────────────────────────────────────────────────

const validConflictBody = {
  trusteeName: 'Jane Doe',
  matter: 'Supplier relationship',
  nature: 'Financial interest',
  dateDeclared: '2026-01-01',
  actionTaken: 'Recused from vote',
};
const validRiskBody = {
  title: 'Funding shortfall',
  category: 'FINANCIAL',
  description: 'Reserves below policy',
  likelihood: 3,
  impact: 4,
  mitigation: 'Diversify income',
};
const validComplaintBody = {
  receivedDate: '2026-01-01',
  summary: 'Late response to enquiry',
};
const validFundraisingBody = {
  name: 'Spring Appeal',
  activityType: 'Direct mail',
};
const validAnnualBody = { reportingYear: 2026 };
const validFinancialBody = { reportingYear: 2026 };

test('a MEMBER cannot create conflict records (requireAdmin)', async () => {
  const create = spy();
  const app = await buildApp({ conflictRecord: { create: create.fn } }, 'MEMBER');
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/conflicts`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validConflictBody,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(create.called, false, 'conflictRecord.create must not run for a MEMBER');
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot update or delete conflict records (requireAdmin)', async () => {
  const update = spy();
  const del = spy();
  const findFirst = spy();
  const app = await buildApp(
    { conflictRecord: { update: update.fn, delete: del.fn, findFirst: findFirst.fn } },
    'MEMBER',
  );
  try {
    const patch = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/conflicts/c1`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: { matter: 'Updated matter' },
    });
    assert.equal(patch.statusCode, 403);
    assert.equal(patch.json().code, 'FORBIDDEN');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/conflicts/c1`,
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(remove.statusCode, 403);
    assert.equal(remove.json().code, 'FORBIDDEN');

    assert.equal(update.called, false, 'conflictRecord.update must not run for a MEMBER');
    assert.equal(del.called, false, 'conflictRecord.delete must not run for a MEMBER');
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot write risk records (requireAdmin)', async () => {
  const create = spy();
  const update = spy();
  const del = spy();
  const app = await buildApp(
    { riskRecord: { create: create.fn, update: update.fn, delete: del.fn, findFirst: spy().fn } },
    'MEMBER',
  );
  try {
    const post = await app.inject({
      method: 'POST',
      url: `${PREFIX}/risks`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validRiskBody,
    });
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().code, 'FORBIDDEN');

    const patch = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/risks/r1`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: { title: 'Renamed' },
    });
    assert.equal(patch.statusCode, 403);
    assert.equal(patch.json().code, 'FORBIDDEN');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/risks/r1`,
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(remove.statusCode, 403);
    assert.equal(remove.json().code, 'FORBIDDEN');

    assert.equal(create.called, false);
    assert.equal(update.called, false);
    assert.equal(del.called, false);
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot write complaint records (requireAdmin)', async () => {
  const create = spy();
  const update = spy();
  const del = spy();
  const app = await buildApp(
    { complaintRecord: { create: create.fn, update: update.fn, delete: del.fn, findFirst: spy().fn } },
    'MEMBER',
  );
  try {
    const post = await app.inject({
      method: 'POST',
      url: `${PREFIX}/complaints`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validComplaintBody,
    });
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().code, 'FORBIDDEN');

    const patch = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/complaints/c1`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: { summary: 'Updated' },
    });
    assert.equal(patch.statusCode, 403);
    assert.equal(patch.json().code, 'FORBIDDEN');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/complaints/c1`,
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(remove.statusCode, 403);
    assert.equal(remove.json().code, 'FORBIDDEN');

    assert.equal(create.called, false);
    assert.equal(update.called, false);
    assert.equal(del.called, false);
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot write fundraising records (requireAdmin)', async () => {
  const create = spy();
  const update = spy();
  const del = spy();
  const app = await buildApp(
    { fundraisingRecord: { create: create.fn, update: update.fn, delete: del.fn, findFirst: spy().fn } },
    'MEMBER',
  );
  try {
    const post = await app.inject({
      method: 'POST',
      url: `${PREFIX}/fundraising`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validFundraisingBody,
    });
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().code, 'FORBIDDEN');

    const patch = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/fundraising/f1`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: { name: 'Renamed' },
    });
    assert.equal(patch.statusCode, 403);
    assert.equal(patch.json().code, 'FORBIDDEN');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/fundraising/f1`,
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(remove.statusCode, 403);
    assert.equal(remove.json().code, 'FORBIDDEN');

    assert.equal(create.called, false);
    assert.equal(update.called, false);
    assert.equal(del.called, false);
  } finally {
    await app.close();
  }
});

test('a MEMBER cannot upsert annual report or financial controls (requireAdmin)', async () => {
  const annualUpsert = spy();
  const financialUpsert = spy();
  const app = await buildApp(
    {
      annualReportReadiness: { upsert: annualUpsert.fn },
      financialControlReview: { upsert: financialUpsert.fn },
    },
    'MEMBER',
  );
  try {
    const annual = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/annual-report`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validAnnualBody,
    });
    assert.equal(annual.statusCode, 403);
    assert.equal(annual.json().code, 'FORBIDDEN');

    const financial = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/financial-controls`,
      headers: { authorization: tokenFor('MEMBER') },
      payload: validFinancialBody,
    });
    assert.equal(financial.statusCode, 403);
    assert.equal(financial.json().code, 'FORBIDDEN');

    assert.equal(annualUpsert.called, false, 'annualReportReadiness.upsert must not run for a MEMBER');
    assert.equal(financialUpsert.called, false, 'financialControlReview.upsert must not run for a MEMBER');
  } finally {
    await app.close();
  }
});

test('an ADMIN may create register records (requireAdmin allows ADMIN)', async () => {
  const create = spy();
  const app = await buildApp({ riskRecord: { create: create.fn } }, 'ADMIN');
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/risks`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: validRiskBody,
    });
    assert.equal(res.statusCode, 201, 'ADMIN must be allowed through requireAdmin');
    assert.equal(create.called, true, 'riskRecord.create must run for an ADMIN');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan gating: an ESSENTIALS org is blocked on every read and write endpoint
// with PLAN_FEATURE_UNAVAILABLE, before the service is reached. requireCompletePlan
// is a plugin-level preHandler, so it fires ahead of the per-route requireAdmin.
// ─────────────────────────────────────────────────────────────────────────────

test('Essentials org is blocked from every governance register read endpoint', async () => {
  // Read spies must NEVER be invoked: the plan gate must short-circuit first.
  const conflictFind = spy();
  const riskFind = spy();
  const complaintFind = spy();
  const fundraisingFind = spy();
  const annualFind = spy();
  const financialFind = spy();
  const app = await buildApp(
    {
      conflictRecord: { findMany: conflictFind.fn },
      riskRecord: { findMany: riskFind.fn },
      complaintRecord: { findMany: complaintFind.fn },
      fundraisingRecord: { findMany: fundraisingFind.fn },
      annualReportReadiness: { findUnique: annualFind.fn },
      financialControlReview: { findUnique: financialFind.fn },
    },
    'OWNER',
    activeSubscription('ESSENTIALS'),
  );
  try {
    const reads = [
      `${PREFIX}/conflicts`,
      `${PREFIX}/risks`,
      `${PREFIX}/complaints`,
      `${PREFIX}/fundraising`,
      `${PREFIX}/annual-report?year=2026`,
      `${PREFIX}/financial-controls?year=2026`,
    ];
    for (const url of reads) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: tokenFor('OWNER') } });
      assert.equal(res.statusCode, 403, `${url} must be plan-gated`);
      assert.equal(res.json().code, 'PLAN_FEATURE_UNAVAILABLE', `${url} must return PLAN_FEATURE_UNAVAILABLE`);
    }
    for (const s of [conflictFind, riskFind, complaintFind, fundraisingFind, annualFind, financialFind]) {
      assert.equal(s.called, false, 'no read may reach the service for an Essentials org');
    }
  } finally {
    await app.close();
  }
});

test('Essentials org is blocked from every governance register write endpoint', async () => {
  const conflictCreate = spy();
  const riskUpdate = spy();
  const complaintDelete = spy();
  const fundraisingCreate = spy();
  const annualUpsert = spy();
  const financialUpsert = spy();
  const app = await buildApp(
    {
      conflictRecord: { create: conflictCreate.fn, findFirst: spy().fn },
      riskRecord: { update: riskUpdate.fn, findFirst: spy().fn },
      complaintRecord: { delete: complaintDelete.fn, findFirst: spy().fn },
      fundraisingRecord: { create: fundraisingCreate.fn, findFirst: spy().fn },
      annualReportReadiness: { upsert: annualUpsert.fn },
      financialControlReview: { upsert: financialUpsert.fn },
    },
    'OWNER',
    activeSubscription('ESSENTIALS'),
  );
  try {
    const writes: { method: 'POST' | 'PATCH' | 'DELETE' | 'PUT'; url: string; payload?: object }[] = [
      { method: 'POST', url: `${PREFIX}/conflicts`, payload: validConflictBody },
      { method: 'PATCH', url: `${PREFIX}/risks/r1`, payload: { title: 'Renamed' } },
      { method: 'DELETE', url: `${PREFIX}/complaints/c1` },
      { method: 'POST', url: `${PREFIX}/fundraising`, payload: validFundraisingBody },
      { method: 'PUT', url: `${PREFIX}/annual-report`, payload: validAnnualBody },
      { method: 'PUT', url: `${PREFIX}/financial-controls`, payload: validFinancialBody },
    ];
    for (const w of writes) {
      const res = await app.inject({
        method: w.method,
        url: w.url,
        headers: { authorization: tokenFor('OWNER') },
        payload: w.payload,
      });
      assert.equal(res.statusCode, 403, `${w.method} ${w.url} must be plan-gated`);
      assert.equal(
        res.json().code,
        'PLAN_FEATURE_UNAVAILABLE',
        `${w.method} ${w.url} must return PLAN_FEATURE_UNAVAILABLE (plan gate before requireAdmin)`,
      );
    }
    for (const s of [conflictCreate, riskUpdate, complaintDelete, fundraisingCreate, annualUpsert, financialUpsert]) {
      assert.equal(s.called, false, 'no write may reach the service for an Essentials org');
    }
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation (route level): malformed bodies -> 400 VALIDATION_ERROR,
// the write is never reached. ADMIN + COMPLETE plan so the only gate left is Zod.
// ─────────────────────────────────────────────────────────────────────────────

test('POST /conflicts rejects malformed body with 400 VALIDATION_ERROR and no write', async () => {
  const create = spy();
  const app = await buildApp({ conflictRecord: { create: create.fn } }, 'ADMIN');
  try {
    // Empty body: missing every required field.
    const empty = await app.inject({
      method: 'POST',
      url: `${PREFIX}/conflicts`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().code, 'VALIDATION_ERROR');

    // Valid required fields but a non-ISO dateDeclared.
    const badDate = await app.inject({
      method: 'POST',
      url: `${PREFIX}/conflicts`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { ...validConflictBody, dateDeclared: '31-12-2026' },
    });
    assert.equal(badDate.statusCode, 400);
    assert.equal(badDate.json().code, 'VALIDATION_ERROR');

    assert.equal(create.called, false, 'conflictRecord.create must not run for an invalid body');
  } finally {
    await app.close();
  }
});

test('POST /risks with out-of-range likelihood returns 400 VALIDATION_ERROR and no write', async () => {
  const create = spy();
  const app = await buildApp({ riskRecord: { create: create.fn } }, 'ADMIN');
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/risks`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { ...validRiskBody, likelihood: 6 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(create.called, false, 'riskRecord.create must not run for likelihood out of 1-5');
  } finally {
    await app.close();
  }
});

test('GET /summary rejects a malformed year query with 400 VALIDATION_ERROR', async () => {
  const count = spy();
  const app = await buildApp(
    {
      conflictRecord: { count: count.fn },
      riskRecord: { count: count.fn },
      complaintRecord: { count: count.fn },
      fundraisingRecord: { count: count.fn },
    },
    'OWNER',
  );
  try {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/summary?year=notanumber`,
      headers: { authorization: tokenFor('OWNER') },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(count.called, false, 'no count may run when the year query is invalid');
  } finally {
    await app.close();
  }
});

test('PUT /annual-report rejects an out-of-range reportingYear and never upserts', async () => {
  const upsert = spy();
  const app = await buildApp({ annualReportReadiness: { upsert: upsert.fn } }, 'ADMIN');
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/annual-report`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 1900 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_ERROR');
    assert.equal(upsert.called, false, 'annualReportReadiness.upsert must not run for an out-of-range year');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth session: unauthenticated requests are rejected by authGuard before any
// service work.
// ─────────────────────────────────────────────────────────────────────────────

test('governance register routes require authentication', async () => {
  const count = spy();
  const app = await buildApp({
    conflictRecord: { count: count.fn, findMany: count.fn },
    riskRecord: { count: count.fn },
    complaintRecord: { count: count.fn },
    fundraisingRecord: { count: count.fn },
  });
  try {
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/summary` });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'UNAUTHORIZED');
    assert.equal(count.called, false, 'no service query may run for an unauthenticated request');
  } finally {
    await app.close();
  }
});
