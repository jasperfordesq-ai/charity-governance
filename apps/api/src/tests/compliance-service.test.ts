import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'compliance-service-test-secret';

const { ComplianceService } = await import('../services/compliance.service.js');

type Call = { name: string; args: unknown };
const codeOf = (err: unknown) => (err as { code?: string })?.code;

function buildService(opts: {
  plan?: string | null; // null => no subscription
  complexity?: string;
  standard?: { id: string; isCore: boolean } | null; // for findUnique
  standards?: Array<{ id: string; principleId: string; principle: { number: number; title: string } }>;
  records?: Array<{
    standardId: string;
    status: string;
    explanationIfNA?: string | null;
    standard?: { id: string; code: string };
  }>;
  signoff?: Record<string, unknown> | null;
} = {}) {
  const calls: Call[] = [];
  const prisma = {
    organisation: {
      findUniqueOrThrow: async () => ({ complexity: opts.complexity ?? 'SIMPLE' }),
    },
    subscription: {
      findUnique: async () => (opts.plan === null ? null : { plan: opts.plan ?? 'ESSENTIALS' }),
    },
    governanceStandard: {
      findUnique: async () => (opts.standard === undefined ? { id: 's1', isCore: true } : opts.standard),
      findMany: async (args: unknown) => { calls.push({ name: 'governanceStandard.findMany', args }); return opts.standards ?? []; },
    },
    governancePrinciple: {
      findMany: async (args: unknown) => { calls.push({ name: 'governancePrinciple.findMany', args }); return []; },
      findUnique: async (args: unknown) => { calls.push({ name: 'governancePrinciple.findUnique', args }); return null; },
    },
    complianceRecord: {
      findMany: async (args: unknown) => { calls.push({ name: 'complianceRecord.findMany', args }); return opts.records ?? []; },
      findUnique: async (args: unknown) => { calls.push({ name: 'complianceRecord.findUnique', args }); return null; },
      upsert: async (args: { data?: unknown }) => { calls.push({ name: 'complianceRecord.upsert', args }); return { id: 'rec_1' }; },
    },
    complianceSignoff: {
      findUnique: async () => opts.signoff ?? null,
      upsert: async (args: unknown) => { calls.push({ name: 'complianceSignoff.upsert', args }); return { id: 'so_1', organisationId: 'org_1', reportingYear: 2026, status: 'DRAFT', updatedById: 'u1', updatedAt: new Date(), boardMeetingDate: null, minuteReference: null, approvedByName: null, approvedByRole: null, approvalNotes: null, approvedAt: null }; },
    },
  };
  return { service: new ComplianceService(prisma as never), calls };
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
  const records = [
    { standardId: 's1', status: 'NOT_APPLICABLE', explanationIfNA: null, standard: { id: 's1', code: '1.1' } },
    { standardId: 's2', status: 'NOT_APPLICABLE', explanationIfNA: '', standard: { id: 's2', code: '1.2' } },
    { standardId: 's3', status: 'EXPLAIN', explanationIfNA: '   ', standard: { id: 's3', code: '2.1' } },
  ];
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', records });

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

test('getApprovalReadiness ignores complete, irrelevant, and out-of-scope records for Essentials/Simple', async () => {
  const records = [
    { standardId: 's1', status: 'NOT_APPLICABLE', explanationIfNA: 'Explained', standard: { id: 's1', code: '1.1' } },
    { standardId: 's2', status: 'EXPLAIN', explanationIfNA: 'Because this standard does not fit', standard: { id: 's2', code: '1.2' } },
    { standardId: 's3', status: 'COMPLIANT', explanationIfNA: null, standard: { id: 's3', code: '2.1' } },
  ];
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE', records });

  const readiness = await service.getApprovalReadiness('org_1', 2026);

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingExplanations, []);
  const find = calls.find((c) => c.name === 'complianceRecord.findMany');
  assert.deepEqual((find?.args as { where: { standard: unknown } }).where.standard, { isCore: true });
});

test('upsertRecord blocks a non-core standard for an Essentials org (no billing bypass)', async () => {
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE', standard: { id: 's_extra', isCore: false } });
  await assert.rejects(
    () => service.upsertRecord('org_1', 's_extra', 'u1', { reportingYear: 2026, status: 'COMPLIANT' } as never),
    (e: unknown) => codeOf(e) === 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
  );
  assert.equal(calls.some((c) => c.name === 'complianceRecord.upsert'), false, 'must not write a record for an out-of-plan standard');
});

test('upsertRecord rejects an unknown standard', async () => {
  const { service } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standard: null });
  await assert.rejects(
    () => service.upsertRecord('org_1', 's_missing', 'u1', { reportingYear: 2026 } as never),
    (e: unknown) => codeOf(e) === 'STANDARD_NOT_FOUND',
  );
});

test('upsertRecord allows a non-core standard for a Complete/Complex org', async () => {
  const { service, calls } = buildService({ plan: 'COMPLETE', complexity: 'COMPLEX', standard: { id: 's_extra', isCore: false } });
  await service.upsertRecord('org_1', 's_extra', 'u1', { reportingYear: 2026, status: 'COMPLIANT' } as never);
  const upsert = calls.find((c) => c.name === 'complianceRecord.upsert');
  assert.ok(upsert, 'upsert should run for an in-plan additional standard');
});

test('upsertRecord allows a core standard regardless of plan', async () => {
  const { service, calls } = buildService({ plan: 'ESSENTIALS', complexity: 'SIMPLE', standard: { id: 's_core', isCore: true } });
  await service.upsertRecord('org_1', 's_core', 'u1', { reportingYear: 2026, status: 'COMPLIANT' } as never);
  assert.ok(calls.find((c) => c.name === 'complianceRecord.upsert'));
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
