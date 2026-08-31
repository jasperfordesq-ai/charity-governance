import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-list-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-list-test';

// AppError's message text does not embed its `code` (see utils/errors.ts), so
// a RegExp match against the rejection would never hit TENANT_NOT_FOUND. Check
// the code property directly, matching the pattern already used in
// tests/board-member-organisation-service.test.ts.
const codeOf = (err: unknown) => (err as { code?: string })?.code;

const [{ listTenants, getTenant }] = await Promise.all([import('../services/owner-tenants.service.js')]);

type StubRow = {
  id: string;
  name: string;
  rcnNumber: string | null;
  croNumber: string | null;
  lifecycleStatus: string;
  lifecycleVersion: number;
  createdAt: Date;
  subscription: { plan: string; status: string; trialEndsAt: Date } | null;
  _count: { users: number };
};

const orgRow: StubRow = {
  id: 'org-1',
  name: 'Test Charity',
  rcnNumber: '12345',
  croNumber: null,
  lifecycleStatus: 'ACTIVE',
  lifecycleVersion: 1,
  createdAt: new Date('2026-01-01'),
  subscription: { plan: 'ESSENTIALS', status: 'TRIALING', trialEndsAt: new Date('2026-02-01') },
  _count: { users: 3 },
};

function prismaStub(rows: StubRow[] = [orgRow], capture: { args?: unknown } = {}) {
  return {
    organisation: {
      findMany: async (args: unknown) => {
        capture.args = args;
        return rows;
      },
      // Must honour the `where.id` it is given rather than returning a canned
      // row: a stub that ignores `where` tests the stub, not the service, and
      // would let getTenant pass even if it stopped filtering by id.
      findUnique: async (args: { where?: { id?: string } }) => {
        const id = args?.where?.id;
        return rows.find((row) => row.id === id) ?? null;
      },
    },
  } as never;
}

test('listing returns a flattened tenant summary', async () => {
  const result = await listTenants(prismaStub(), {});
  assert.equal(result.tenants.length, 1);
  assert.deepEqual(result.tenants[0], {
    id: 'org-1',
    name: 'Test Charity',
    lifecycleStatus: 'ACTIVE',
    lifecycleVersion: 1,
    plan: 'ESSENTIALS',
    subscriptionStatus: 'TRIALING',
    trialEndsAt: orgRow.subscription?.trialEndsAt,
    userCount: 3,
    createdAt: orgRow.createdAt,
  });
});

test('a tenant with no subscription still lists', async () => {
  const rows = [{ ...orgRow, subscription: null }];
  const result = await listTenants(prismaStub(rows), {});
  assert.equal(result.tenants[0].plan, null);
  assert.equal(result.tenants[0].subscriptionStatus, null);
});

test('a search term filters on name, RCN, CRO and owner email', async () => {
  const capture: { args?: unknown } = {};
  await listTenants(prismaStub([orgRow], capture), { q: 'test' });
  const where = (capture.args as { where?: { OR?: unknown[] } }).where;
  assert.ok(Array.isArray(where?.OR));
  assert.equal(where?.OR?.length, 4);
});

test('a status filter is applied', async () => {
  const capture: { args?: unknown } = {};
  await listTenants(prismaStub([orgRow], capture), { status: 'SUSPENDED' });
  const where = (capture.args as { where?: { lifecycleStatus?: string } }).where;
  assert.equal(where?.lifecycleStatus, 'SUSPENDED');
});

test('nextCursor is null when the page is not full', async () => {
  const result = await listTenants(prismaStub(), { limit: 50 });
  assert.equal(result.nextCursor, null);
});

test('getTenant returns null-safe detail for an unknown id', async () => {
  // Real store that simply does not contain the requested id, rather than a
  // stub hardwired to return null regardless of what was asked for.
  const prisma = prismaStub([orgRow]);
  await assert.rejects(() => getTenant(prisma, 'missing'), (e: unknown) => codeOf(e) === 'TENANT_NOT_FOUND');
});
