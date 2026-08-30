import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-lifecycle-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-lifecycle-test';

const [{ transitionTenantLifecycle }] = await Promise.all([
  import('../services/owner-tenants.service.js'),
]);

// AppError's message text does not embed its `code` (see utils/errors.ts), so
// a RegExp match against the rejection would never hit these codes. Check the
// code property directly, matching the convention in
// tests/team-reliability.test.ts and tests/owner-tenants-list.test.ts.
const codeOf = (err: unknown) => (err as { code?: string })?.code;

const OPERATOR = { id: 'op-1', email: 'owner@example.org' };

function prismaStub(current: { lifecycleStatus: string; lifecycleVersion: number } | null) {
  const calls = { updates: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[] };
  const tx = {
    // Raw SQL can't be honoured against a real grammar in a stub, but it does
    // honour the one thing the test controls: whether the row exists at all
    // (`current === null` simulates an unknown tenant, matching the
    // TENANT_NOT_FOUND test below).
    $queryRaw: async () => (current ? [{ id: 'org-1', ...current }] : []),
    organisation: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.updates.push(data);
        return { id: 'org-1' };
      },
      // Reflects whatever `update` was actually called with, rather than a
      // status hardcoded to the happy path — so this stub can't accidentally
      // paper over the service returning the wrong new state.
      findUnique: async () => {
        const last = calls.updates[calls.updates.length - 1] as
          | { lifecycleStatus?: string }
          | undefined;
        const priorVersion = current?.lifecycleVersion ?? 1;
        return {
          id: 'org-1',
          name: 'Test Charity',
          lifecycleStatus: last?.lifecycleStatus ?? current?.lifecycleStatus ?? 'ACTIVE',
          lifecycleVersion: last ? priorVersion + 1 : priorVersion,
          createdAt: new Date('2026-01-01'),
          subscription: null,
          _count: { users: 1 },
        };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.audits.push(data);
        return data;
      },
    },
  };
  return {
    calls,
    prisma: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never,
  };
}

test('suspending writes the status and the audit event together', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  await transitionTenantLifecycle(prisma, {
    tenantId: 'org-1',
    action: 'SUSPEND',
    reason: 'Non-payment after dunning',
    expectedLifecycleVersion: 1,
    operator: OPERATOR,
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.audits.length, 1);
  const audit = calls.audits[0];
  assert.equal(audit.type, 'ORGANISATION_SUSPENDED');
  assert.equal(audit.actorKind, 'SUPPORT');
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.actorLabel, 'owner@example.org');
  assert.equal(audit.organisationId, 'org-1');
  assert.equal(audit.reason, 'Non-payment after dunning');
});

test('reactivating a suspended tenant restores ACTIVE and audits ORGANISATION_REACTIVATED', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'SUSPENDED', lifecycleVersion: 4 });
  await transitionTenantLifecycle(prisma, {
    tenantId: 'org-1',
    action: 'REACTIVATE',
    reason: 'Payment received, account reinstated',
    expectedLifecycleVersion: 4,
    operator: OPERATOR,
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].lifecycleStatus, 'ACTIVE');
  assert.equal(calls.audits.length, 1);
  const audit = calls.audits[0];
  assert.equal(audit.type, 'ORGANISATION_REACTIVATED');
  assert.equal(audit.actorKind, 'SUPPORT');
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.actorLabel, 'owner@example.org');
  assert.equal(audit.reason, 'Payment received, account reinstated');
});

test('closing an active tenant sets CLOSED and audits ORGANISATION_CLOSED', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  await transitionTenantLifecycle(prisma, {
    tenantId: 'org-1',
    action: 'CLOSE',
    reason: 'Charity dissolved; retention window begins',
    expectedLifecycleVersion: 1,
    operator: OPERATOR,
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].lifecycleStatus, 'CLOSED');
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].type, 'ORGANISATION_CLOSED');
});

test('a version mismatch is refused before any write', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 5 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    (e: unknown) => codeOf(e) === 'TENANT_LIFECYCLE_CONFLICT',
  );
  assert.equal(calls.updates.length, 0, 'no write may happen on a conflict');
  assert.equal(calls.audits.length, 0, 'no audit event may be written on a conflict');
});

test('an unknown tenant is refused', async () => {
  const { prisma } = prismaStub(null);
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'missing',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    (e: unknown) => codeOf(e) === 'TENANT_NOT_FOUND',
  );
});

test('an empty reason is refused', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: '   ',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    (e: unknown) => codeOf(e) === 'REASON_REQUIRED',
  );
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.audits.length, 0);
});

test('a closed tenant cannot be reopened from the console', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'CLOSED', lifecycleVersion: 3 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'REACTIVATE',
        reason: 'Customer returned',
        expectedLifecycleVersion: 3,
        operator: OPERATOR,
      }),
    (e: unknown) => codeOf(e) === 'TENANT_TRANSITION_NOT_ALLOWED',
  );
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.audits.length, 0);
});

test('suspending an already suspended tenant is refused', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'SUSPENDED', lifecycleVersion: 2 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 2,
        operator: OPERATOR,
      }),
    (e: unknown) => codeOf(e) === 'TENANT_TRANSITION_NOT_ALLOWED',
  );
  assert.equal(calls.updates.length, 0, 'no write may happen on a disallowed transition');
  assert.equal(calls.audits.length, 0, 'no audit event may be written on a disallowed transition');
});
