import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'compliance-service-test-secret';

const { ComplianceService } = await import('../services/compliance.service.js');

type Call = { name: string; args: unknown };
const codeOf = (err: unknown) => (err as { code?: string })?.code;

function buildService(opts: {
  plan?: string | null; // null => no subscription
  complexity?: string;
  conditionalObligationProfile?: unknown;
  standard?: { id: string; isCore: boolean } | null; // for findUnique
  standards?: Array<{
    id: string;
    code?: string;
    isCore?: boolean;
    principleId: string;
    principle: { number: number; title: string };
  }>;
  records?: Array<{
    standardId: string;
    status: string;
    actionTaken?: string | null;
    evidence?: string | null;
    explanationIfNA?: string | null;
    standard?: { id: string; code: string };
  }>;
  signoff?: Record<string, unknown> | null;
} = {}) {
  const calls: Call[] = [];
  const fullStandards = (opts.standards ?? []).map((standard, index) => ({
    isAdditional: false,
    sortOrder: index + 1,
    ...standard,
    code: standard.code ?? `${index + 1}.1`,
    isCore: standard.isCore ?? true,
    principle: {
      id: standard.principleId,
      sortOrder: index + 1,
      ...standard.principle,
    },
  }));
  const fullRecords = (opts.records ?? []).map((record, index) => ({
    id: `rec_${index + 1}`,
    organisationId: 'org_1',
    reportingYear: 2026,
    revision: 1,
    actionTaken: null,
    evidence: null,
    notes: null,
    explanationIfNA: null,
    updatedById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...record,
  }));
  let persistedRecord: Record<string, unknown> | null = null;
  let persistedSignoff = opts.signoff
    ? {
        id: 'so_1', organisationId: 'org_1', reportingYear: 2026, status: 'DRAFT', updatedById: 'u1',
        updatedAt: new Date(), createdAt: new Date(), boardMeetingDate: null, minuteReference: null,
        approvedByName: null, approvedByRole: null, approvalNotes: null, approvedAt: null,
        revision: 1, approvalSequence: 0, currentApprovalSnapshotId: null, currentApprovalSnapshot: null,
        invalidatedAt: null, invalidationReason: null, invalidatedById: null,
        ...opts.signoff,
      }
    : null;
  const prisma: Record<string, any> = {
    $queryRaw: async (...args: unknown[]) => { calls.push({ name: '$queryRaw', args }); return [{ id: 'org_1' }]; },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org_1',
        name: 'Example Charity',
        rcnNumber: 'RCN-1',
        complexity: opts.complexity ?? 'SIMPLE',
        conditionalObligationProfile: opts.conditionalObligationProfile,
      }),
    },
    subscription: {
      findUnique: async () => (opts.plan === null ? null : { plan: opts.plan ?? 'ESSENTIALS' }),
    },
    governanceStandard: {
      findUnique: async () => {
        if (opts.standard === null) return null;
        const standard = opts.standard ?? { id: 's1', isCore: true };
        return {
          principleId: 'p1', code: '1.1', title: 'Standard', isAdditional: false, sortOrder: 1,
          principle: { id: 'p1', number: 1, title: 'Principle', description: '', sortOrder: 1 },
          ...standard,
        };
      },
      findMany: async (args: unknown) => { calls.push({ name: 'governanceStandard.findMany', args }); return fullStandards; },
    },
    governancePrinciple: {
      findMany: async (args: unknown) => { calls.push({ name: 'governancePrinciple.findMany', args }); return []; },
      findUnique: async (args: unknown) => { calls.push({ name: 'governancePrinciple.findUnique', args }); return null; },
    },
    complianceRecord: {
      findMany: async (args: unknown) => { calls.push({ name: 'complianceRecord.findMany', args }); return fullRecords; },
      findUnique: async (args: unknown) => { calls.push({ name: 'complianceRecord.findUnique', args }); return persistedRecord; },
      findUniqueOrThrow: async () => persistedRecord,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceRecord.create', args });
        persistedRecord = {
          id: 'rec_1', standard: { id: args.data.standardId }, updatedBy: { id: 'u1', name: 'User' },
          createdAt: new Date(), updatedAt: new Date(), ...args.data,
        };
        return persistedRecord;
      },
      updateMany: async (args: unknown) => { calls.push({ name: 'complianceRecord.updateMany', args }); return { count: 1 }; },
    },
    complianceSignoff: {
      findUnique: async () => persistedSignoff,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceSignoff.create', args });
        persistedSignoff = {
          id: 'so_1', createdAt: new Date(), updatedAt: new Date(), currentApprovalSnapshot: null,
          ...args.data,
        } as typeof persistedSignoff;
        return persistedSignoff;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'complianceSignoff.update', args });
        persistedSignoff = { ...persistedSignoff, ...args.data, updatedAt: new Date(), currentApprovalSnapshot: null } as typeof persistedSignoff;
        return persistedSignoff;
      },
    },
    complianceApprovalSnapshot: {
      findFirst: async () => null,
      create: async (args: unknown) => { calls.push({ name: 'complianceApprovalSnapshot.create', args }); return null; },
    },
    complianceAuditEvent: {
      create: async (args: unknown) => { calls.push({ name: 'complianceAuditEvent.create', args }); return {}; },
    },
    user: { findUnique: async () => ({ name: 'User' }) },
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
    calls.push({ name: '$transaction', args: options });
    return callback(prisma);
  };
  return { service: new ComplianceService(prisma as never), calls };
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

test('compliance scope requires an active subscription', async () => {
  const { service } = buildService({ plan: null });
  await assert.rejects(() => service.getRecords('org_1', 2026), (e: unknown) => codeOf(e) === 'NO_SUBSCRIPTION');
});

// ── plan/complexity feature-gating on standards ──

test('getRecords for an Essentials/Simple org restricts to core standards', async () => {
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE' });
  await service.getRecords('org_1', 2026);
  const find = calls.find((c) => c.name === 'complianceRecord.findMany');
  assert.deepEqual((find?.args as { where: { standard: unknown } }).where.standard, { isCore: true });
});

test('getRecords for a Complete/Complex org includes additional standards', async () => {
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX' });
  await service.getRecords('org_1', 2026);
  const find = calls.find((c) => c.name === 'complianceRecord.findMany');
  assert.equal((find?.args as { where: { standard: unknown } }).where.standard, undefined);
});

test('getApprovalReadiness reports missing NOT_APPLICABLE and EXPLAIN explanations', async () => {
  const standards = [
    { id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's2', code: '1.2', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's3', code: '2.1', isCore: true, principleId: 'p2', principle: { number: 2, title: 'Principle 2' } },
  ];
  const records = [
    { standardId: 's1', status: 'NOT_APPLICABLE', explanationIfNA: null, standard: { id: 's1', code: '1.1' } },
    { standardId: 's2', status: 'NOT_APPLICABLE', explanationIfNA: '', standard: { id: 's2', code: '1.2' } },
    { standardId: 's3', status: 'EXPLAIN', explanationIfNA: '   ', standard: { id: 's3', code: '2.1' } },
  ];
  const { service, calls } = buildService({
    plan: 'COMPLETE',
    complexity: 'COMPLEX',
    conditionalObligationProfile: falseProfile(),
    standards,
    records,
  });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missingExplanations, [
    { standardId: 's1', standardCode: '1.1', status: 'NOT_APPLICABLE' },
    { standardId: 's2', standardCode: '1.2', status: 'NOT_APPLICABLE' },
    { standardId: 's3', standardCode: '2.1', status: 'EXPLAIN' },
  ]);
  const find = calls.find((c) => c.name === 'complianceRecord.findMany');
  assert.equal((find?.args as { where: { organisationId: string; reportingYear: number } }).where.organisationId, 'org_1');
  assert.equal((find?.args as { where: { organisationId: string; reportingYear: number } }).where.reportingYear, 2026);
});

test('getApprovalReadiness reports missing records and evidence fields, not only explanations', async () => {
  const standards = [
    { id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's2', code: '1.2', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's3', code: '2.1', isCore: true, principleId: 'p2', principle: { number: 2, title: 'Principle 2' } },
    { id: 's4', code: '2.2', isCore: true, principleId: 'p2', principle: { number: 2, title: 'Principle 2' } },
  ];
  const records = [
    { standardId: 's1', status: 'COMPLIANT', actionTaken: '', evidence: '   ', standard: { id: 's1', code: '1.1' } },
    { standardId: 's2', status: 'WORKING_TOWARDS', actionTaken: 'Drafting controls', evidence: '', standard: { id: 's2', code: '1.2' } },
    { standardId: 's3', status: 'EXPLAIN', explanationIfNA: ' ', standard: { id: 's3', code: '2.1' } },
  ];
  const { service } = buildService({
    plan: 'ESSENTIALS',
    complexity: 'SIMPLE',
    conditionalObligationProfile: falseProfile(),
    standards,
    records,
  });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missingRecords, [
    { standardId: 's4', standardCode: '2.2', status: 'NOT_STARTED' },
  ]);
  assert.deepEqual(readiness.missingEvidence, [
    { standardId: 's1', standardCode: '1.1', status: 'COMPLIANT', missingActionTaken: true, missingEvidence: true },
    { standardId: 's2', standardCode: '1.2', status: 'WORKING_TOWARDS', missingActionTaken: false, missingEvidence: true },
  ]);
  assert.deepEqual(readiness.missingExplanations, [
    { standardId: 's3', standardCode: '2.1', status: 'EXPLAIN' },
  ]);
});

test('getApprovalReadiness blocks board approval until conditional obligation facts are captured', async () => {
  const { service } = buildService({
    plan: 'ESSENTIALS',
    complexity: 'SIMPLE',
    standards: [{ id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } }],
    records: [
      {
        standardId: 's1',
        status: 'COMPLIANT',
        actionTaken: 'Trustees reviewed the standard',
        evidence: 'Board pack and minutes',
        standard: { id: 's1', code: '1.1' },
      },
    ],
  });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.profileIssues, [
    {
      code: 'CONDITIONAL_OBLIGATION_PROFILE_MISSING',
      message: 'Capture the organisation conditional obligation profile before approving the annual Compliance Record.',
    },
  ]);
});

test('getApprovalReadiness surfaces conditional review prompts without treating them as legal certification blockers', async () => {
  const { service } = buildService({
    plan: 'ESSENTIALS',
    complexity: 'SIMPLE',
    conditionalObligationProfile: {
      ...falseProfile(),
      hasPaidStaff: true,
      raisesFundsFromPublic: true,
      worksWithChildrenOrVulnerableAdults: true,
      usesDataProcessors: true,
    },
    standards: [{ id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } }],
    records: [
      {
        standardId: 's1',
        status: 'COMPLIANT',
        actionTaken: 'Trustees reviewed the standard',
        evidence: 'Board pack and minutes',
        standard: { id: 's1', code: '1.1' },
      },
    ],
  });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.conditionalReviewItems.map((item) => item.profileKey),
    ['hasPaidStaff', 'raisesFundsFromPublic', 'worksWithChildrenOrVulnerableAdults', 'usesDataProcessors'],
  );
  assert.match(readiness.conditionalReviewItems[0].recommendedAction, /employment/i);
});

test('getApprovalReadiness ignores complete, irrelevant, and out-of-scope records for Essentials/Simple', async () => {
  const standards = [
    { id: 's1', code: '1.1', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's2', code: '1.2', isCore: true, principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's3', code: '2.1', isCore: true, principleId: 'p2', principle: { number: 2, title: 'Principle 2' } },
  ];
  const records = [
    { standardId: 's1', status: 'NOT_APPLICABLE', explanationIfNA: 'Explained', standard: { id: 's1', code: '1.1' } },
    { standardId: 's2', status: 'EXPLAIN', explanationIfNA: 'Because this standard does not fit', standard: { id: 's2', code: '1.2' } },
    {
      standardId: 's3',
      status: 'COMPLIANT',
      actionTaken: 'Reviewed',
      evidence: 'Minutes',
      explanationIfNA: null,
      standard: { id: 's3', code: '2.1' },
    },
  ];
  const { service, calls } = buildService({
    plan: 'ESSENTIALS',
    complexity: 'SIMPLE',
    conditionalObligationProfile: falseProfile(),
    standards,
    records,
  });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingExplanations, []);
  const find = calls.find((c) => c.name === 'complianceRecord.findMany');
  assert.deepEqual((find?.args as { where: { standard: unknown } }).where.standard, { isCore: true });
});

test('upsertRecord blocks a non-core standard for an Essentials org (no billing bypass)', async () => {
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE', standard: { id: 's_extra', isCore: false } });
  await assert.rejects(
    () => service.upsertRecord('org_1', 's_extra', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' } as never),
    (e: unknown) => codeOf(e) === 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
  );
  assert.equal(calls.some((c) => c.name === 'complianceRecord.create'), false, 'must not write a record for an out-of-plan standard');
});

test('upsertRecord rejects an unknown standard', async () => {
  const { service } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standard: null });
  await assert.rejects(
    () => service.upsertRecord('org_1', 's_missing', 'u1', { reportingYear: 2026, expectedRevision: 0 } as never),
    (e: unknown) => codeOf(e) === 'STANDARD_NOT_FOUND',
  );
});

test('upsertRecord allows a non-core standard for a Complete/Complex org', async () => {
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standard: { id: 's_extra', isCore: false } });
  await service.upsertRecord('org_1', 's_extra', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' } as never);
  const create = calls.find((c) => c.name === 'complianceRecord.create');
  assert.ok(create, 'create should run for an in-plan additional standard');
});

test('upsertRecord allows a core standard regardless of plan', async () => {
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE', standard: { id: 's_core', isCore: true } });
  await service.upsertRecord('org_1', 's_core', 'u1', { reportingYear: 2026, expectedRevision: 0, status: 'COMPLIANT' } as never);
  assert.ok(calls.find((c) => c.name === 'complianceRecord.create'));
});

// ── scoring math ──

test('getSummary excludes NOT_APPLICABLE from the denominator and computes per-principle percentages', async () => {
  const standards = [
    { id: 's1', principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's2', principleId: 'p1', principle: { number: 1, title: 'Principle 1' } },
    { id: 's3', principleId: 'p2', principle: { number: 2, title: 'Principle 2' } },
  ];
  const records = [
    { standardId: 's1', status: 'COMPLIANT' },
    { standardId: 's2', status: 'NOT_APPLICABLE' },
    { standardId: 's3', status: 'WORKING_TOWARDS' },
  ];
  const { service } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standards, records });

  const summary = await service.getSummary('org_1', 2026);

  assert.equal(summary.compliant, 1);
  assert.equal(summary.workingTowards, 1);
  assert.equal(summary.notApplicable, 1);
  assert.equal(summary.notStarted, 0);
  assert.equal(summary.totalApplicable, 2, '3 standards minus 1 NOT_APPLICABLE');
  assert.equal(summary.percentComplete, 50, '1 compliant of 2 applicable');

  const p1 = summary.byPrinciple.find((p) => p.principleNumber === 1)!;
  const p2 = summary.byPrinciple.find((p) => p.principleNumber === 2)!;
  assert.equal(p1.totalApplicable, 1, 'NA standard excluded from the principle denominator');
  assert.equal(p1.compliant, 1);
  assert.equal(p1.percentComplete, 100);
  assert.equal(p2.percentComplete, 0);
});

test('getSummary reports 100% when every standard is NOT_APPLICABLE (no division by zero)', async () => {
  const standards = [{ id: 's1', principleId: 'p1', principle: { number: 1, title: 'Principle 1' } }];
  const records = [{ standardId: 's1', status: 'NOT_APPLICABLE' }];
  const { service } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standards, records });

  const summary = await service.getSummary('org_1', 2026);
  assert.equal(summary.totalApplicable, 0);
  assert.equal(summary.percentComplete, 100);
});

test('getSignoff returns a DRAFT default when no sign-off exists', async () => {
  const { service } = buildService({ signoff: null });
  const result = await service.getSignoff('org_1', 2026);
  assert.equal(result.id, null);
  assert.equal(result.status, 'DRAFT');
  assert.equal(result.approvedAt, null);
});
