import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBillingAuthorityAllowsOwnershipChange } from '../services/billing-authority-interlock.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000700',
    organisationId: 'org-1',
    kind: 'CHECKOUT',
    state: 'CAPABILITY_ISSUED',
    actorUserId: 'owner-1',
    actorSessionId: 'session-owner-1',
    actorMembershipVersion: 7,
    providerResourceId: 'cs_authority_700',
    capabilityIssuedAt: new Date('2026-07-11T11:00:00.000Z'),
    safeReleaseAfter: new Date('2026-07-11T11:59:00.000Z'),
    ...overrides,
  };
}

test('ownership interlock locks the unresolved organisation grant and permits an empty state', async () => {
  let query: { sql?: string } | undefined;
  const tx = {
    $queryRaw: async (value: { sql?: string }) => {
      query = value;
      return [];
    },
  };

  assert.deepEqual(
    await assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    { autoReleasedGrantId: null, elapsedSafeGrantId: null },
  );
  assert.match(query?.sql ?? '', /FROM "BillingAuthorityGrant"/);
  assert.match(query?.sql ?? '', /"state" <> 'RELEASED'/);
  assert.match(query?.sql ?? '', /FOR UPDATE/);
});

test('Portal grants are never time-released and always require explicit restricted release', async () => {
  let updates = 0;
  const tx = {
    $queryRaw: async () => [grant({
      kind: 'PORTAL',
      safeReleaseAfter: new Date('2020-01-01T00:00:00.000Z'),
    })],
    billingAuthorityGrant: {
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
  };

  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    (error: unknown) => Boolean(
      error && typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE'
    ),
  );
  assert.equal(updates, 0);
});

test('Checkout remains blocking until its explicit safe-release time', async () => {
  const tx = {
    $queryRaw: async () => [grant({
      safeReleaseAfter: new Date('2026-07-11T12:00:01.000Z'),
    })],
  };

  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    (error: unknown) => Boolean(
      error && typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE'
    ),
  );
});

test('elapsed Checkout is atomically released with bounded system evidence before ownership proceeds', async () => {
  let updateArgs: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => [grant()],
    billingAuthorityGrant: {
      updateMany: async (args: Record<string, unknown>) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  };

  assert.deepEqual(
    await assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    {
      autoReleasedGrantId: '00000000-0000-4000-8000-000000000700',
      elapsedSafeGrantId: '00000000-0000-4000-8000-000000000700',
    },
  );
  assert.deepEqual(updateArgs?.where, {
    id: '00000000-0000-4000-8000-000000000700',
    organisationId: 'org-1',
    kind: 'CHECKOUT',
    state: 'CAPABILITY_ISSUED',
    providerResourceId: 'cs_authority_700',
    capabilityIssuedAt: new Date('2026-07-11T11:00:00.000Z'),
    safeReleaseAfter: { lte: NOW },
  });
  assert.deepEqual(updateArgs?.data, {
    state: 'RELEASED',
    releasedAt: NOW,
    releaseReason: 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED',
    releaseActor: 'SYSTEM:OWNERSHIP_INTERLOCK',
    releaseEvidence: {
      basis: 'EXPLICIT_SAFE_RELEASE_AFTER',
      safeReleaseAfter: '2026-07-11T11:59:00.000Z',
      ownershipInterlockCheckedAt: '2026-07-11T12:00:00.000Z',
      previousState: 'CAPABILITY_ISSUED',
    },
  });
});

test('pre-capability Checkout state can never use a malformed elapsed timestamp to bypass the interlock', async () => {
  let updates = 0;
  const tx = {
    $queryRaw: async () => [grant({
      state: 'PROVIDER_STARTED',
      providerResourceId: null,
      capabilityIssuedAt: null,
      safeReleaseAfter: new Date('2020-01-01T00:00:00.000Z'),
    })],
    billingAuthorityGrant: {
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
  };

  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    (error: unknown) => Boolean(
      error && typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE'
    ),
  );
  assert.equal(updates, 0);
});

test('recovery dry-run recognises elapsed Checkout safety without mutating evidence', async () => {
  let updates = 0;
  const tx = {
    $queryRaw: async () => [grant()],
    billingAuthorityGrant: {
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
  };

  assert.deepEqual(
    await assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', {
      now: NOW,
      releaseElapsedCheckout: false,
    }),
    {
      autoReleasedGrantId: null,
      elapsedSafeGrantId: '00000000-0000-4000-8000-000000000700',
    },
  );
  assert.equal(updates, 0);
});

test('multiple unresolved grants fail closed even if corrupt data bypassed the unique index', async () => {
  const tx = {
    $queryRaw: async () => [grant(), grant({ id: '00000000-0000-4000-8000-000000000701' })],
  };
  await assert.rejects(
    () => assertBillingAuthorityAllowsOwnershipChange(tx as never, 'org-1', { now: NOW }),
    (error: unknown) => Boolean(
      error && typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BILLING_AUTHORITY_STATE_CONFLICT'
    ),
  );
});
