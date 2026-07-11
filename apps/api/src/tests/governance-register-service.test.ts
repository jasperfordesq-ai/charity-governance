import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'gov-register-test-secret';

const { GovernanceRegisterService } = await import('../services/governance-register.service.js');

type Call = { name: string; args: unknown };

function registerModel(
  name: string,
  calls: Call[],
  found: boolean,
  errors: { create?: unknown; update?: unknown; delete?: unknown } = {},
) {
  return {
    findFirst: async (args: { where: { id: string; organisationId: string } }) => {
      calls.push({ name: `${name}.findFirst`, args });
      return found ? { id: args.where.id, organisationId: args.where.organisationId } : null;
    },
    findMany: async (args: unknown) => {
      calls.push({ name: `${name}.findMany`, args });
      return [];
    },
    count: async (args: unknown) => {
      calls.push({ name: `${name}.count`, args });
      return 0;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      calls.push({ name: `${name}.create`, args });
      if (errors.create) throw errors.create;
      return { id: 'new_id', ...args.data };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.push({ name: `${name}.update`, args });
      if (errors.update) throw errors.update;
      return { id: args.where.id, ...args.data };
    },
    delete: async (args: unknown) => {
      calls.push({ name: `${name}.delete`, args });
      if (errors.delete) throw errors.delete;
      return {};
    },
  };
}

function buildService(opts: {
  recordFound?: boolean;
  boardMemberFound?: boolean;
  annual?: Record<string, unknown> | null;
  financial?: Record<string, unknown> | null;
  conflictErrors?: { create?: unknown; update?: unknown; delete?: unknown };
  fundraisingErrors?: { create?: unknown; update?: unknown; delete?: unknown };
} = {}) {
  const calls: Call[] = [];
  const found = opts.recordFound ?? true;
  const transaction = {
    conflictRecord: registerModel('conflictRecord', calls, found, opts.conflictErrors),
    riskRecord: registerModel('riskRecord', calls, found),
    complaintRecord: registerModel('complaintRecord', calls, found),
    fundraisingRecord: registerModel('fundraisingRecord', calls, found, opts.fundraisingErrors),
    boardMember: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        calls.push({ name: 'boardMember.findFirst', args });
        return (opts.boardMemberFound ?? true) ? { id: args.where.id } : null;
      },
    },
    annualReportReadiness: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'annualReportReadiness.findUnique', args });
        return opts.annual ?? null;
      },
    },
    financialControlReview: {
      findUnique: async (args: unknown) => {
        calls.push({ name: 'financialControlReview.findUnique', args });
        return opts.financial ?? null;
      },
    },
    $queryRaw: async (...args: unknown[]) => {
      calls.push({ name: '$queryRaw', args });
      return [{ id: 'org_1' }];
    },
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => {
      calls.push({ name: 'prisma.$transaction', args: {} });
      return callback(transaction);
    },
  };
  return { service: new GovernanceRegisterService(prisma as never), calls };
}

const REGISTERS = [
  { key: 'conflict', code: 'CONFLICT_NOT_FOUND', model: 'conflictRecord' },
  { key: 'risk', code: 'RISK_NOT_FOUND', model: 'riskRecord' },
  { key: 'complaint', code: 'COMPLAINT_NOT_FOUND', model: 'complaintRecord' },
  { key: 'fundraising', code: 'FUNDRAISING_NOT_FOUND', model: 'fundraisingRecord' },
] as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// IDOR guard: a record belonging to another organisation must be treated as
// not-found, and the mutation must NOT reach the unscoped update/delete.
for (const reg of REGISTERS) {
  test(`update${cap(reg.key)} rejects a record from another organisation (no cross-tenant write)`, async () => {
    const { service, calls } = buildService({ recordFound: false });
    const method = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[`update${cap(reg.key)}`];

    await assert.rejects(
      () => method.call(service, 'org_attacker', 'record_of_other_org', {}),
      (err: unknown) => (err as { code?: string; statusCode?: number })?.code === reg.code &&
        (err as { statusCode?: number })?.statusCode === 404,
    );

    assert.ok(
      calls.some((c) => c.name === `${reg.model}.findFirst`),
      'must look the record up scoped to the organisation',
    );
    assert.equal(
      calls.some((c) => c.name === `${reg.model}.update`),
      false,
      'must NOT update a record it could not find in the organisation',
    );
  });

  test(`remove${cap(reg.key)} rejects a record from another organisation (no cross-tenant delete)`, async () => {
    const { service, calls } = buildService({ recordFound: false });
    const method = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[`remove${cap(reg.key)}`];

    await assert.rejects(
      () => method.call(service, 'org_attacker', 'record_of_other_org'),
      (err: unknown) => (err as { code?: string })?.code === reg.code,
    );

    assert.equal(
      calls.some((c) => c.name === `${reg.model}.delete`),
      false,
      'must NOT delete a record it could not find in the organisation',
    );
  });
}

test('the org-scoped lookup keys on both id and organisationId', async () => {
  const { service, calls } = buildService({ recordFound: false });
  await assert.rejects(() => service.removeRisk('org_1', 'risk_1'));
  const lookup = calls.find((c) => c.name === 'riskRecord.findFirst');
  assert.ok(lookup);
  assert.deepEqual((lookup.args as { where: unknown }).where, { id: 'risk_1', organisationId: 'org_1' });
});

test('createConflict rejects a board member that belongs to another organisation', async () => {
  const { service, calls } = buildService({ boardMemberFound: false });

  await assert.rejects(
    () =>
      service.createConflict('org_1', {
        boardMemberId: 'bm_other_org',
        trusteeName: 'Jane Doe',
        matter: 'Supplier relationship',
        nature: 'Financial interest',
        dateDeclared: '2026-01-01',
        actionTaken: 'Recused from vote',
      } as never),
    (err: unknown) => (err as { code?: string })?.code === 'BOARD_MEMBER_NOT_FOUND',
  );

  assert.equal(
    calls.some((c) => c.name === 'conflictRecord.create'),
    false,
    'must not create the conflict when the board member is not in the organisation',
  );
});

test('createRisk persists the record scoped to the caller organisation', async () => {
  const { service, calls } = buildService();
  await service.createRisk('org_1', {
    title: 'Funding shortfall',
    category: 'FINANCIAL',
    description: 'Reserves below policy',
    likelihood: 3,
    impact: 4,
    mitigation: 'Diversify income',
  } as never);

  const create = calls.find((c) => c.name === 'riskRecord.create');
  assert.ok(create);
  assert.equal((create.args as { data: { organisationId: string } }).data.organisationId, 'org_1');
});

test('summary counts only non-closed records scoped to the organisation', async () => {
  const { service, calls } = buildService();
  await service.summary('org_1', 2026);

  for (const model of ['conflictRecord', 'riskRecord', 'complaintRecord', 'fundraisingRecord']) {
    const count = calls.find((c) => c.name === `${model}.count`);
    assert.ok(count, `${model} must be counted`);
    assert.deepEqual((count.args as { where: unknown }).where, {
      organisationId: 'org_1',
      status: { not: 'CLOSED' },
    });
  }
});

test('annual report readiness is 0% when no record exists and 100% when fully complete', async () => {
  const empty = await buildService({ annual: null }).service.summary('org_1', 2026);
  assert.equal(empty.annualReportReadinessPercent, 0);

  const fullAnnual = {
    id: 'a1',
    organisationId: 'org_1',
    reportingYear: 2026,
    activitiesNarrative: 'Did good work',
    publicBenefitStatement: 'For the public benefit',
    beneficiariesSummary: 'Local community',
    financialStatementsApproved: true,
    annualReportUploaded: true,
    trusteeDetailsReviewed: true,
    fundraisingReviewed: true,
    complaintsReviewed: true,
    boardApprovalDate: new Date('2026-03-01'),
    filingStatus: 'FILED',
    filedDate: new Date('2026-03-10'),
    notes: null,
    updatedAt: new Date('2026-03-10'),
  };
  const full = await buildService({ annual: fullAnnual }).service.summary('org_1', 2026);
  assert.equal(full.annualReportReadinessPercent, 100);
});

test('financial controls readiness reflects how many controls are recorded', async () => {
  const empty = await buildService({ financial: null }).service.summary('org_1', 2026);
  assert.equal(empty.financialControlsPercent, 0);

  const fullFinancial = {
    id: 'f1',
    organisationId: 'org_1',
    reportingYear: 2026,
    bankReconciliationsReviewed: true,
    dualAuthorisation: true,
    budgetApproved: true,
    managementAccountsReviewed: true,
    reservesReviewed: true,
    restrictedFundsReviewed: true,
    assetsInsuranceReviewed: true,
    payrollControlsReviewed: true,
    fundraisingControlsReviewed: true,
    reviewedBy: 'Treasurer',
    reviewDate: new Date('2026-02-01'),
    minuteReference: 'Min 12',
    actions: null,
    updatedAt: new Date('2026-02-01'),
  };
  const full = await buildService({ financial: fullFinancial }).service.summary('org_1', 2026);
  assert.equal(full.financialControlsPercent, 100);
});

test('getAnnualReportReadiness returns a safe default shape when no record exists', async () => {
  const { service } = buildService({ annual: null });
  const result = await service.getAnnualReportReadiness('org_1', 2026);
  assert.equal(result.id, null);
  assert.equal(result.organisationId, 'org_1');
  assert.equal(result.reportingYear, 2026);
  assert.equal(result.financialStatementsApproved, false);
  assert.equal(result.filingStatus, 'NOT_STARTED');
});

test('conflict references lock the organisation before scoped record or board-member reads', async () => {
  const { service, calls } = buildService();
  await service.updateConflict('org_1', 'conflict_1', { boardMemberId: 'bm_1' });

  const lockIndex = calls.findIndex((call) => call.name === '$queryRaw');
  assert.ok(lockIndex >= 0);
  assert.ok(lockIndex < calls.findIndex((call) => call.name === 'conflictRecord.findFirst'));
  assert.ok(lockIndex < calls.findIndex((call) => call.name === 'boardMember.findFirst'));
});

test('a raced composite conflict reference maps to BOARD_MEMBER_NOT_FOUND without leaking the constraint', async () => {
  const compositeRace = {
    code: 'P2003',
    meta: { field_name: 'ConflictRecord_boardMemberId_organisationId_fkey (index)' },
  };
  const { service } = buildService({ conflictErrors: { create: compositeRace } });

  await assert.rejects(
    () => service.createConflict('org_1', {
      boardMemberId: 'bm_1',
      trusteeName: 'Trustee',
      matter: 'Matter',
      nature: 'Nature',
      dateDeclared: '2026-01-01',
      actionTaken: 'Recused',
    } as never),
    (error: unknown) =>
      (error as { code?: string; statusCode?: number }).code === 'BOARD_MEMBER_NOT_FOUND' &&
      (error as { statusCode?: number }).statusCode === 404 &&
      !JSON.stringify(error).includes('ConflictRecord_boardMemberId_organisationId_fkey'),
  );
});

test('conflict update and delete races map P2025 to CONFLICT_NOT_FOUND', async () => {
  for (const scenario of [
    { method: 'update', service: buildService({ conflictErrors: { update: { code: 'P2025' } } }).service },
    { method: 'delete', service: buildService({ conflictErrors: { delete: { code: 'P2025' } } }).service },
  ]) {
    const operation = scenario.method === 'update'
      ? scenario.service.updateConflict('org_1', 'conflict_1', { matter: 'Changed' })
      : scenario.service.removeConflict('org_1', 'conflict_1');
    await assert.rejects(
      () => operation,
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT_NOT_FOUND',
    );
  }
});

test('fundraising update-vs-delete maps P2025 to FUNDRAISING_NOT_FOUND', async () => {
  for (const scenario of [
    { method: 'update', service: buildService({ fundraisingErrors: { update: { code: 'P2025' } } }).service },
    { method: 'delete', service: buildService({ fundraisingErrors: { delete: { code: 'P2025' } } }).service },
  ]) {
    const operation = scenario.method === 'update'
      ? scenario.service.updateFundraising('org_1', 'fundraising_1', { name: 'Changed' })
      : scenario.service.removeFundraising('org_1', 'fundraising_1');
    await assert.rejects(
      () => operation,
      (error: unknown) => (error as { code?: string }).code === 'FUNDRAISING_NOT_FOUND',
    );
  }
});

test('fundraising creation rejects an end date before its start date before writing', async () => {
  const { service, calls } = buildService();
  await assert.rejects(
    () => service.createFundraising('org_1', {
      name: 'Spring appeal',
      activityType: 'Direct mail',
      startDate: '2026-04-02',
      endDate: '2026-04-01',
    } as never),
    (error: unknown) =>
      (error as { code?: string; statusCode?: number }).code === 'VALIDATION_ERROR' &&
      (error as { statusCode?: number }).statusCode === 400,
  );
  assert.equal(calls.some((call) => call.name === 'fundraisingRecord.create'), false);
});

test('fundraising updates validate the effective persisted and patch state', async () => {
  const calls: Call[] = [];
  const transaction = {
    fundraisingRecord: {
      findFirst: async () => ({
        id: 'fundraising_1',
        organisationId: 'org_1',
        startDate: new Date('2026-04-02'),
        endDate: null,
      }),
      update: async (args: unknown) => {
        calls.push({ name: 'fundraisingRecord.update', args });
        return {};
      },
    },
    $queryRaw: async () => [{ id: 'org_1' }],
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
  };
  const service = new GovernanceRegisterService(prisma as never);

  await assert.rejects(
    () => service.updateFundraising('org_1', 'fundraising_1', { endDate: '2026-04-01' }),
    (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
  );
  assert.equal(calls.some((call) => call.name === 'fundraisingRecord.update'), false);
});

test('annual report updates merge stored facts before requiring a filed date', async () => {
  let upsertCalled = false;
  const transaction = {
    annualReportReadiness: {
      findUnique: async () => ({
        organisationId: 'org_1',
        reportingYear: 2026,
        filingStatus: 'IN_PROGRESS',
        filedDate: null,
      }),
      upsert: async () => {
        upsertCalled = true;
        return { organisationId: 'org_1', reportingYear: 2026 };
      },
    },
    $queryRaw: async () => [{ id: 'org_1' }],
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
  };
  const service = new GovernanceRegisterService(prisma as never);

  await assert.rejects(
    () => service.upsertAnnualReportReadiness('org_1', {
      reportingYear: 2026,
      filingStatus: 'FILED',
    } as never),
    (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
  );
  assert.equal(upsertCalled, false);
});

test('annual report upsert returns the exact atomic saved row without rereading another writer', async () => {
  let reads = 0;
  const saved = {
    id: 'annual_saved',
    organisationId: 'org_1',
    reportingYear: 2026,
    activitiesNarrative: 'Atomic result',
    publicBenefitStatement: null,
    beneficiariesSummary: null,
    financialStatementsApproved: false,
    annualReportUploaded: false,
    trusteeDetailsReviewed: false,
    fundraisingReviewed: false,
    complaintsReviewed: false,
    boardApprovalDate: null,
    filingStatus: 'IN_PROGRESS',
    filedDate: null,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  };
  const transaction = {
    annualReportReadiness: {
      findUnique: async () => {
        reads += 1;
        return null;
      },
      upsert: async () => saved,
    },
    $queryRaw: async () => [{ id: 'org_1' }],
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
  };

  const result = await new GovernanceRegisterService(prisma as never)
    .upsertAnnualReportReadiness('org_1', { reportingYear: 2026, activitiesNarrative: 'Atomic result' });

  assert.equal(reads, 1, 'only the pre-write effective-state read may run');
  assert.equal(result.id, 'annual_saved');
  assert.equal(result.activitiesNarrative, 'Atomic result');
  assert.equal(result.updatedAt, '2026-02-01T00:00:00.000Z');
});
