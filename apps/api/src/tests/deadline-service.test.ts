import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'deadline-service-test-secret';

const { DeadlineService } = await import('../services/deadline.service.js');

type Call = { name: string; args: unknown };

function buildService(opts: {
  deadlineFound?: boolean;
  existingAuto?: boolean;
  organisation?: Record<string, unknown>;
  listData?: unknown[];
  listTotal?: number;
} = {}) {
  const calls: Call[] = [];
  const found = opts.deadlineFound ?? true;
  const prisma = {
    deadline: {
      findMany: async (args: unknown) => {
        calls.push({ name: 'deadline.findMany', args });
        return opts.listData ?? [];
      },
      count: async (args: unknown) => {
        calls.push({ name: 'deadline.count', args });
        return opts.listTotal ?? 0;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'deadline.create', args });
        return { id: 'new_id', ...args.data };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ name: 'deadline.update', args });
        return { id: args.where.id, ...args.data };
      },
      delete: async (args: unknown) => {
        calls.push({ name: 'deadline.delete', args });
        return {};
      },
      deleteMany: async (args: unknown) => {
        calls.push({ name: 'deadline.deleteMany', args });
        return { count: 0 };
      },
      findFirst: async (args: { where: { id?: string; organisationId: string } }) => {
        calls.push({ name: 'deadline.findFirst', args });
        // For update/remove (keyed on id) honour deadlineFound; for the
        // auto-generate existence check honour existingAuto.
        if (args.where.id) return found ? { id: args.where.id, organisationId: args.where.organisationId } : null;
        return opts.existingAuto ? { id: 'existing_auto' } : null;
      },
    },
    organisation: {
      findUniqueOrThrow: async (args: unknown) => {
        calls.push({ name: 'organisation.findUniqueOrThrow', args });
        return opts.organisation ?? { id: 'org_1', financialYearEnd: null, lastAgmDate: null };
      },
    },
  };
  return { service: new DeadlineService(prisma as never), calls };
}

test('update rejects a deadline from another organisation (no cross-tenant write)', async () => {
  const { service, calls } = buildService({ deadlineFound: false });

  await assert.rejects(
    () => service.update('org_attacker', 'deadline_of_other_org', { title: 'Hijacked' } as never),
    (err: unknown) => (err as { code?: string; statusCode?: number })?.code === 'DEADLINE_NOT_FOUND' &&
      (err as { statusCode?: number })?.statusCode === 404,
  );

  const lookup = calls.find((c) => c.name === 'deadline.findFirst');
  assert.deepEqual((lookup?.args as { where: unknown }).where, {
    id: 'deadline_of_other_org',
    organisationId: 'org_attacker',
  });
  assert.equal(calls.some((c) => c.name === 'deadline.update'), false);
});

test('remove rejects a deadline from another organisation (no cross-tenant delete)', async () => {
  const { service, calls } = buildService({ deadlineFound: false });

  await assert.rejects(
    () => service.remove('org_attacker', 'deadline_of_other_org'),
    (err: unknown) => (err as { code?: string })?.code === 'DEADLINE_NOT_FOUND',
  );

  assert.equal(calls.some((c) => c.name === 'deadline.delete'), false);
});

test('create scopes to the organisation and defaults reminderDays', async () => {
  const { service, calls } = buildService();
  await service.create('org_1', { title: 'File CRO return', dueDate: '2026-09-30' } as never);

  const create = calls.find((c) => c.name === 'deadline.create');
  const data = (create?.args as { data: Record<string, unknown> }).data;
  assert.equal(data.organisationId, 'org_1');
  assert.deepEqual(data.reminderDays, [30, 14, 7]);
  assert.ok(data.dueDate instanceof Date);
});

test('marking a deadline complete sets completedDate; clearing it nulls completedDate', async () => {
  const completing = buildService();
  await completing.service.update('org_1', 'd1', { isComplete: true } as never);
  const completeData = (completing.calls.find((c) => c.name === 'deadline.update')?.args as {
    data: Record<string, unknown>;
  }).data;
  assert.equal(completeData.isComplete, true);
  assert.ok(completeData.completedDate instanceof Date);

  const reopening = buildService();
  await reopening.service.update('org_1', 'd1', { isComplete: false } as never);
  const reopenData = (reopening.calls.find((c) => c.name === 'deadline.update')?.args as {
    data: Record<string, unknown>;
  }).data;
  assert.equal(reopenData.completedDate, null);

  const editing = buildService();
  await editing.service.update('org_1', 'd1', { title: 'Renamed' } as never);
  const editData = (editing.calls.find((c) => c.name === 'deadline.update')?.args as {
    data: Record<string, unknown>;
  }).data;
  assert.equal(editData.completedDate, undefined, 'an edit that does not touch completion must not change completedDate');
});

test('list reports hasMore based on total versus the returned page', async () => {
  const page1 = buildService({ listData: new Array(50).fill({}), listTotal: 120 });
  const result1 = await page1.service.list('org_1', 1, 50);
  assert.equal(result1.hasMore, true);
  const where = (page1.calls.find((c) => c.name === 'deadline.findMany')?.args as { where: unknown }).where;
  assert.deepEqual(where, { organisationId: 'org_1' });

  const lastPage = buildService({ listData: new Array(20).fill({}), listTotal: 120 });
  const result2 = await lastPage.service.list('org_1', 3, 50);
  assert.equal(result2.hasMore, false);
});

test('generateAutoDeadlines derives Annual Report (FY end +10mo) and AGM (last AGM +15mo) deadlines', async () => {
  const { service, calls } = buildService({
    organisation: {
      id: 'org_1',
      financialYearEnd: new Date('2025-12-31T00:00:00Z'),
      lastAgmDate: new Date('2025-06-01T00:00:00Z'),
    },
    existingAuto: false,
  });

  await service.generateAutoDeadlines('org_1');

  const creates = calls.filter((c) => c.name === 'deadline.create');
  assert.equal(creates.length, 2, 'both auto-deadlines should be created when source data exists');

  const titles = creates.map((c) => (c.args as { data: { title: string } }).data.title);
  assert.ok(titles.some((t) => t.startsWith('Annual Report filing deadline (')));
  assert.ok(titles.includes('AGM due date'));
  const annualReportDeadline = creates.find((c) =>
    ((c.args as { data: { title: string } }).data.title).startsWith('Annual Report filing deadline ('),
  );
  const annualReportDescription = (annualReportDeadline?.args as { data: { description: string } }).data.description;
  assert.match(annualReportDescription, /Annual report - how to submit/);
  assert.match(annualReportDescription, /https:\/\/www\.charitiesregulator\.ie\/en\/information-for-charities\/annual-report-how-to-submit/);
  assert.match(annualReportDescription, /review-ready planning prompt/);

  for (const c of creates) {
    const data = (c.args as { data: Record<string, unknown> }).data;
    assert.equal(data.isAutoGenerated, true);
    assert.ok(data.dueDate instanceof Date);
  }

  // No stale cleanup should run when both source fields are present.
  assert.equal(calls.some((c) => c.name === 'deadline.deleteMany'), false);
});

test('generateAutoDeadlines removes stale auto-deadlines when the source data is missing', async () => {
  const { service, calls } = buildService({
    organisation: { id: 'org_1', financialYearEnd: null, lastAgmDate: null },
  });

  await service.generateAutoDeadlines('org_1');

  assert.equal(calls.some((c) => c.name === 'deadline.create'), false, 'nothing to create without source data');
  const del = calls.find((c) => c.name === 'deadline.deleteMany');
  assert.ok(del, 'stale auto-deadlines must be cleaned up');
  const where = (del.args as { where: { organisationId: string; isAutoGenerated: boolean; OR: unknown[] } }).where;
  assert.equal(where.organisationId, 'org_1');
  assert.equal(where.isAutoGenerated, true);
  assert.equal(where.OR.length, 2);
});

test('generateAutoDeadlines updates an existing auto-deadline instead of duplicating it', async () => {
  const { service, calls } = buildService({
    organisation: {
      id: 'org_1',
      financialYearEnd: new Date('2025-12-31T00:00:00Z'),
      lastAgmDate: null,
    },
    existingAuto: true,
  });

  await service.generateAutoDeadlines('org_1');

  assert.ok(calls.some((c) => c.name === 'deadline.update'), 'should update the existing auto-deadline');
  assert.equal(calls.some((c) => c.name === 'deadline.create'), false, 'must not create a duplicate');
});
