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

test('Members cannot read sensitive registers or their summary through list or detail routes', async () => {
  const app = await buildApp({}, 'MEMBER');
  try {
    for (const path of [
      '/summary?year=2026',
      '/conflicts',
      '/conflicts/sensitive-record',
      '/complaints',
      '/change-audit',
      '/complaints/sensitive-record',
      '/complaints/sensitive-record/resolution-evidence',
      '/complaints/sensitive-record/holds',
      '/complaints/policy-revisions',
      '/complaints/removed',
      '/complaints/sensitive-record/retention-assessment',
    ]) {
      const response = await app.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: { authorization: tokenFor('MEMBER') } });
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().code, 'FORBIDDEN', path);
    }
  } finally {
    await app.close();
  }
});

test('Admin connector cannot directly read excluded control histories or record verification', async () => {
  let reads = 0;
  const app = await buildApp({
    authSession: { findFirst: async () => ({
      id: 'sess-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
    riskChangeAudit: { findMany: async () => { reads += 1; return []; } },
    riskControlVerification: { findMany: async () => { reads += 1; return []; } },
  });
  try {
    for (const [method, path] of [
      ['GET', '/risks/audit'],
      ['GET', '/risks/control-verifications'],
      ['GET', '/risks/control-review-attention'],
      ['GET', '/risks/risk-1/control-verifications'],
      ['GET', '/change-audit'],
      ['POST', '/risks/risk-1/control-verifications'],
      ['GET', '/complaints/complaint-1/resolution-evidence'],
      ['GET', '/complaints/complaint-1/holds'],
      ['POST', '/complaints/complaint-1/holds'],
      ['POST', '/complaints/complaint-1/resolution-evidence'],
      ['GET', '/complaints/policy-revisions'],
      ['GET', '/complaints/removed'],
      ['POST', '/complaints/complaint-1/remove'],
      ['POST', '/complaints/complaint-1/restore'],
      ['POST', '/complaints/policy-revisions'],
      ['GET', '/complaints/complaint-1/retention-assessment'],
    ]) {
      const response = await app.inject({ method: method as 'GET' | 'POST',
        url: `${PREFIX}${path}`, headers: { authorization: tokenFor('ADMIN') } });
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    }
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('register action history is tenant-scoped and limited to Owner/Admin', async () => {
  const reads: unknown[] = [];
  const models = { governanceRegisterChangeAudit: { findMany: async (args: unknown) => { reads.push(args); return []; } } };
  const member = await buildApp(models, 'MEMBER');
  try {
    const response = await member.inject({ method: 'GET', url: `${PREFIX}/change-audit`, headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(response.statusCode, 403);
    assert.equal(reads.length, 0);
  } finally { await member.close(); }
  const admin = await buildApp(models);
  try {
    const response = await admin.inject({ method: 'GET', url: `${PREFIX}/change-audit`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { items: [], nextCursor: null });
    assert.deepEqual(reads, [{
      where: { organisationId: 'org-1' },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51,
    }]);
  } finally { await admin.close(); }
});

test('detailed register changes page past 100 tied-time events within one charity', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const events = Array.from({ length: 202 }, (_, index) => ({
    id: `register-audit-${String(index).padStart(3, '0')}`, organisationId: 'org-1',
    recordKind: 'COMPLAINT', recordId: 'complaint-1', action: 'UPDATE', occurredAt,
  }));
  events.push({ id: 'foreign-register-audit', organisationId: 'org-2',
    recordKind: 'COMPLAINT', recordId: 'foreign-complaint', action: 'UPDATE', occurredAt });
  const reads: Array<{ where: Record<string, unknown>; take: number; orderBy: unknown }> = [];
  const models = { governanceRegisterChangeAudit: {
    findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      events.find((event) => event.id === where.id && event.organisationId === where.organisationId) ?? null,
    findMany: async (args: { where: Record<string, unknown>; take: number; orderBy: unknown }) => {
      reads.push(args);
      const anchor = (args.where.OR as Array<Record<string, unknown>> | undefined)?.[1]?.id as { lt: string } | undefined;
      return events.filter((event) => event.organisationId === args.where.organisationId &&
        (!anchor || event.id < anchor.lt)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, args.take);
    },
  } };
  const admin = await buildApp(models);
  try {
    const collected: string[] = [];
    let before: string | null = null;
    do {
      const response: Awaited<ReturnType<typeof admin.inject>> = await admin.inject({ method: 'GET',
        url: `${PREFIX}/change-audit${before ? `?before=${before}` : ''}`,
        headers: { authorization: tokenFor('ADMIN') } });
      assert.equal(response.statusCode, 200);
      const page = response.json().data as { items: Array<{ id: string }>; nextCursor: string | null };
      collected.push(...page.items.map((event) => event.id));
      before = page.nextCursor;
    } while (before);
    assert.equal(collected.length, 202);
    assert.equal(new Set(collected).size, 202);
    assert.equal(reads.length, 5);
    assert.ok(reads.every((read) => read.take === 51 && read.where.organisationId === 'org-1'));
    assert.deepEqual(reads[0].orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
    const foreign = await admin.inject({ method: 'GET', url: `${PREFIX}/change-audit?before=foreign-register-audit`,
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    const invalid = await admin.inject({ method: 'GET', url: `${PREFIX}/change-audit?before=bad%40cursor`,
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(reads.length, 5);
  } finally { await admin.close(); }
});

test('Member register reads retain governance status but omit personal and free-text fields', async () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  const risk = { id: 'risk-1', organisationId: 'org-1', title: 'Private trustee risk', category: 'GOVERNANCE',
    description: 'private risk description', likelihood: 3, impact: 4,
    mitigation: 'private mitigation', owner: 'Private person', reviewDate: now,
    status: 'OPEN', boardMinuteReference: 'Private minute 1', createdAt: now, updatedAt: now };
  const fundraising = { id: 'fund-1', organisationId: 'org-1', name: 'Private donor appeal',
    activityType: 'Appeal', startDate: now, endDate: null, publicFacing: true,
    thirdPartyFundraiser: 'Private fundraiser', controls: 'private controls',
    complaintsReceived: false, reviewOutcome: 'private review', status: 'OPEN',
    boardMinuteReference: 'Private minute 2', createdAt: now, updatedAt: now };
  const annual = { id: 'annual-1', organisationId: 'org-1', reportingYear: 2026,
    activitiesNarrative: 'private activities', publicBenefitStatement: 'private benefit',
    beneficiariesSummary: 'private beneficiaries', financialStatementsApproved: true,
    annualReportUploaded: false, trusteeDetailsReviewed: true, fundraisingReviewed: true,
    complaintsReviewed: false, boardApprovalDate: null, filingStatus: 'NOT_STARTED',
    filedDate: null, notes: 'private annual note', updatedAt: now };
  const financial = { id: 'financial-1', organisationId: 'org-1', reportingYear: 2026,
    bankReconciliationsReviewed: true, dualAuthorisation: true, budgetApproved: true,
    managementAccountsReviewed: true, reservesReviewed: false,
    restrictedFundsReviewed: false, assetsInsuranceReviewed: false,
    payrollControlsReviewed: false, fundraisingControlsReviewed: false,
    reviewedBy: 'Private reviewer', reviewDate: now, minuteReference: 'Private minute 3',
    actions: 'private financial actions', updatedAt: now };
  const registerReads: Array<{ kind: string; args: { where: Record<string, unknown>; select?: Record<string, boolean> } }> = [];
  const readinessReads: Array<{ kind: string; args: { where: Record<string, unknown>; select?: Record<string, boolean> } }> = [];
  const models = {
    riskRecord: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        registerReads.push({ kind: 'risk-list', args }); return [risk];
      },
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        registerReads.push({ kind: 'risk-detail', args }); return risk;
      },
    },
    fundraisingRecord: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        registerReads.push({ kind: 'fundraising-list', args }); return [fundraising];
      },
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        registerReads.push({ kind: 'fundraising-detail', args }); return fundraising;
      },
    },
    annualReportReadiness: { findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      readinessReads.push({ kind: 'annual', args }); return annual;
    } },
    financialControlReview: { findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      readinessReads.push({ kind: 'financial', args }); return financial;
    } },
  };
  const paths = ['/risks', '/risks/risk-1', '/fundraising', '/fundraising/fund-1',
    '/annual-report?year=2026', '/financial-controls?year=2026'];
  for (const role of ['MEMBER', 'ADMIN'] as const) {
    registerReads.length = 0;
    readinessReads.length = 0;
    const app = await buildApp(models, role);
    try {
      for (const path of paths) {
        const result = await app.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: { authorization: tokenFor(role) } });
        assert.equal(result.statusCode, 200, path);
        const body = result.body;
        assert.match(body, /risk-1|fund-1|financialStatementsApproved|bankReconciliationsReviewed/, path);
        if (role === 'MEMBER') {
          assert.doesNotMatch(body, /Private person|Private fundraiser|Private reviewer|private /i, path);
        } else if (path.startsWith('/risks') || path.startsWith('/fundraising') || path.startsWith('/annual') || path.startsWith('/financial')) {
          assert.match(body, /Private|private/, path);
        }
      }
      assert.deepEqual(registerReads.map((read) => read.kind), [
        'risk-list', 'risk-detail', 'fundraising-list', 'fundraising-detail',
      ]);
      for (const { kind, args } of registerReads) {
        assert.equal(args.where.organisationId, 'org-1');
        if (kind.endsWith('detail')) assert.equal(args.where.id, kind.startsWith('risk') ? 'risk-1' : 'fund-1');
        if (role === 'MEMBER') {
          assert.ok(args.select, `${kind} must select only the Member field set`);
          for (const field of kind.startsWith('risk')
            ? ['title', 'description', 'mitigation', 'owner', 'boardMinuteReference']
            : ['name', 'thirdPartyFundraiser', 'controls', 'reviewOutcome', 'boardMinuteReference']) {
            assert.equal(args.select[field], undefined, `${kind} must not load ${field}`);
          }
        } else {
          assert.equal(args.select, undefined, `${kind} Admin read must remain complete`);
        }
      }
      assert.deepEqual(readinessReads.map((read) => read.kind), ['annual', 'financial']);
      for (const { kind, args } of readinessReads) {
        assert.deepEqual(args.where, {
          organisationId_reportingYear: { organisationId: 'org-1', reportingYear: 2026 },
        });
        if (role === 'MEMBER') {
          assert.ok(args.select, `${kind} must select only the Member field set`);
          for (const field of kind === 'annual'
            ? ['activitiesNarrative', 'publicBenefitStatement', 'beneficiariesSummary', 'notes']
            : ['reviewedBy', 'minuteReference', 'actions']) {
            assert.equal(args.select[field], undefined, `${kind} must not load ${field}`);
          }
        } else {
          assert.equal(args.select, undefined, `${kind} Admin read must remain complete`);
        }
      }
    } finally { await app.close(); }
  }
});

test('risk change history and control evidence are scoped and unavailable to Members', async () => {
  const readWhere: unknown[] = [];
  const models = {
    riskChangeAudit: { findMany: async (args: { where: unknown }) => { readWhere.push(args.where); return []; } },
    riskControlVerification: { findMany: async (args: { where: unknown }) => { readWhere.push(args.where); return []; } },
  };
  const memberApp = await buildApp(models, 'MEMBER');
  try {
    for (const path of ['/risks/audit', '/risks/control-verifications']) {
      const response = await memberApp.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: { authorization: tokenFor('MEMBER') } });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(readWhere.length, 0);
  } finally { await memberApp.close(); }
  const adminApp = await buildApp(models, 'ADMIN');
  try {
    for (const path of ['/risks/audit', '/risks/control-verifications']) {
      const response = await adminApp.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: { authorization: tokenFor('ADMIN') } });
      assert.equal(response.statusCode, 200);
    }
    assert.deepEqual(readWhere, [{ organisationId: 'org-1' }, { organisationId: 'org-1' }]);
  } finally { await adminApp.close(); }
});

test('detailed risk changes page past 100 tied-time events without crossing a charity cursor', async () => {
  const occurredAt = new Date('2026-09-29T10:00:00.000Z');
  const events = Array.from({ length: 202 }, (_, index) => ({
    id: `risk-audit-${String(index).padStart(3, '0')}`, organisationId: 'org-1', riskId: 'risk-1',
    action: 'UPDATE', occurredAt,
  }));
  events.push({ id: 'foreign-risk-audit', organisationId: 'org-2', riskId: 'foreign-risk',
    action: 'UPDATE', occurredAt });
  const reads: Array<{ where: Record<string, unknown>; take: number; orderBy: unknown }> = [];
  const models = {
    riskChangeAudit: {
      findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
        events.find((event) => event.id === where.id && event.organisationId === where.organisationId) ?? null,
      findMany: async (args: { where: Record<string, unknown>; take: number; orderBy: unknown }) => {
        reads.push(args);
        const anchor = (args.where.OR as Array<Record<string, unknown>> | undefined)?.[1]?.id as { lt: string } | undefined;
        return events.filter((event) => event.organisationId === args.where.organisationId &&
          (!anchor || event.id < anchor.lt)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, args.take);
      },
    },
  };
  const member = await buildApp(models, 'MEMBER');
  try {
    const denied = await member.inject({ method: 'GET', url: `${PREFIX}/risks/audit?before=risk-audit-100`,
      headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(denied.statusCode, 403);
    assert.equal(reads.length, 0);
  } finally { await member.close(); }

  const admin = await buildApp(models);
  try {
    const collected: string[] = [];
    let before: string | null = null;
    do {
      const response: Awaited<ReturnType<typeof admin.inject>> = await admin.inject({ method: 'GET',
        url: `${PREFIX}/risks/audit${before ? `?before=${before}` : ''}`,
        headers: { authorization: tokenFor('ADMIN') } });
      assert.equal(response.statusCode, 200);
      const page = response.json().data as { items: Array<{ id: string }>; nextCursor: string | null };
      collected.push(...page.items.map((event) => event.id));
      before = page.nextCursor;
    } while (before);
    assert.equal(collected.length, 202);
    assert.equal(new Set(collected).size, 202);
    assert.equal(reads.length, 5);
    assert.ok(reads.every((read) => read.take === 51 && read.where.organisationId === 'org-1'));
    assert.deepEqual(reads[0].orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
    const foreign = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/audit?before=foreign-risk-audit`,
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(foreign.statusCode, 404);
    const invalid = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/audit?before=bad%40cursor`,
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(reads.length, 5);
  } finally { await admin.close(); }
});

test('risk-specific control history pages all retained claims without crossing risk or tenant boundaries', async () => {
  const reads: Array<{ where: Record<string, unknown>; take?: number }> = [];
  const events = Array.from({ length: 52 }, (_, index) => ({
    id: `claim-${index}`, organisationId: 'org-1', riskId: 'risk-1', sequence: 52 - index,
    state: 'VERIFIED', controlReference: index === 0 ? 'C2' : 'C1', occurredAt: new Date('2026-09-29T10:00:00.000Z'),
  }));
  const models = {
    riskRecord: { findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
      where.id === 'risk-1' && where.organisationId === 'org-1'
        ? { id: 'risk-1', revision: 4 } : null },
    riskControlVerification: {
      findFirst: async ({ where }: { where: { id: string; riskId: string; organisationId: string; controlReference?: string } }) =>
        events.find((event) => event.id === where.id && event.riskId === where.riskId &&
          event.organisationId === where.organisationId && (!where.controlReference || event.controlReference === where.controlReference)) ?? null,
      findMany: async (args: { where: { organisationId: string; riskId: string; controlReference?: string; sequence?: { lt: number } }; take: number }) => {
        reads.push(args);
        return events.filter((event) => event.organisationId === args.where.organisationId &&
          event.riskId === args.where.riskId && (!args.where.controlReference || event.controlReference === args.where.controlReference) &&
          (!args.where.sequence || event.sequence < args.where.sequence.lt))
          .slice(0, args.take);
      },
    },
  };
  const member = await buildApp(models, 'MEMBER');
  try {
    const response = await member.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications`, headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(response.statusCode, 403);
    assert.equal(reads.length, 0);
  } finally { await member.close(); }

  const admin = await buildApp(models);
  try {
    const first = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.riskRevision, 4);
    assert.equal(first.json().data.events.length, 50);
    assert.equal(first.json().data.nextCursor, 'claim-49');
    const older = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?before=claim-49`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(older.statusCode, 200);
    assert.deepEqual(older.json().data.events.map((event: { id: string }) => event.id), ['claim-50', 'claim-51']);
    assert.equal(older.json().data.nextCursor, null);
    assert.deepEqual(reads.map((args) => args.where), [
      { organisationId: 'org-1', riskId: 'risk-1' },
      { organisationId: 'org-1', riskId: 'risk-1', sequence: { lt: 3 } },
    ]);

    const filtered = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?controlReference=C1`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().data.events.length, 50);
    assert.equal(filtered.json().data.events[0].id, 'claim-1');
    assert.equal(filtered.json().data.nextCursor, 'claim-50');
    const filteredOlder = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?controlReference=C1&before=claim-50`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(filteredOlder.statusCode, 200);
    assert.deepEqual(filteredOlder.json().data.events.map((event: { id: string }) => event.id), ['claim-51']);
    assert.deepEqual(reads.slice(2).map((args) => args.where), [
      { organisationId: 'org-1', riskId: 'risk-1', controlReference: 'C1' },
      { organisationId: 'org-1', riskId: 'risk-1', controlReference: 'C1', sequence: { lt: 2 } },
    ]);

    const wrongRisk = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-2/control-verifications?before=claim-49`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(wrongRisk.statusCode, 404);
    const wrongCursor = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?before=other-tenant`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(wrongCursor.statusCode, 404);
    const wrongReference = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?controlReference=other&before=claim-49`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(wrongReference.statusCode, 404);
    const malformed = await admin.inject({ method: 'GET', url: `${PREFIX}/risks/risk-1/control-verifications?before=%20`, headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(reads.length, 4);
  } finally { await admin.close(); }
});

test('charity-wide control review attention is Admin-only, tenant-scoped and paged', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const rows = Array.from({ length: 51 }, (_, index) => ({
    claimId: `claim-${index}`, riskId: `risk-${index}`, controlReference: `C${index}`,
    riskRevision: index === 0 ? null : 1, currentRiskRevision: 2,
  }));
  const models = {
    riskControlVerification: {
      findFirst: async ({ where }: { where: { id: string; organisationId: string } }) =>
        where.id === 'claim-49' && where.organisationId === 'org-1'
          ? { riskId: 'risk-49', controlReference: 'C49' } : null,
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join('?'), values });
      return values[2] === null ? rows : [rows[50]];
    },
  };
  const member = await buildApp(models, 'MEMBER');
  try {
    const response = await member.inject({
      method: 'GET', url: `${PREFIX}/risks/control-review-attention`,
      headers: { authorization: tokenFor('MEMBER') },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(queries.length, 0);
  } finally { await member.close(); }

  const admin = await buildApp(models);
  try {
    const first = await admin.inject({
      method: 'GET', url: `${PREFIX}/risks/control-review-attention`,
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.items.length, 50);
    assert.equal(first.json().data.nextCursor, 'claim-49');
    assert.match(queries[0].sql, /DISTINCT ON \(v\."riskId", v\."controlReference"\)/);
    assert.match(queries[0].sql, /v\."organisationId" = \?/);
    assert.match(queries[0].sql, /risk\."organisationId" = \?/);
    assert.match(queries[0].sql, /latest\."state" = 'VERIFIED'/);
    assert.match(queries[0].sql, /IS DISTINCT FROM risk\."revision"/);
    assert.deepEqual(queries[0].values.slice(0, 2), ['org-1', 'org-1']);

    const next = await admin.inject({
      method: 'GET', url: `${PREFIX}/risks/control-review-attention?after=claim-49`,
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(next.json().data.items.map((row: { claimId: string }) => row.claimId), ['claim-50']);
    assert.equal(next.json().data.nextCursor, null);
    assert.deepEqual(queries[1].values, ['org-1', 'org-1', 'risk-49', 'risk-49', 'C49']);

    const wrongTenant = await admin.inject({
      method: 'GET', url: `${PREFIX}/risks/control-review-attention?after=other-tenant`,
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(wrongTenant.statusCode, 404);
    assert.equal(queries.length, 2);
    const malformed = await admin.inject({
      method: 'GET', url: `${PREFIX}/risks/control-review-attention?after=%20`,
      headers: { authorization: tokenFor('ADMIN') },
    });
    assert.equal(malformed.statusCode, 400);
  } finally { await admin.close(); }
});

test('a verified risk control requires dated evidence and records the authenticated actor', async () => {
  const writes: unknown[] = [];
  const transaction = {
    $queryRaw: async () => [{ id: 'risk-1', revision: 3 }],
    riskControlVerification: {
      create: async (args: unknown) => { writes.push(args); return { id: 'verification-1' }; },
    },
  };
  const app = await buildApp({
    ...transaction,
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  });
  try {
    const invalid = await app.inject({
      method: 'POST', url: `${PREFIX}/risks/risk-1/control-verifications`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: { state: 'VERIFIED', controlReference: 'admin-email', reason: 'Checked the fix against the release.' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(writes.length, 0);
    const recorded = await app.inject({
      method: 'POST', url: `${PREFIX}/risks/risk-1/control-verifications`,
      headers: { authorization: tokenFor('ADMIN') },
      payload: {
        state: 'VERIFIED', controlReference: 'admin-email',
        verifiedAt: '2026-09-20T12:00:00.000Z', evidenceReference: 'controlled-evidence-42',
        affectedRelease: 'release-42', reason: 'Verified on the affected release using retained evidence.',
      },
    });
    assert.equal(recorded.statusCode, 201);
    assert.deepEqual((writes[0] as { data: { organisationId: string; actorUserId: string; riskId: string } }).data,
      {
        organisationId: 'org-1', riskId: 'risk-1', actorUserId: 'u1',
        controlReference: 'admin-email', state: 'VERIFIED',
        verifiedAt: new Date('2026-09-20T12:00:00.000Z'),
        riskRevision: 3,
        evidenceReference: 'controlled-evidence-42', affectedRelease: 'release-42',
        reason: 'Verified on the affected release using retained evidence.',
      });
  } finally { await app.close(); }
});

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
      const a = args as { create: { organisationId: string; reportingYear: number } };
      if (name === 'annualReportReadiness') {
        return {
          id: 'annual-1',
          organisationId: a.create.organisationId,
          reportingYear: a.create.reportingYear,
          activitiesNarrative: null,
          publicBenefitStatement: null,
          beneficiariesSummary: null,
          financialStatementsApproved: false,
          annualReportUploaded: false,
          trusteeDetailsReviewed: false,
          fundraisingReviewed: false,
          complaintsReviewed: false,
          boardApprovalDate: null,
          filingStatus: 'NOT_STARTED',
          filedDate: null,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
      }
      return { id: 'financial-1', organisationId: a.create.organisationId, reportingYear: a.create.reportingYear };
    },
  });
  const transaction = {
    conflictRecord: registerModel('conflictRecord'),
    riskRecord: registerModel('riskRecord'),
    complaintRecord: registerModel('complaintRecord'),
    fundraisingRecord: registerModel('fundraisingRecord'),
    annualReportReadiness: upsertModel('annualReportReadiness'),
    financialControlReview: upsertModel('financialControlReview'),
    governanceRegisterChangeAudit: { create: async (args: unknown) => { calls.push({ name: 'governanceRegisterChangeAudit.create', args }); return { id: 'audit-1' }; } },
    $queryRaw: async (...args: unknown[]) => {
      calls.push({ name: '$queryRaw', args });
      return [{ id: 'org_1' }];
    },
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
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
      { organisationId: 'org_1', ...(model === 'complaintRecord' ? { removedAt: null } : {}) },
      `${model}.findMany must be scoped to the caller organisation`,
    );
  }
});

test('annual report readiness reads and upserts are scoped to organisationId_reportingYear', async () => {
  const { service, calls } = buildService();

  await service.getAnnualReportReadiness('org_1', 2026);
  await service.upsertAnnualReportReadiness('org_1', { reportingYear: 2026 } as never, 'actor-1');

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
  await service.upsertFinancialControlReview('org_1', { reportingYear: 2026 } as never, 'actor-1');

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
  const transaction = {
    riskRecord: { create: create.fn },
    riskChangeAudit: { create: spy().fn },
  };
  const app = await buildApp({
    ...transaction,
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  }, 'ADMIN');
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

test('complaint resolution API binds actor and charity, rejects injected fields and both stale revisions', async () => {
  let recordRevision = 2;
  let evidenceRevision = 0;
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    complaintRecord: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.deepEqual(where, { id: 'complaint-1', organisationId: 'org-1', removedAt: null });
      return { id: 'complaint-1', revision: recordRevision, status: 'CLOSED', receivedDate: new Date('2026-01-01') };
    } },
    complaintResolutionEvidence: {
      findFirst: async () => evidenceRevision ? { revision: evidenceRevision, state: 'RECORDED' } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); evidenceRevision++; return data; },
    },
  };
  const app = await buildApp({ $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) });
  const payload = { expectedRecordRevision: 2, expectedEvidenceRevision: 0, state: 'RECORDED',
    resolvedAt: '2026-01-02T10:00:00.000Z', evidenceRef: 'CASE-001', reason: 'Reviewed controlled case evidence' };
  const post = (body: object) => app.inject({ method: 'POST', url: `${PREFIX}/complaints/complaint-1/resolution-evidence`,
    headers: { authorization: tokenFor('ADMIN') }, payload: body });
  try {
    assert.equal((await post({ ...payload, actorUserId: 'foreign' })).statusCode, 400);
    assert.equal((await post({ ...payload, expectedRecordRevision: 1 })).statusCode, 409);
    assert.equal((await post(payload)).statusCode, 201);
    assert.equal(created[0].organisationId, 'org-1');
    assert.equal(created[0].actorUserId, 'u1');
    assert.equal(created[0].recordRevision, 2);
    assert.equal((await post(payload)).statusCode, 409);
    recordRevision++;
    assert.equal((await post({ ...payload, expectedEvidenceRevision: 1 })).statusCode, 409);
    assert.equal(created.length, 1);
  } finally { await app.close(); }
});

test('complaint purge routes require Owner browser access and elevated writes before touching records',async()=>{
  for(const scenario of [
    {role:'MEMBER',clientKind:'WEB',accessLevel:'ADMIN'},
    {role:'ADMIN',clientKind:'WEB',accessLevel:'ADMIN'},
    {role:'OWNER',clientKind:'MCP_CONNECTOR',accessLevel:'ADMIN'},
    {role:'OWNER',clientKind:'WEB',accessLevel:'READ'},
  ] as const) {
    let accesses=0;
    const app=await buildApp({authSession:{findFirst:async()=>({id:'sess-1',...scenario,dataScope:'FULL'})},
      $transaction:async()=>{accesses++;throw new Error('Forbidden access reached database');}},scenario.role);
    try {
      const paths:[ 'GET'|'POST',string][]=[
        ['POST','/complaints/complaint-1/purge-authorizations'],
        ['POST','/complaints/purge-authorizations/auth-1/withdraw'],
        ['POST','/complaints/purge-authorizations/auth-1/claim'],
        ['POST','/complaints/purge-authorizations/auth-1/dispositions'],
      ];
      if(scenario.accessLevel==='ADMIN') paths.push(['GET','/complaints/purge-authorizations']);
      if(scenario.accessLevel==='ADMIN') paths.push(['GET','/complaints/purge-authorizations/auth-1/dispositions']);
      for(const [method,path] of paths) {
        const response=await app.inject({method,url:`${PREFIX}${path}`,headers:{authorization:tokenFor(scenario.role)},payload:method==='POST'?{}:undefined});
        assert.equal(response.statusCode,403,`${scenario.role}/${scenario.clientKind}/${scenario.accessLevel}: ${path}`);
      }
      assert.equal(accesses,0);
    } finally {await app.close();}
  }
});

test('Member cannot submit complaint resolution evidence', async () => {
  const app = await buildApp({}, 'MEMBER');
  try {
    for (const action of ['resolution-evidence', 'remove', 'restore']) {
      const response = await app.inject({ method: 'POST', url: `${PREFIX}/complaints/complaint-1/${action}`,
        headers: { authorization: tokenFor('MEMBER') }, payload: {} });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'FORBIDDEN');
    }
  } finally { await app.close(); }
});

test('complaint resolution refuses missing records, invalid dates, open records and empty withdrawals', async () => {
  let complaint: { revision: number; status: string; receivedDate: Date } | null = null;
  let writes = 0;
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    complaintRecord: { findFirst: async () => complaint },
    complaintResolutionEvidence: { findFirst: async () => null, create: async () => { writes++; } },
  };
  const service = new GovernanceRegisterService({ $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) } as never);
  const input = { organisationId: 'org-1', complaintId: 'complaint-1', actorUserId: 'u1',
    expectedRecordRevision: 1, expectedEvidenceRevision: 0, state: 'RECORDED' as const,
    resolvedAt: '2026-01-02T10:00:00.000Z', evidenceRef: 'CASE-001', reason: 'Reviewed controlled case evidence' };
  await assert.rejects(service.recordComplaintResolutionEvidence(input), /not found/);
  complaint = { revision: 1, status: 'OPEN', receivedDate: new Date('2026-01-01') };
  await assert.rejects(service.recordComplaintResolutionEvidence(input), /closed complaint/);
  complaint.status = 'CLOSED';
  for (const resolvedAt of ['2025-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'invalid']) {
    await assert.rejects(service.recordComplaintResolutionEvidence({ ...input, resolvedAt }), /resolution time/);
  }
  await assert.rejects(service.recordComplaintResolutionEvidence({ ...input, state: 'WITHDRAWN' }), /no current recorded/);
  assert.equal(writes, 0);
});

test('complaint resolution history is bounded and tenant-scoped after source removal', async () => {
  const queries: unknown[] = [];
  const app = await buildApp({ complaintResolutionEvidence: { findMany: async (query: unknown) => {
    queries.push(query); return Array.from({ length: 51 }, (_, index) => ({ revision: 99 - index }));
  } } });
  try {
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/complaints/removed/resolution-evidence?beforeRevision=100`,
      headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.items.length, 50);
    assert.equal(response.json().data.nextBeforeRevision, 50);
    assert.deepEqual(queries, [{ where: { organisationId: 'org-1', complaintId: 'removed', revision: { lt: 100 } },
      orderBy: { revision: 'desc' }, take: 51 }]);
  } finally { await app.close(); }
});

test('complaint hold writes reject Members and read-only browser sessions before service work', async () => {
  for (const role of ['MEMBER','ADMIN'] as const) {
    let writes = 0;
    const app = await buildApp({
      authSession: { findFirst: async () => ({ id: 'sess-1', clientKind: 'WEB', accessLevel: 'READ', dataScope: 'FULL' }) },
      $transaction: async () => { writes++; throw new Error('must not reach service'); },
    }, role);
    try {
      const response = await app.inject({ method: 'POST', url: `${PREFIX}/complaints/complaint-1/holds`,
        headers: { authorization: tokenFor(role) }, payload: {} });
      assert.equal(response.statusCode,403);
      assert.equal(writes,0);
    } finally { await app.close(); }
  }
});
