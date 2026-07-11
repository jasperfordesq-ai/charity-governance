import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'board-org-service-test-secret';

const { BoardMemberService } = await import('../services/board-member.service.js');
const { OrganisationService } = await import('../services/organisation.service.js');

type Call = { name: string; args: unknown };
const codeOf = (err: unknown) => (err as { code?: string })?.code;

// ── BoardMemberService ──

function boardPrisma(opts: { found?: boolean } = {}) {
  const calls: Call[] = [];
  const found = opts.found ?? true;
  const prisma = {
    boardMember: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        calls.push({ name: 'boardMember.findFirst', args });
        return found ? { id: args.where.id, organisationId: args.where.organisationId } : null;
      },
      findMany: async (args: unknown) => { calls.push({ name: 'boardMember.findMany', args }); return []; },
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => { calls.push({ name: 'boardMember.create', args }); return { id: 'bm_new', ...args.data }; },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => { calls.push({ name: 'boardMember.update', args }); return { id: args.where.id, ...args.data }; },
      delete: async (args: unknown) => { calls.push({ name: 'boardMember.delete', args }); return {}; },
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
