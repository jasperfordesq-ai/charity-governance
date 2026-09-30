import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemberService } from '../services/member.service.js';

const time = new Date('2026-09-29T10:00:00.000Z');

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-1', organisationId: 'org-1', name: 'PRIVATE_MEMBER_NAME',
    address: 'PRIVATE_HOME_ADDRESS', dateEntered: new Date('2025-01-01T00:00:00.000Z'),
    dateCeased: null, retentionDeleteAt: null, createdAt: time, updatedAt: time,
    ...overrides,
  };
}

test('member creation appends actor-bound history without copying particulars', async () => {
  let audit: Record<string, unknown> | undefined;
  const tx = {
    member: { create: async () => member() },
    governanceRegisterChangeAudit: { create: async ({ data }: { data: Record<string, unknown> }) => {
      audit = data; return {};
    } },
  };
  const service = new MemberService({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never);
  const created = await service.create('org-1', {
    name: 'PRIVATE_MEMBER_NAME', address: 'PRIVATE_HOME_ADDRESS', dateEntered: '2025-01-01',
  }, 'actor-1');
  assert.equal(created.id, 'member-1');
  assert.deepEqual(audit, {
    organisationId: 'org-1', recordKind: 'MEMBER', recordId: 'member-1', actorUserId: 'actor-1',
    action: 'CREATE', previousStatus: null, nextStatus: 'ACTIVE',
    changedFields: ['name', 'address', 'dateEntered'],
  });
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_MEMBER_NAME|PRIVATE_HOME_ADDRESS/);
});

test('member cessation does not create an unapproved retention deadline', async () => {
  let audit: Record<string, unknown> | undefined;
  let updateData: Record<string, unknown> | undefined;
  const current = member({ dateCeased: new Date('2026-09-29T00:00:00.000Z'),
    retentionDeleteAt: new Date('2027-09-29T00:00:00.000Z') });
  const tx = {
    member: {
      findFirst: async () => member(),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { updateData = data; return { count: 1 }; },
      findFirstOrThrow: async () => current,
    },
    governanceRegisterChangeAudit: { create: async ({ data }: { data: Record<string, unknown> }) => {
      audit = data; return {};
    } },
  };
  const service = new MemberService({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never);
  await service.update('org-1', 'member-1', { expectedUpdatedAt: time.toISOString(),
    dateCeased: '2026-09-29' }, 'actor-1');
  assert.equal(updateData?.retentionDeleteAt, null);
  assert.deepEqual(audit, {
    organisationId: 'org-1', recordKind: 'MEMBER', recordId: 'member-1', actorUserId: 'actor-1',
    action: 'UPDATE', previousStatus: 'ACTIVE', nextStatus: 'CEASED',
    changedFields: ['dateCeased', 'retentionDeleteAt'],
  });
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_MEMBER_NAME|PRIVATE_HOME_ADDRESS/);
});

test('legacy derived retention dates are not presented as approved deadlines', async () => {
  const service = new MemberService({ member: { findMany: async () => [member({
    dateCeased: new Date('2026-09-29T00:00:00.000Z'),
    retentionDeleteAt: new Date('2027-09-29T00:00:00.000Z'),
  })] } } as never);
  const listed = await service.list('org-1', true);
  assert.equal(listed[0]?.retentionDeleteAt, null);
  assert.equal(listed[0]?.dateCeased, '2026-09-29');
});

test('member mutation does not report success if history cannot be appended', async () => {
  const tx = {
    member: { create: async () => member() },
    governanceRegisterChangeAudit: { create: async () => { throw new Error('audit unavailable'); } },
  };
  const service = new MemberService({
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as never);
  await assert.rejects(() => service.create('org-1', {
    name: 'PRIVATE_MEMBER_NAME', dateEntered: '2025-01-01',
  }, 'actor-1'), /audit unavailable/);
});

test('member date edits validate the resulting register row before writing or auditing', async () => {
  for (const [current, patch] of [
    [member(), { dateCeased: '2024-12-31' }],
    [member({ dateCeased: new Date('2026-01-01T00:00:00.000Z') }), { dateEntered: '2026-01-02' }],
  ] as const) {
    let writes = 0;
    const tx = {
      member: {
        findFirst: async () => current,
        updateMany: async () => { writes += 1; return { count: 1 }; },
      },
      governanceRegisterChangeAudit: { create: async () => { writes += 1; return {}; } },
    };
    const service = new MemberService({
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as never);
    await assert.rejects(() => service.update('org-1', 'member-1', {
      expectedUpdatedAt: time.toISOString(), ...patch,
    }, 'actor-1'), (error: unknown) => (error as { code?: string }).code === 'MEMBER_DATE_ORDER_INVALID');
    assert.equal(writes, 0);
  }
});
