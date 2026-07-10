import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IRISH_COMPLIANCE_MATRIX_LAST_CHECKED } from '@charitypilot/shared';

// JWT_SECRET is read at import/construction time by utils/jwt; set before imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'compliance-reliability-test-secret';

const [
  { default: Fastify },
  { complianceRoutes },
  { ComplianceService },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('../routes/compliance/index.js'),
  import('../services/compliance.service.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

// A subscription row that satisfies BOTH the route-level subscriptionGuard (status/dates)
// AND the service's getOrganisationComplianceScope (plan).
function activeSubscription(plan = 'ESSENTIALS') {
  return {
    status: 'ACTIVE',
    trialEndsAt: null,
    currentPeriodEnd: new Date(Date.now() + 1_000_000_000),
    plan,
  };
}

function falseProfile() {
  return {
    hasPaidStaff: false,
    hasVolunteers: false,
    raisesFundsFromPublic: false,
    worksWithChildrenOrVulnerableAdults: false,
    processesPersonalData: false,
    operatesPremisesOrEvents: false,
    isPublicSectorBody: false,
    usesDataProcessors: false,
  };
}

function authModels(role: Role, subscription: unknown) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => subscription },
  };
}

// ── route-level harness (Fastify + hand-rolled prisma mock) ──

async function buildComplianceApp(
  prismaOverrides: Record<string, unknown>,
  role: Role = 'ADMIN',
  subscription: unknown = activeSubscription(),
) {
  const app = Fastify({ logger: false });
  let record: Record<string, unknown> | null = null;
  let signoff: Record<string, unknown> | null = null;
  const base: Record<string, any> = {
    ...authModels(role, subscription),
    $queryRaw: async () => [{ id: 'org-1' }],
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1', name: 'Example Charity', rcnNumber: 'RCN-1',
        complexity: 'COMPLEX', conditionalObligationProfile: falseProfile(),
      }),
    },
    governanceStandard: {
      findUnique: async () => ({
        id: 's1', principleId: 'p1', code: '1.1', title: 'Standard', isCore: true,
        isAdditional: false, sortOrder: 1,
        principle: { id: 'p1', number: 1, title: 'Principle', description: '', sortOrder: 1 },
      }),
      findMany: async () => [],
    },
    complianceRecord: {
      findMany: async () => [],
      findUnique: async () => record,
      findUniqueOrThrow: async () => record,
      create: async (args: { data: Record<string, unknown> }) => {
        record = {
          id: 'rec_1', revision: 1, createdAt: new Date(), updatedAt: new Date(),
          standard: { id: 's1' }, updatedBy: { id: 'u1', name: 'Owner' }, ...args.data,
        };
        return record;
      },
      updateMany: async () => ({ count: 1 }),
    },
    complianceSignoff: {
      findUnique: async () => signoff,
      create: async (args: { data: Record<string, unknown> }) => {
        signoff = {
          id: 'so_1', createdAt: new Date(), updatedAt: new Date(), currentApprovalSnapshot: null,
          ...args.data,
        };
        return signoff;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        signoff = { ...signoff, ...args.data, updatedAt: new Date(), currentApprovalSnapshot: null };
        return signoff;
      },
    },
    complianceApprovalSnapshot: { findFirst: async () => null },
    complianceAuditEvent: { create: async () => ({}) },
  };
  for (const [key, value] of Object.entries(prismaOverrides)) {
    base[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(base[key] ?? {}), ...value as Record<string, unknown> }
      : value;
  }
  base.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(base);
  app.decorate('prisma', base as never);
  await app.register(complianceRoutes);
  return app;
}

// ── service-level harness (clone of compliance-service.test.ts buildService) ──

type Call = { name: string; args: unknown };
const codeOf = (err: unknown) => (err as { code?: string })?.code;

function buildService(opts: {
  plan?: string | null; // null => no subscription
  complexity?: string;
  standard?: { id: string; isCore: boolean } | null; // for findUnique
  standards?: Array<{ id: string; code: string; isCore?: boolean; principleId: string; principle: { number: number; title: string } }>;
  records?: Array<{
    standardId: string;
    status: string;
    explanationIfNA?: string | null;
    standard?: { id: string; code: string };
  }>;
  upsertRecordError?: unknown;
} = {}) {
  const calls: Call[] = [];
  const standards = (opts.standards ?? []).map((standard, index) => ({
    isAdditional: false,
    sortOrder: index + 1,
    ...standard,
    principle: { id: standard.principleId, sortOrder: index + 1, ...standard.principle },
  }));
  const records = (opts.records ?? []).map((record, index) => ({
    id: `rec_${index + 1}`, organisationId: 'org_A', reportingYear: 2026, revision: 1,
    actionTaken: null, evidence: null, notes: null, explanationIfNA: null, updatedById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...record,
  }));
  let persistedRecord: Record<string, unknown> | null = null;
  let persistedSignoff: Record<string, unknown> | null = null;
  const prisma: Record<string, any> = {
    $queryRaw: async (...args: unknown[]) => { calls.push({ name: '$queryRaw', args }); return [{ id: 'org_A' }]; },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org_A', name: 'Example Charity', rcnNumber: 'RCN-1',
        complexity: opts.complexity ?? 'SIMPLE',
        conditionalObligationProfile: falseProfile(),
      }),
    },
    subscription: {
      findUnique: async () => (opts.plan === null ? null : { plan: opts.plan ?? 'ESSENTIALS' }),
    },
    governanceStandard: {
      findUnique: async () => {
        if (opts.standard === null) return null;
        return {
          principleId: 'p1', code: '1.1', title: 'Standard', isAdditional: false, sortOrder: 1,
          principle: { id: 'p1', number: 1, title: 'Principle', description: '', sortOrder: 1 },
          ...(opts.standard ?? { id: 's1', isCore: true }),
        };
      },
      findMany: async (args: unknown) => { calls.push({ name: 'governanceStandard.findMany', args }); return standards; },
    },
    complianceRecord: {
      findMany: async (args: unknown) => { calls.push({ name: 'complianceRecord.findMany', args }); return records; },
      findUnique: async (args: unknown) => { calls.push({ name: 'complianceRecord.findUnique', args }); return persistedRecord; },
      findUniqueOrThrow: async () => persistedRecord,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceRecord.create', args });
        if (opts.upsertRecordError) throw opts.upsertRecordError;
        persistedRecord = {
          id: 'rec_1', revision: 1, createdAt: new Date(), updatedAt: new Date(),
          standard: {}, updatedBy: {}, ...args.data,
        };
        return persistedRecord;
      },
      updateMany: async (args: unknown) => { calls.push({ name: 'complianceRecord.updateMany', args }); return { count: 1 }; },
    },
    complianceSignoff: {
      findUnique: async (args: unknown) => { calls.push({ name: 'complianceSignoff.findUnique', args }); return persistedSignoff; },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceSignoff.create', args });
        persistedSignoff = { id: 'so_1', createdAt: new Date(), updatedAt: new Date(), currentApprovalSnapshot: null, ...args.data };
        return persistedSignoff;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceSignoff.update', args });
        persistedSignoff = { ...persistedSignoff, ...args.data, updatedAt: new Date(), currentApprovalSnapshot: null };
        return persistedSignoff;
      },
    },
    complianceApprovalSnapshot: { findFirst: async () => null },
    complianceAuditEvent: { create: async (args: unknown) => { calls.push({ name: 'complianceAuditEvent.create', args }); return {}; } },
    user: { findUnique: async () => ({ name: 'User' }) },
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
    calls.push({ name: '$transaction', args: options });
    return callback(prisma);
  };
  return { service: new ComplianceService(prisma as never), calls };
}

// ── compliance-authz-boundary-1 ──

test('a MEMBER cannot upsert a compliance record (requireAdmin)', async () => {
  let upsertCalled = false;
  const app = await buildComplianceApp(
    {
      governanceStandard: { findUnique: async () => ({ id: 's1', isCore: true }) },
      complianceRecord: { upsert: async () => { upsertCalled = true; return { id: 'rec_1' }; } },
    },
    'MEMBER',
  );
  try {
    const res = await app.inject({
      method: 'PUT', url: '/records/s1',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(upsertCalled, false, 'a MEMBER must not reach complianceRecord.upsert');
  } finally {
    await app.close();
  }
});

// ── compliance-authz-boundary-2 ──

test('a MEMBER cannot update the board sign-off (requireAdmin)', async () => {
  let upsertCalled = false;
  const app = await buildComplianceApp(
    {
      complianceSignoff: { upsert: async () => { upsertCalled = true; return { id: 'so_1' }; } },
    },
    'MEMBER',
  );
  try {
    const res = await app.inject({
      method: 'PUT', url: '/signoff',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { reportingYear: 2026, expectedRevision: 0, status: 'DRAFT' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(upsertCalled, false, 'a MEMBER must not reach complianceSignoff.upsert');
  } finally {
    await app.close();
  }
});

// ── compliance-authz-boundary-3 ──

test('an ADMIN may upsert a compliance record and the board sign-off', async () => {
  const app = await buildComplianceApp(
    {
      governanceStandard: { findUnique: async () => ({ id: 's1', isCore: true }) },
      complianceRecord: {
        upsert: async () => ({ id: 'rec_1', standard: { id: 's1' }, updatedBy: { id: 'u1', name: 'Owner' } }),
      },
      complianceSignoff: {
        upsert: async () => ({
          id: 'so_1', organisationId: 'org-1', reportingYear: 2026, status: 'DRAFT', updatedById: 'u1',
          updatedAt: new Date(), boardMeetingDate: null, minuteReference: null, approvedByName: null,
          approvedByRole: null, approvalNotes: null, approvedAt: null,
        }),
      },
    },
    'ADMIN',
    activeSubscription('COMPLETE'),
  );
  try {
    const record = await app.inject({
      method: 'PUT', url: '/records/s1',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' },
    });
    assert.equal(record.statusCode, 200, 'ADMIN may upsert a compliance record');

    const signoff = await app.inject({
      method: 'PUT', url: '/signoff',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 2026, expectedRevision: 0, status: 'DRAFT' },
    });
    assert.equal(signoff.statusCode, 200, 'ADMIN may upsert the board sign-off');
  } finally {
    await app.close();
  }
});

test('GET /approval-readiness returns readiness for authenticated subscribed members and validates year', async () => {
  const records = [
    {
      id: 'rec_1',
      organisationId: 'org-1',
      standardId: 's1',
      reportingYear: 2026,
      revision: 1,
      status: 'EXPLAIN',
      actionTaken: null,
      evidence: null,
      notes: null,
      explanationIfNA: '',
      updatedById: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      standard: { id: 's1', code: '1.1', principle: {} },
      updatedBy: null,
    },
  ];
  const app = await buildComplianceApp(
    {
      governanceStandard: { findMany: async () => [{
        id: 's1', principleId: 'p1', code: '1.1', title: 'Standard', isCore: true,
        isAdditional: false, sortOrder: 1,
        principle: { id: 'p1', number: 1, title: 'Principle', description: '', sortOrder: 1 },
      }] },
      complianceRecord: { findMany: async () => records },
    },
    'MEMBER',
    activeSubscription('COMPLETE'),
  );
  try {
    const ok = await app.inject({
      method: 'GET',
      url: '/approval-readiness?year=2026',
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().data, {
      ready: false,
      evidenceHash: ok.json().data.evidenceHash,
      missingRecords: [],
      missingEvidence: [],
      missingExplanations: [{ standardId: 's1', standardCode: '1.1', status: 'EXPLAIN' }],
      profileIssues: [],
      conditionalReviewItems: [],
      matrixReviewItems: ok.json().data.matrixReviewItems,
      matrixLastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
    });
    assert.ok(ok.json().data.matrixReviewItems.length > 0);

    const badYear = await app.inject({
      method: 'GET',
      url: '/approval-readiness?year=not-a-year',
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(badYear.statusCode, 400);
    assert.equal(badYear.json().code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }
});

// ── compliance-auth-session-4 ──

test('compliance routes require authentication', async () => {
  let queried = false;
  const throwingModel = new Proxy(
    {},
    { get: () => async () => { queried = true; throw new Error('prisma must not be queried'); } },
  );
  const app = await buildComplianceApp({
    governancePrinciple: throwingModel,
    governanceStandard: throwingModel,
    complianceRecord: throwingModel,
    complianceSignoff: throwingModel,
    organisation: throwingModel,
  });
  try {
    const routes = [
      { method: 'GET' as const, url: '/principles' },
      { method: 'GET' as const, url: '/records?year=2026' },
      { method: 'PUT' as const, url: '/records/s1', payload: { reportingYear: 2026, status: 'COMPLIANT' } },
      { method: 'GET' as const, url: '/signoff?year=2026' },
      { method: 'PUT' as const, url: '/signoff', payload: { reportingYear: 2026, status: 'DRAFT' } },
    ];
    for (const route of routes) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} must require auth`);
      assert.equal(res.json().code, 'UNAUTHORIZED');
    }
    assert.equal(queried, false, 'no compliance prisma query may run for an unauthenticated request');
  } finally {
    await app.close();
  }
});

// ── compliance-plan-gating-5 ──

test('compliance writes are refused (and not persisted) without a subscription', async () => {
  const { service, calls } = buildService({ plan: null });
  await assert.rejects(
    () => service.upsertRecord('org_1', 's1', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' } as never),
    (e: unknown) => codeOf(e) === 'NO_SUBSCRIPTION',
  );
  assert.equal(
    calls.some((c) => c.name === 'complianceRecord.create'),
    false,
    'no record may be written without a subscription',
  );
  await assert.rejects(() => service.getSummary('org_1', 2026), (e: unknown) => codeOf(e) === 'NO_SUBSCRIPTION');
  await assert.rejects(() => service.getRecord('org_1', 's1', 2026), (e: unknown) => codeOf(e) === 'NO_SUBSCRIPTION');
});

// ── compliance-plan-gating-8 ──

test('getRecord refuses an out-of-plan standard for an Essentials org', async () => {
  const { service, calls } = buildService({
    plan: 'ESSENTIALS',
    complexity: 'SIMPLE',
    standard: { id: 's_extra', isCore: false },
  });
  await assert.rejects(
    () => service.getRecord('org_1', 's_extra', 2026),
    (e: unknown) => codeOf(e) === 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
  );
  assert.equal(
    calls.some((c) => c.name === 'complianceRecord.findUnique'),
    false,
    'an out-of-plan single record must not be read',
  );
});

// ── compliance-tenant-isolation-9 ──

test('upsertRecord scopes the composite key and create payload to the caller organisation', async () => {
  const { service, calls } = buildService({
    plan: 'COMPLETE',
    complexity: 'COMPLEX',
    standard: { id: 's1', isCore: true },
  });
  await service.upsertRecord('org_A', 's1', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' } as never);
  const create = calls.find((c) => c.name === 'complianceRecord.create');
  assert.ok(create, 'create should run for an in-plan standard');
  const args = create!.args as { data: { organisationId: string; updatedById: string } };
  assert.equal(args.data.organisationId, 'org_A');
  assert.equal(args.data.updatedById, 'u1');
});

// ── compliance-tenant-isolation-10 ──

test('upsertRecord serializes tenant writes behind an organisation row lock', async () => {
  const { service, calls } = buildService({
    plan: 'COMPLETE',
    complexity: 'COMPLEX',
    standard: { id: 's1', isCore: true },
  });

  await service.upsertRecord('org_A', 's1', 'u1', {
    reportingYear: 2026,
    expectedRevision: 0,
    status: 'COMPLIANT',
    evidence: 'Board-approved policy pack',
  } as never);

  assert.ok(calls.find((c) => c.name === '$queryRaw'), 'the organisation row must be locked before writing');
  const transaction = calls.find((c) => c.name === '$transaction');
  assert.deepEqual(transaction?.args, { isolationLevel: 'Serializable' });
});

test('compliance reads are scoped to the caller organisation', async () => {
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX' });
  await service.getRecords('org_A', 2026);
  await service.getSummary('org_A', 2026);
  await service.getRecord('org_A', 's1', 2026);

  const findManyCalls = calls.filter((c) => c.name === 'complianceRecord.findMany');
  assert.ok(findManyCalls.length >= 2, 'getRecords and getSummary both query complianceRecord.findMany');
  for (const call of findManyCalls) {
    assert.equal((call.args as { where: { organisationId: string } }).where.organisationId, 'org_A');
  }

  const findUnique = calls.find((c) => c.name === 'complianceRecord.findUnique');
  assert.ok(findUnique, 'getRecord queries complianceRecord.findUnique');
  const where = (findUnique!.args as {
    where: { organisationId_standardId_reportingYear: { organisationId: string } };
  }).where;
  assert.equal(where.organisationId_standardId_reportingYear.organisationId, 'org_A');
});

// ── compliance-tenant-isolation-11 ──

test('upsertSignoff scopes the composite key to the caller organisation', async () => {
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX' });
  await service.upsertSignoff('org_A', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'DRAFT' } as never);
  const create = calls.find((c) => c.name === 'complianceSignoff.create');
  assert.ok(create, 'upsertSignoff should create the tenant-scoped signoff');
  const args = create!.args as { data: { organisationId: string; updatedById: string } };
  assert.equal(args.data.organisationId, 'org_A');
  assert.equal(args.data.updatedById, 'u1');
});

test('upsertSignoff rejects APPROVED when approval readiness is incomplete and does not write', async () => {
  const { service, calls } = buildService({
    plan: 'COMPLETE',
    complexity: 'COMPLEX',
    standards: [{ id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } }],
    records: [
      { standardId: 's1', status: 'NOT_APPLICABLE', explanationIfNA: ' ', standard: { id: 's1', code: '1.1' } },
    ],
  });

  await assert.rejects(
    () =>
      service.upsertSignoff('org_A', 'u1', {
        reportingYear: 2026,
        expectedRevision: 0,
        expectedEvidenceHash: 'a'.repeat(64),
        status: 'APPROVED',
        boardMeetingDate: '2026-02-01',
        minuteReference: 'BM-2026-02',
        approvedByName: 'Chair',
      } as never),
    (e: unknown) => codeOf(e) === 'COMPLIANCE_APPROVAL_INCOMPLETE',
  );
  assert.equal(
    calls.some((c) => c.name === 'complianceSignoff.create'),
    false,
    'incomplete readiness must not write the signoff',
  );
});

test('upsertSignoff allows DRAFT and BOARD_REVIEW when approval readiness is incomplete', async () => {
  for (const status of ['DRAFT', 'BOARD_REVIEW'] as const) {
    const { service, calls } = buildService({
      plan: 'COMPLETE',
      complexity: 'COMPLEX',
      records: [
        { standardId: 's1', status: 'EXPLAIN', explanationIfNA: '', standard: { id: 's1', code: '1.1' } },
      ],
    });

    await service.upsertSignoff('org_A', 'u1', { reportingYear: 2026, expectedRevision: 0, status } as never);

    assert.ok(
      calls.find((c) => c.name === 'complianceSignoff.create'),
      `${status} should remain editable without readiness completeness`,
    );
    assert.equal(
      calls.some((c) => c.name === 'complianceRecord.findMany'),
      false,
      `${status} should not evaluate approval readiness`,
    );
  }
});

// ── compliance-input-validation-12 ──

test('PUT /records rejects an invalid body before writing', async () => {
  let upsertCalled = false;
  const app = await buildComplianceApp(
    {
      governanceStandard: { findUnique: async () => ({ id: 's1', isCore: true }) },
      complianceRecord: { upsert: async () => { upsertCalled = true; return { id: 'rec_1' }; } },
    },
    'ADMIN',
  );
  try {
    const tooLow = await app.inject({
      method: 'PUT', url: '/records/s1',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 1999, expectedRevision: 0 }, // below min 2018
    });
    assert.equal(tooLow.statusCode, 400);
    assert.equal(tooLow.json().code, 'VALIDATION_ERROR');

    const badStatus = await app.inject({
      method: 'PUT', url: '/records/s1',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 2026, expectedRevision: 0, status: 'BOGUS' }, // not a status enum
    });
    assert.equal(badStatus.statusCode, 400);
    assert.equal(badStatus.json().code, 'VALIDATION_ERROR');

    assert.equal(upsertCalled, false, 'an invalid body must not reach complianceRecord.upsert');
  } finally {
    await app.close();
  }
});

// ── compliance-input-validation-13 ──

test('PUT /signoff requires approval evidence when status is APPROVED', async () => {
  let upsertCalled = false;
  const app = await buildComplianceApp(
    {
      complianceSignoff: { upsert: async () => { upsertCalled = true; return { id: 'so_1' }; } },
    },
    'ADMIN',
  );
  try {
    const missingEvidence = await app.inject({
      method: 'PUT', url: '/signoff',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { reportingYear: 2026, expectedRevision: 0, expectedEvidenceHash: 'a'.repeat(64), status: 'APPROVED' }, // missing boardMeetingDate/minuteReference/approvedByName
    });
    assert.equal(missingEvidence.statusCode, 400);
    assert.equal(missingEvidence.json().code, 'VALIDATION_ERROR');

    const badDate = await app.inject({
      method: 'PUT', url: '/signoff',
      headers: { authorization: tokenFor('ADMIN') },
      payload: {
        reportingYear: 2026,
        expectedRevision: 0,
        expectedEvidenceHash: 'a'.repeat(64),
        status: 'APPROVED',
        boardMeetingDate: 'not-a-date',
        minuteReference: 'M-1',
        approvedByName: 'Chair',
      },
    });
    assert.equal(badDate.statusCode, 400);
    assert.equal(badDate.json().code, 'VALIDATION_ERROR');

    assert.equal(upsertCalled, false, 'an invalid sign-off body must not reach complianceSignoff.upsert');
  } finally {
    await app.close();
  }
});

// ── compliance-input-validation-14 ──

test('compliance year-scoped reads reject a missing or invalid year', async () => {
  const app = await buildComplianceApp({
    complianceRecord: {
      findMany: async () => { throw new Error('must not query records for an invalid year'); },
    },
  });
  try {
    const missing = await app.inject({
      method: 'GET', url: '/records',
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().code, 'VALIDATION_ERROR');

    const nonNumeric = await app.inject({
      method: 'GET', url: '/summary?year=abcd',
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(nonNumeric.statusCode, 400);
    assert.equal(nonNumeric.json().code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }
});

// ── compliance-input-validation-15 ──

test('GET /principles/:id returns 404 for an unknown principle', async () => {
  const app = await buildComplianceApp({
    governancePrinciple: { findUnique: async () => null },
  });
  try {
    const res = await app.inject({
      method: 'GET', url: '/principles/does-not-exist',
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'PRINCIPLE_NOT_FOUND');
  } finally {
    await app.close();
  }
});

// ── compliance-plan-gating-16 ──

test('compliance routes are blocked when the subscription is not in good standing', async () => {
  const past = new Date(Date.now() - 1_000_000);
  const longPast = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // beyond the past-due grace window
  const cases: Array<{ subscription: unknown; code: string }> = [
    { subscription: { status: 'TRIALING', trialEndsAt: past, currentPeriodEnd: null, plan: 'ESSENTIALS' }, code: 'TRIAL_EXPIRED' },
    { subscription: { status: 'PAST_DUE', trialEndsAt: null, currentPeriodEnd: longPast, plan: 'ESSENTIALS' }, code: 'PAST_DUE_GRACE_EXPIRED' },
    { subscription: { status: 'CANCELED', trialEndsAt: null, currentPeriodEnd: null, plan: 'ESSENTIALS' }, code: 'SUBSCRIPTION_INACTIVE' },
    { subscription: null, code: 'NO_SUBSCRIPTION' },
  ];
  for (const { subscription, code } of cases) {
    const app = await buildComplianceApp(
      {
        complianceRecord: { findMany: async () => { throw new Error('subscriptionGuard must block before the service'); } },
        organisation: { findUniqueOrThrow: async () => { throw new Error('subscriptionGuard must block before the service'); } },
      },
      'ADMIN',
      subscription,
    );
    try {
      const res = await app.inject({
        method: 'GET', url: '/records?year=2026',
        headers: { authorization: tokenFor('ADMIN') },
      });
      assert.equal(res.statusCode, 403, `expected 403 for ${code}`);
      assert.equal(res.json().code, code);
    } finally {
      await app.close();
    }
  }
});
