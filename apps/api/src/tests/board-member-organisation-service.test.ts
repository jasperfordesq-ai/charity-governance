import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'board-org-service-test-secret';

const { BoardMemberService } = await import('../services/board-member.service.js');
const { OrganisationService } = await import('../services/organisation.service.js');

type Call = { name: string; args: unknown };
const codeOf = (err: unknown) => (err as { code?: string })?.code;

// ── BoardMemberService ──

function boardPrisma(opts: {
  found?: boolean;
  member?: Record<string, unknown>;
  createError?: unknown;
  updateError?: unknown;
  deleteError?: unknown;
} = {}) {
  const calls: Call[] = [];
  const found = opts.found ?? true;
  const member = opts.member ?? {
    id: 'bm1',
    organisationId: 'org_1',
    appointedDate: new Date('2026-01-01'),
    termEndDate: null,
    conductSigned: false,
    conductSignedDate: null,
    inductionCompleted: false,
    inductionDate: null,
  };
  const transaction = {
    boardMember: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        calls.push({ name: 'boardMember.findFirst', args });
        return found ? { ...member, id: args.where.id, organisationId: args.where.organisationId } : null;
      },
      findMany: async (args: unknown) => { calls.push({ name: 'boardMember.findMany', args }); return []; },
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push({ name: 'boardMember.create', args });
        if (opts.createError) throw opts.createError;
        return { id: 'bm_new', ...args.data };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ name: 'boardMember.update', args });
        if (opts.updateError) throw opts.updateError;
        return { id: args.where.id, ...args.data };
      },
      delete: async (args: unknown) => {
        calls.push({ name: 'boardMember.delete', args });
        if (opts.deleteError) throw opts.deleteError;
        return {};
      },
    },
    conflictRecord: {
      updateMany: async (args: unknown) => {
        calls.push({ name: 'conflictRecord.updateMany', args });
        return { count: 1 };
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
  return { service: new BoardMemberService(prisma as never), calls };
}

test('board member update rejects a member from another organisation', async () => {
  const { service, calls } = boardPrisma({ found: false });
  await assert.rejects(
    () => service.update('org_attacker', 'bm_other', { name: 'X' } as never),
    (e: unknown) => codeOf(e) === 'BOARD_MEMBER_NOT_FOUND',
  );
  assert.equal(calls.some((c) => c.name === 'boardMember.update'), false);
});

test('board member remove rejects a member from another organisation', async () => {
  const { service, calls } = boardPrisma({ found: false });
  await assert.rejects(
    () => service.remove('org_attacker', 'bm_other'),
    (e: unknown) => codeOf(e) === 'BOARD_MEMBER_NOT_FOUND',
  );
  assert.equal(calls.some((c) => c.name === 'boardMember.delete'), false);
  assert.equal(calls.some((c) => c.name === 'conflictRecord.updateMany'), false);
});

test('board member create scopes to the organisation', async () => {
  const { service, calls } = boardPrisma();
  await service.create('org_1', { name: 'Mary', role: 'Chair', appointedDate: '2026-01-01' } as never);
  const create = calls.find((c) => c.name === 'boardMember.create');
  assert.equal((create?.args as { data: { organisationId: string } }).data.organisationId, 'org_1');
});

test('board member update normalises optional date fields (clear vs leave-untouched)', async () => {
  const { service, calls } = boardPrisma();
  await service.update('org_1', 'bm1', { termEndDate: '', name: 'Renamed' } as never);
  const data = (calls.find((c) => c.name === 'boardMember.update')?.args as { data: Record<string, unknown> }).data;
  assert.equal(data.termEndDate, null, 'an explicit empty termEndDate clears it');
  assert.equal(data.conductSignedDate, undefined, 'an untouched date field is left undefined');
});

test('board member update validates the merged persisted and patch state', async () => {
  const { service, calls } = boardPrisma({
    member: {
      appointedDate: new Date('2026-03-01'),
      termEndDate: null,
      conductSigned: true,
      conductSignedDate: new Date('2026-03-01'),
      inductionCompleted: false,
      inductionDate: null,
    },
  });

  await assert.rejects(
    () => service.update('org_1', 'bm1', { termEndDate: '2026-02-28' } as never),
    (error: unknown) =>
      codeOf(error) === 'VALIDATION_ERROR' &&
      (error as { statusCode?: number }).statusCode === 400,
  );
  assert.equal(calls.some((call) => call.name === 'boardMember.update'), false);
});

test('board member update rejects a boolean/date contradiction assembled across the patch boundary', async () => {
  const { service, calls } = boardPrisma({
    member: {
      appointedDate: new Date('2026-01-01'),
      termEndDate: null,
      conductSigned: true,
      conductSignedDate: new Date('2026-01-02'),
      inductionCompleted: false,
      inductionDate: null,
    },
  });

  await assert.rejects(
    () => service.update('org_1', 'bm1', { conductSigned: false } as never),
    (error: unknown) => codeOf(error) === 'VALIDATION_ERROR',
  );
  assert.equal(calls.some((call) => call.name === 'boardMember.update'), false);
});

test('board member removal detaches only same-organisation conflicts before deleting in one transaction', async () => {
  const { service, calls } = boardPrisma();
  await service.remove('org_1', 'bm1');

  assert.deepEqual(
    (calls.find((call) => call.name === 'conflictRecord.updateMany')?.args as { where: unknown; data: unknown }),
    {
      where: { organisationId: 'org_1', boardMemberId: 'bm1' },
      data: { boardMemberId: null },
    },
  );
  assert.ok(
    calls.findIndex((call) => call.name === 'conflictRecord.updateMany') <
      calls.findIndex((call) => call.name === 'boardMember.delete'),
  );
  assert.equal(calls.filter((call) => call.name === 'prisma.$transaction').length, 1);
  assert.ok(
    calls.findIndex((call) => call.name === '$queryRaw') <
      calls.findIndex((call) => call.name === 'boardMember.findFirst'),
    'the organisation lock must be acquired before reading the board member',
  );
  const lockArgs = calls.find((call) => call.name === '$queryRaw')?.args as [readonly string[], string];
  assert.match(lockArgs[0].join('?'), /SELECT "id"[\s\S]*FROM "Organisation"[\s\S]*WHERE "id" = \?[\s\S]*FOR UPDATE/u);
  assert.equal(lockArgs[1], 'org_1', 'the organisation id must remain a bound query parameter');
});

test('board member update maps a raced P2025 to BOARD_MEMBER_NOT_FOUND', async () => {
  const { service } = boardPrisma({ updateError: { code: 'P2025' } });
  await assert.rejects(
    () => service.update('org_1', 'bm1', { name: 'Changed' }),
    (error: unknown) =>
      codeOf(error) === 'BOARD_MEMBER_NOT_FOUND' &&
      (error as { statusCode?: number }).statusCode === 404,
  );
});

test('board member removal maps only the composite reference race to a retryable state conflict', async () => {
  const compositeRace = {
    code: 'P2003',
    meta: { field_name: 'ConflictRecord_boardMemberId_organisationId_fkey (index)' },
  };
  await assert.rejects(
    () => boardPrisma({ deleteError: compositeRace }).service.remove('org_1', 'bm1'),
    (error: unknown) =>
      codeOf(error) === 'BOARD_MEMBER_STATE_CONFLICT' &&
      (error as { statusCode?: number; message?: string }).statusCode === 409 &&
      /refresh and try again/i.test((error as { message?: string }).message ?? ''),
  );

  const unknown = { code: 'P2003', meta: { field_name: 'Some_other_fkey (index)' } };
  await assert.rejects(
    () => boardPrisma({ deleteError: unknown }).service.remove('org_1', 'bm1'),
    (error: unknown) => error === unknown,
  );
});

test('board member double-delete race returns the existing not-found contract', async () => {
  const { service } = boardPrisma({ deleteError: { code: 'P2025' } });
  await assert.rejects(
    () => service.remove('org_1', 'bm1'),
    (error: unknown) => codeOf(error) === 'BOARD_MEMBER_NOT_FOUND',
  );
});

// ── OrganisationService ──

function orgPrisma(opts: { org?: Record<string, unknown> | null; updateResult?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const tx = {
    $queryRaw: async (args: unknown) => {
      calls.push({ name: '$queryRaw', args });
      return [{ id: 'org_1' }];
    },
    organisation: {
      findUnique: async (args: unknown) => { calls.push({ name: 'organisation.findUnique', args }); return opts.org === undefined ? { id: 'org_1', name: 'Charity', updatedAt: new Date('2026-01-01T00:00:00.000Z') } : opts.org; },
      update: async (args: { data: Record<string, unknown> }) => { calls.push({ name: 'organisation.update', args }); return opts.updateResult ?? { id: 'org_1', name: 'Charity', updatedAt: new Date('2026-01-01T00:00:00.000Z') }; },
      findUniqueOrThrow: async (args: unknown) => {
        calls.push({ name: 'organisation.findUniqueOrThrow', args });
        return {
          financialYearEnd: null,
          legalForm: null,
          legalFormConfirmedAt: null,
          incorporationDate: null,
          memberCount: null,
          lastActualAgmDate: null,
          lastUnanimousAnnualMemberResolutionDate: null,
          croAnnualReturnDate: null,
          croAnnualReturnDateConfirmedAt: null,
        };
      },
    },
    deadline: {
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push({ name: 'prisma.$transaction', args: {} });
      return callback(tx);
    },
  };
  return { service: new OrganisationService(prisma as never), calls };
}

test('getOrganisation throws when the organisation does not exist', async () => {
  const { service } = orgPrisma({ org: null });
  await assert.rejects(() => service.getOrganisation('org_missing'), (e: unknown) => codeOf(e) === 'ORG_NOT_FOUND');
});

test('updateOrganisation regenerates auto-deadlines when the financial year end changes', async () => {
  const { service, calls } = orgPrisma();
  await service.updateOrganisation('org_1', {
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    financialYearEnd: '2026-12-31',
  } as never);
  assert.ok(
    calls.some((c) => c.name === 'organisation.findUniqueOrThrow'),
    'auto-deadline regeneration (which re-reads the org) must run when financialYearEnd changes',
  );
});

test('updateOrganisation does not regenerate auto-deadlines for unrelated edits', async () => {
  const { service, calls } = orgPrisma();
  await service.updateOrganisation('org_1', {
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    contactEmail: 'info@charity.ie',
  } as never);
  assert.equal(
    calls.some((c) => c.name === 'organisation.findUniqueOrThrow'),
    false,
    'editing an unrelated field must not trigger auto-deadline regeneration',
  );
});
