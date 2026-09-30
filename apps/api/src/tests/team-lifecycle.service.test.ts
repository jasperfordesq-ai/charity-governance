import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamLifecycleService } from '../services/team-lifecycle.service.js';
import { AppError } from '../utils/errors.js';
import { authRecoverySecretFingerprint } from '../services/password-recovery-crypto.js';

process.env.AUTH_RECOVERY_SECRET = 'ab'.repeat(32);
const AUTH_RECOVERY_CONTROL = {
  id: 1,
  blocked: false,
  generation: 1,
  activeSecretFingerprint: authRecoverySecretFingerprint(),
  retiredSecretFingerprint: null,
};

type LockedUserFixture = {
  id: string;
  organisationId: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  membershipVersion: number;
  membershipChangedAt: Date;
  emailVerified: boolean;
  createdAt: Date;
};

function userFixture(overrides: Partial<LockedUserFixture> = {}): LockedUserFixture {
  return {
    id: 'member-1',
    organisationId: 'org-1',
    email: 'member@example.org',
    name: 'Member One',
    role: 'MEMBER',
    lifecycleStatus: 'ACTIVE',
    membershipVersion: 4,
    membershipChangedAt: new Date('2026-07-10T10:00:00.000Z'),
    emailVerified: true,
    createdAt: new Date('2025-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

const owner = (overrides: Partial<LockedUserFixture> = {}) => userFixture({
  id: 'owner-1',
  email: 'owner@example.org',
  name: 'Owner One',
  role: 'OWNER',
  membershipVersion: 7,
  ...overrides,
});

test('suspension locks organisation then users and atomically revokes sessions, reminders, and audit', async () => {
  const actor = owner({ name: `${'O'.repeat(159)} ${'A'.repeat(40)}` });
  const target = userFixture({ name: `${'M'.repeat(159)} ${'B'.repeat(40)}` });
  const events: Array<{ name: string; args?: unknown }> = [];
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      events.push({
        name: rawCall === 1
          ? 'lock-recovery-control'
          : rawCall === 2
            ? 'lock-organisation'
            : rawCall === 3
              ? 'lock-users'
              : 'lock-recovery',
      });
      if (rawCall === 1) return [AUTH_RECOVERY_CONTROL];
      if (rawCall === 2) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 3) return [target, actor].sort((left, right) => left.id.localeCompare(right.id));
      return [{ id: 'recovery-1' }, { id: 'recovery-2' }];
    },
    user: {
      update: async (args: { data: Record<string, unknown> }) => {
        events.push({ name: 'update-user', args });
        return {
          ...target,
          lifecycleStatus: 'SUSPENDED',
          membershipVersion: 5,
          membershipChangedAt: new Date('2026-07-11T01:00:00.000Z'),
        };
      },
    },
    passwordRecoveryRequest: {
      updateMany: async (args: unknown) => {
        events.push({ name: 'terminate-recovery', args });
        return { count: 2 };
      },
    },
    authSession: {
      updateMany: async (args: unknown) => {
        events.push({ name: 'revoke-sessions', args });
        return { count: 2 };
      },
    },
    deadlineReminderLog: {
      updateMany: async (args: unknown) => {
        events.push({ name: 'skip-reminders', args });
        return { count: 1 };
      },
    },
    securityAuditEvent: {
      create: async (args: unknown) => {
        events.push({ name: 'append-audit', args });
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamLifecycleService(prisma as never).suspendMember({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: target.id,
    expectedMembershipVersion: 4,
    reason: 'Membership access is paused during a governance review.',
    requestId: 'request-1',
  });

  assert.deepEqual(events.map((event) => event.name), [
    'lock-recovery-control',
    'lock-organisation',
    'lock-users',
    'lock-recovery',
    'update-user',
    'terminate-recovery',
    'revoke-sessions',
    'skip-reminders',
    'append-audit',
  ]);
  const sessionData = (events.find((event) => event.name === 'revoke-sessions')?.args as {
    data: { revocationReason: string; revokedAt: Date };
  }).data;
  assert.equal(sessionData.revocationReason, 'MEMBER_SUSPENDED');
  const recoveryData = (events.find((event) => event.name === 'terminate-recovery')?.args as {
    where: { userId: string; organisationId: string; terminatedAt: null };
    data: { terminationReason: string; terminatedAt: Date };
  });
  assert.deepEqual(recoveryData.where, {
    userId: target.id,
    organisationId: 'org-1',
    terminatedAt: null,
  });
  assert.equal(recoveryData.data.terminationReason, 'ACCOUNT_INACTIVE');
  assert.ok(recoveryData.data.terminatedAt instanceof Date);
  assert.ok(sessionData.revokedAt instanceof Date);
  const reminderWhere = (events.find((event) => event.name === 'skip-reminders')?.args as {
    where: { organisationId: string; userId: string; status: string };
  }).where;
  assert.deepEqual(reminderWhere, {
    organisationId: 'org-1',
    userId: 'member-1',
    status: 'RESERVED',
  });
  const auditData = (events.find((event) => event.name === 'append-audit')?.args as {
    data: {
      type: string;
      actorUserId: string;
      actorLabel: string;
      subjectUserId: string;
      subjectLabel: string;
      reason: string;
    };
  }).data;
  assert.equal(auditData.type, 'MEMBER_SUSPENDED');
  assert.equal(auditData.actorUserId, actor.id);
  assert.equal(auditData.actorLabel, 'O'.repeat(159));
  assert.equal(auditData.subjectLabel, 'M'.repeat(159));
  assert.equal(auditData.actorLabel, auditData.actorLabel.trim());
  assert.equal(auditData.subjectLabel, auditData.subjectLabel.trim());
  assert.equal(auditData.subjectUserId, target.id);
  assert.equal(result.lifecycleStatus, 'SUSPENDED');
  assert.equal(result.membershipVersion, 5);
});

test('ownership transfer retries serializable conflicts, demotes before promotion, revokes both principals, and appends one event', async () => {
  const actor = owner();
  const target = userFixture({ id: 'admin-1', role: 'ADMIN', membershipVersion: 3 });
  let rawCall = 0;
  const lockOrder: string[] = [];
  const roleWrites: Array<{ id: string; role: string }> = [];
  const revocations: string[] = [];
  let auditData: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        lockOrder.push('organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      }
      if (rawCall === 2) {
        lockOrder.push('billing-authority-grant');
        return [];
      }
      lockOrder.push('users');
      return [target, actor].sort((left, right) => left.id.localeCompare(right.id));
    },
    user: {
      update: async ({ where, data }: { where: { id: string }; data: { role: 'OWNER' | 'ADMIN' } }) => {
        roleWrites.push({ id: where.id, role: data.role });
        const source = where.id === actor.id ? actor : target;
        return { ...source, role: data.role, membershipVersion: source.membershipVersion + 1 };
      },
    },
    authSession: {
      updateMany: async ({ where, data }: { where: { userId: string }; data: { revocationReason: string } }) => {
        assert.equal(data.revocationReason, 'OWNERSHIP_CHANGED');
        revocations.push(where.userId);
        return { count: 1 };
      },
    },
    deadlineReminderLog: { updateMany: async () => ({ count: 1 }) },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditData = data;
        return {};
      },
    },
  };
  let transactionAttempts = 0;
  const isolationLevels: unknown[] = [];
  const prisma = {
    $transaction: async (
      callback: (client: unknown) => Promise<unknown>,
      options: { isolationLevel?: unknown },
    ) => {
      transactionAttempts += 1;
      isolationLevels.push(options.isolationLevel);
      if (transactionAttempts < 3) {
        throw Object.assign(new Error('serializable write conflict'), { code: 'P2034' });
      }
      return callback(tx);
    },
  };

  const result = await new TeamLifecycleService(prisma as never).transferOwnership({
    organisationId: 'org-1',
    actorId: actor.id,
    targetMemberId: target.id,
    expectedCurrentOwnerVersion: 7,
    expectedTargetVersion: 3,
    reason: 'The board approved transfer to the incoming accountable owner.',
    requestId: 'request-transfer',
  });

  assert.deepEqual(roleWrites, [
    { id: actor.id, role: 'ADMIN' },
    { id: target.id, role: 'OWNER' },
  ]);
  assert.deepEqual(lockOrder, ['organisation', 'billing-authority-grant', 'users']);
  assert.deepEqual(revocations, [actor.id, target.id]);
  assert.equal(auditData?.type, 'OWNERSHIP_TRANSFERRED');
  assert.equal(auditData?.actorUserId, actor.id);
  assert.equal(auditData?.subjectLabel, 'Member One');
  assert.equal(auditData?.subjectUserId, target.id);
  assert.equal(transactionAttempts, 3);
  assert.deepEqual(isolationLevels, ['Serializable', 'Serializable', 'Serializable']);
  assert.equal(result.previousOwner.role, 'ADMIN');
  assert.equal(result.newOwner.role, 'OWNER');
});

test('ownership transfer bounds serializable retries and returns a stable conflict response', async () => {
  let attempts = 0;
  const prisma = {
    $transaction: async () => {
      attempts += 1;
      throw Object.assign(new Error('serializable write conflict'), { code: 'P2034' });
    },
  };

  await assert.rejects(
    () => new TeamLifecycleService(prisma as never).transferOwnership({
      organisationId: 'org-1',
      actorId: 'owner-1',
      targetMemberId: 'admin-1',
      expectedCurrentOwnerVersion: 7,
      expectedTargetVersion: 3,
      reason: 'The transfer should not retry without a bound.',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === 'OWNERSHIP_WRITE_CONFLICT',
  );
  assert.equal(attempts, 3);
});

test('ownership transfer refuses unresolved billing capability before locking or changing users', async () => {
  const locks: string[] = [];
  let rawCall = 0;
  let userWrites = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        locks.push('organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      }
      locks.push('billing-authority-grant');
      return [{
        id: '00000000-0000-4000-8000-000000000702',
        organisationId: 'org-1',
        kind: 'PORTAL',
        state: 'CAPABILITY_ISSUED',
        actorUserId: 'owner-1',
        actorSessionId: 'session-owner-1',
        actorMembershipVersion: 7,
        safeReleaseAfter: null,
      }];
    },
    user: {
      update: async () => {
        userWrites += 1;
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };

  await assert.rejects(
    () => new TeamLifecycleService(prisma as never).transferOwnership({
      organisationId: 'org-1',
      actorId: 'owner-1',
      targetMemberId: 'admin-1',
      expectedCurrentOwnerVersion: 7,
      expectedTargetVersion: 3,
      reason: 'Board-approved transfer cannot outrun provider billing authority.',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE',
  );
  assert.deepEqual(locks, ['organisation', 'billing-authority-grant']);
  assert.equal(userWrites, 0);
});

test('reactivation fails closed when the Essentials capacity is already reserved', async () => {
  const actor = owner();
  const target = userFixture({ lifecycleStatus: 'SUSPENDED' });
  let rawCall = 0;
  let userUpdated = false;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) {
        return [{
          plan: 'ESSENTIALS',
          status: 'ACTIVE',
          trialEndsAt: null,
          currentPeriodEnd: null,
        }];
      }
      return [target, actor].sort((left, right) => left.id.localeCompare(right.id));
    },
    user: {
      count: async () => 4,
      update: async () => {
        userUpdated = true;
        return target;
      },
    },
    teamInvite: { count: async () => 1 },
  };
  const prisma = { $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) };

  await assert.rejects(
    () => new TeamLifecycleService(prisma as never).reactivateMember({
      organisationId: 'org-1',
      actorId: actor.id,
      targetUserId: target.id,
      expectedMembershipVersion: target.membershipVersion,
      reason: 'The governance review is complete and access may be restored.',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === 'TEAM_MEMBER_LIMIT_EXCEEDED',
  );
  assert.equal(userUpdated, false);
});

test('role changes reauthorize the live owner and bind the optimistic version to one tenant member', async () => {
  const actor = owner();
  const target = userFixture({ role: 'MEMBER', membershipVersion: 4 });
  let rawCall = 0;
  let updateData: Record<string, unknown> | undefined;
  let auditData: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }]
        : [target, actor].sort((left, right) => left.id.localeCompare(right.id));
    },
    user: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateData = data;
        return { ...target, role: 'ADMIN', membershipVersion: 5 };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditData = data;
        return {};
      },
    },
  };
  const prisma = { $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) };

  const result = await new TeamLifecycleService(prisma as never).changeMemberRole({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: target.id,
    role: 'ADMIN',
    expectedMembershipVersion: 4,
    reason: 'The board approved administrator access for this member.',
  });

  assert.deepEqual(updateData, { role: 'ADMIN' });
  assert.equal(auditData?.type, 'MEMBER_ROLE_CHANGED');
  assert.equal(auditData?.actorUserId, actor.id);
  assert.equal(auditData?.subjectUserId, target.id);
  assert.equal(result.role, 'ADMIN');
  assert.equal(result.membershipVersion, 5);
  assert.equal('activeSessionCount' in result, false);
});

test('role changes reject stale, cross-tenant, self, non-owner, owner-target, and inactive cases before writing', async (t) => {
  const scenarios: Array<{
    name: string;
    actor: LockedUserFixture;
    target?: LockedUserFixture;
    targetUserId?: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    expectedVersion?: number;
    code: string;
  }> = [
    { name: 'non-owner actor', actor: userFixture({ id: 'admin-actor', role: 'ADMIN' }), target: userFixture(), code: 'FORBIDDEN' },
    { name: 'cross-tenant target absent', actor: owner(), target: undefined, targetUserId: 'foreign-user', code: 'MEMBER_NOT_FOUND' },
    { name: 'self change', actor: owner(), target: owner(), targetUserId: 'owner-1', code: 'CANNOT_CHANGE_OWN_ROLE' },
    { name: 'owner role requested', actor: owner(), target: userFixture(), role: 'OWNER', code: 'OWNER_CONTINUITY_REQUIRED' },
    { name: 'owner target', actor: owner(), target: userFixture({ id: 'owner-2', role: 'OWNER' }), code: 'OWNER_CONTINUITY_REQUIRED' },
    { name: 'inactive target', actor: owner(), target: userFixture({ lifecycleStatus: 'SUSPENDED' }), code: 'MEMBERSHIP_STATE_CONFLICT' },
    { name: 'stale version', actor: owner(), target: userFixture({ membershipVersion: 8 }), expectedVersion: 4, code: 'MEMBERSHIP_VERSION_CONFLICT' },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let rawCall = 0;
      let writes = 0;
      const targetUserId = scenario.targetUserId ?? scenario.target?.id ?? 'member-1';
      const rows = [scenario.actor, ...(scenario.target ? [scenario.target] : [])]
        .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index)
        .sort((left, right) => left.id.localeCompare(right.id));
      const tx = {
        $queryRaw: async () => {
          rawCall += 1;
          return rawCall === 1
            ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }]
            : rows;
        },
        user: { update: async () => { writes += 1; return scenario.target; } },
      };
      const prisma = { $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) };
      await assert.rejects(
        () => new TeamLifecycleService(prisma as never).changeMemberRole({
          organisationId: 'org-1',
          actorId: scenario.actor.id,
          targetUserId,
          role: scenario.role ?? 'ADMIN',
          expectedMembershipVersion: scenario.expectedVersion ?? 4,
          reason: 'Governance role change reviewed by the accountable owner.',
        }),
        (error: unknown) => error instanceof AppError && error.code === scenario.code,
      );
      assert.equal(writes, 0);
    });
  }
});

test('per-family revocation is tenant-scoped, version-bound, and audit-coupled', async () => {
  const actor = owner();
  const target = userFixture({ id: 'admin-1', role: 'ADMIN' });
  const familyId = '00000000-0000-4000-8000-000000000100';
  let rawCall = 0;
  let revokedData: Record<string, unknown> | undefined;
  let auditData: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [target, actor].sort((left, right) => left.id.localeCompare(right.id));
      return [{ id: 'session-1', revokedAt: null }];
    },
    authSession: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        revokedData = data;
        return { count: 1 };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditData = data;
        return {};
      },
    },
  };
  const prisma = { $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) };

  const result = await new TeamLifecycleService(prisma as never).revokeSessionFamily({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: target.id,
    familyId,
    expectedMembershipVersion: target.membershipVersion,
    reason: 'The device is no longer controlled by this administrator.',
  });

  assert.equal(revokedData?.revocationReason, 'ADMIN_SESSION_REVOKED');
  assert.equal(auditData?.type, 'SESSION_REVOKED');
  assert.equal(auditData?.subjectSessionId, familyId);
  assert.deepEqual(result, {
    familyId,
    revokedSessionCount: 1,
    revokedCurrentSession: false,
  });
});

test('self-service session revocation records user intent rather than administrator action', async () => {
  const actor = userFixture({ id: 'member-self' });
  const familyId = '00000000-0000-4000-8000-000000000101';
  let rawCall = 0;
  let revocationReason: string | undefined;
  let auditContext: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [actor];
      return [{ id: 'current-session', revokedAt: null }];
    },
    authSession: {
      updateMany: async ({ data }: { data: { revocationReason: string } }) => {
        revocationReason = data.revocationReason;
        return { count: 1 };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: { context: Record<string, unknown> } }) => {
        auditContext = data.context;
        return {};
      },
    },
  };
  const prisma = { $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx) };

  const result = await new TeamLifecycleService(prisma as never).revokeSessionFamily({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: actor.id,
    familyId,
    currentSessionId: 'current-session',
    expectedMembershipVersion: actor.membershipVersion,
    reason: 'I no longer recognise or control this signed-in device.',
  });

  assert.equal(revocationReason, 'USER_SESSION_REVOKED');
  assert.equal(auditContext?.initiatedBy, 'SELF');
  assert.equal(result.revokedCurrentSession, true);
});

test('members cannot inspect another member session inventory', async () => {
  const actor = userFixture({ id: 'member-actor' });
  const target = userFixture({ id: 'member-target' });
  let rawCall = 0;
  let sessionRead = false;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) {
        return [actor, target].sort((left, right) => left.id.localeCompare(right.id));
      }
      sessionRead = true;
      return [];
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };

  await assert.rejects(
    () => new TeamLifecycleService(prisma as never).listSessions({
      organisationId: 'org-1',
      actorId: actor.id,
      targetUserId: target.id,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
  );
  assert.equal(sessionRead, false);
});

test('session inventory exposes only a non-reversible display suffix, never a session id', async () => {
  const actor = owner();
  const familyId = '00000000-0000-4000-8000-000000000123';
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [actor];
      return [{
        familyId,
        familyCreatedAt: new Date('2026-07-11T01:00:00.000Z'),
        deviceLabel: 'Trustee laptop',
        expiresAt: new Date('2026-07-18T01:00:00.000Z'),
        active: true,
        current: true,
        revokedAt: null,
        revocationReason: null,
        latestCreatedAt: new Date('2026-07-11T02:03:04.000Z'),
      }];
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamLifecycleService(prisma as never).listSessions({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: actor.id,
    currentSessionId: 'internal-session-id',
  });

  assert.equal(result.length, 1);
  assert.match(result[0].displaySuffix, /^[A-F0-9]{6}$/);
  assert.equal(result[0].current, true);
  assert.equal('latestSessionId' in result[0], false);
  assert.equal(JSON.stringify(result).includes('internal-session-id'), false);
});

test('session inventory returns a deterministic bounded family summary instead of rotation history', async () => {
  const actor = owner();
  let rawCall = 0;
  let summaryQuery: { sql: string; values: unknown[] } | undefined;
  const summaries = Array.from({ length: 50 }, (_, index) => ({
    familyId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    familyCreatedAt: new Date(Date.UTC(2026, 6, 11, 12, 0, 0, -index)),
    latestCreatedAt: new Date(Date.UTC(2026, 6, 11, 12, 0, 1, -index)),
    expiresAt: new Date('2026-07-18T12:00:00.000Z'),
    deviceLabel: null,
    active: index === 0,
    current: index === 49,
    revokedAt: index === 0 ? null : new Date('2026-07-11T13:00:00.000Z'),
    revocationReason: index === 0 ? null : 'ROTATED',
  }));
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [actor];
      summaryQuery = { sql: strings.join('?'), values };
      return summaries;
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamLifecycleService(prisma as never).listSessions({
    organisationId: 'org-1',
    actorId: actor.id,
    targetUserId: actor.id,
    currentSessionId: 'session-from-a-large-historical-family',
  });

  assert.equal(result.length, 50);
  assert.equal(result.filter((family) => family.current).length, 1);
  assert.match(summaryQuery?.sql ?? '', /WITH current_family AS MATERIALIZED/);
  assert.match(summaryQuery?.sql ?? '', /recent_families AS MATERIALIZED[\s\S]*SELECT DISTINCT/);
  assert.match(summaryQuery?.sql ?? '', /selected_families AS MATERIALIZED[\s\S]*LIMIT \?/);
  assert.match(summaryQuery?.sql ?? '', /CROSS JOIN LATERAL[\s\S]*LIMIT 1/);
  assert.match(summaryQuery?.sql ?? '', /LEFT JOIN LATERAL[\s\S]*"revokedAt" IS NULL/);
  assert.ok((summaryQuery?.values ?? []).filter((value) => value === 50).length >= 2);
});

test('replay diagnostics require an active Admin and expose only bounded correlation facts', async () => {
  const familyId = 'a6c790d4-89af-4a85-9e32-61ec5a4e51fb';
  const event = {
    id: 'event-replay-1',
    occurredAt: new Date('2026-09-28T14:00:00.000Z'),
    subjectSessionId: familyId,
    subjectUserId: 'private-user-id',
    context: {
      clientKind: 'WEB', accessLevel: 'ADMIN', requestId: 'req-123', previousRevocationReason: 'ROTATED',
      presentedSessionRevokedAt: '2026-09-28T13:59:58.000Z',
      presentedSessionFingerprint: 'A1B2C3D4E5F6', newlyQuarantinedSessionCount: 0,
      refreshToken: 'private-token',
    },
  };
  let reads = 0;
  let query: Record<string, unknown> | undefined;
  const run = (actor: LockedUserFixture) => {
    let lockCall = 0;
    const tx = {
      $queryRaw: async () => (++lockCall === 1
        ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }]
        : [actor]),
      securityAuditEvent: { findMany: async (args: Record<string, unknown>) => {
        reads++;
        query = args;
        return [event, { ...event, id: 'event-replay-2', context: {
          clientKind: 'FAKE', requestId: 'secret\nheader', previousRevocationReason: 'UNKNOWN',
          presentedSessionRevokedAt: 'not-a-date',
          presentedSessionFingerprint: 'malformed', newlyQuarantinedSessionCount: -1,
        }, subjectSessionId: 'invalid' }];
      } },
    };
    return new TeamLifecycleService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never)
      .listReplayDiagnostics('org-1', actor.id);
  };

  await assert.rejects(() => run(userFixture()), (error: unknown) => error instanceof AppError && error.statusCode === 403);
  assert.equal(reads, 0, 'Member refusal must happen before reading replay events');

  const page = await run(owner());
  const result = page.data;
  assert.deepEqual(query, {
    where: { organisationId: 'org-1', type: 'SESSION_REPLAY_DETECTED' },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 51,
    select: { id: true, occurredAt: true, subjectSessionId: true, context: true },
  });
  assert.equal(page.nextCursor, null);
  assert.equal(result[0].eventId, 'event-replay-1');
  assert.equal(result[1].eventId, 'event-replay-2');
  assert.equal(result[0].requestId, 'req-123');
  assert.equal(result[0].previousRevocationReason, 'ROTATED');
  assert.equal(result[0].presentedSessionRevokedAt, '2026-09-28T13:59:58.000Z');
  assert.equal(result[0].presentedSessionFingerprint, 'A1B2C3D4E5F6');
  assert.equal(result[0].newlyQuarantinedSessionCount, 0);
  assert.match(result[0].familyFingerprint ?? '', /^[A-F0-9]{12}$/);
  assert.equal(result[1].requestId, null);
  assert.equal(result[1].familyFingerprint, null);
  assert.equal(result[1].clientKind, null);
  assert.equal(result[1].previousRevocationReason, null);
  assert.equal(result[1].presentedSessionRevokedAt, null);
  assert.equal(result[1].presentedSessionFingerprint, null);
  assert.equal(result[1].newlyQuarantinedSessionCount, null);
  assert.doesNotMatch(JSON.stringify(result), /private-user-id|private-token|a6c790d4|secret/);
});

test('replay diagnostics page older events in stable timestamp and ID order with a tenant-bound cursor', async () => {
  const occurredAt = new Date('2026-09-28T14:00:00.000Z');
  const events = Array.from({ length: 52 }, (_, index) => ({
    id: `event-${String(52 - index).padStart(3, '0')}`, occurredAt,
    subjectSessionId: null, context: null,
  }));
  const queries: Record<string, unknown>[] = [];
  let lockCall = 0;
  const tx = {
    $queryRaw: async () => (++lockCall % 2 === 1)
      ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }] : [owner()],
    securityAuditEvent: {
      findFirst: async (args: { where: { id: string; organisationId: string; type: string } }) =>
        args.where.organisationId === 'org-1' && args.where.type === 'SESSION_REPLAY_DETECTED'
          ? events.find((event) => event.id === args.where.id) ?? null : null,
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = args.where as { OR?: [{ occurredAt: { lt: Date } }, { occurredAt: Date; id: { lt: string } }] };
        return events.filter((event) => !where.OR || event.id < where.OR[1].id.lt).slice(0, 51);
      },
    },
  };
  const service = new TeamLifecycleService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never);
  const first = await service.listReplayDiagnostics('org-1', owner().id);
  assert.equal(first.data.length, 50);
  assert.equal(first.nextCursor, 'event-003');
  const second = await service.listReplayDiagnostics('org-1', owner().id, first.nextCursor!);
  assert.deepEqual(second.data.map((event) => event.eventId), ['event-002', 'event-001']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((queries[1].where as { OR: unknown }).OR, [
    { occurredAt: { lt: occurredAt } },
    { occurredAt, id: { lt: 'event-003' } },
  ]);
  await assert.rejects(() => service.listReplayDiagnostics('org-1', owner().id, 'other-tenant-event'),
    (error: unknown) => error instanceof AppError && error.statusCode === 404);
  assert.equal(queries.length, 2, 'an invalid cursor must not read a page');
});

test('browser security audit returns the immutable subject snapshot after a member name change and omits raw evidence', async () => {
  const actor = owner();
  let rawCall = 0;
  let findArgs: { take?: number; select?: Record<string, boolean> } | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall === 1
        ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }]
        : [actor];
    },
    securityAuditEvent: {
      findMany: async (args: { take?: number; select?: Record<string, boolean> }) => {
        findArgs = args;
        return [{
          id: 'internal-event-id',
          type: 'MEMBER_SUSPENDED',
          actorKind: 'USER',
          actorLabel: 'Owner One',
          actorUserId: actor.id,
          subjectUserId: 'member-1',
          subjectLabel: 'Member One at event time',
          subjectUser: { name: 'Renamed Member', email: 'renamed@example.test' },
          subjectSessionId: 'internal-family-id',
          reason: 'Governance review requires temporary suspension.',
          context: { internalGrantId: 'grant-secret' },
          requestId: 'internal-request-id',
          occurredAt: new Date('2026-07-11T02:03:04.000Z'),
        }, {
          type: 'ALL_SESSIONS_REVOKED',
          actorKind: 'SYSTEM',
          actorLabel: 'Self-service recovery',
          subjectLabel: 'Owner One',
          reason: 'Password reset completed using a one-time recovery link.',
          context: {
            eventKind: 'PASSWORD_RESET_COMPLETED',
            method: 'PASSWORD_RECOVERY_LINK',
          },
          occurredAt: new Date('2026-07-11T02:02:00.000Z'),
        }, {
          type: 'ALL_SESSIONS_REVOKED',
          actorKind: 'USER',
          actorLabel: 'Untrusted marker',
          subjectLabel: 'Owner One',
          reason: 'Ordinary session revocation.',
          context: {
            eventKind: 'PASSWORD_RESET_COMPLETED',
            method: 'PASSWORD_RECOVERY_LINK',
          },
          occurredAt: new Date('2026-07-11T02:01:00.000Z'),
        }, {
          type: 'ALL_SESSIONS_REVOKED',
          actorKind: 'USER',
          actorLabel: 'Owner One',
          subjectLabel: 'Owner One',
          reason: 'Account password changed; all sessions ended.',
          context: { eventKind: 'PASSWORD_CHANGED', revokedSessionCount: 3 },
          occurredAt: new Date('2026-07-11T02:00:00.000Z'),
        }];
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };

  const result = await new TeamLifecycleService(prisma as never).listSecurityAudit(
    'org-1',
    actor.id,
  );

  assert.equal(findArgs?.take, 51);
  assert.deepEqual(findArgs?.select, {
    id: true,
    type: true,
    actorKind: true,
    actorLabel: true,
    subjectLabel: true,
    reason: true,
    context: true,
    occurredAt: true,
  });
  assert.deepEqual(Object.keys(result.data[0]).sort(), [
    'actorLabel',
    'occurredAt',
    'reason',
    'subjectLabel',
    'type',
  ]);
  assert.equal(result.data[0].subjectLabel, 'Member One at event time');
  assert.equal(result.data[1].type, 'PASSWORD_RESET_COMPLETED');
  assert.equal(result.data[2].type, 'ALL_SESSIONS_REVOKED');
  assert.equal(result.data[3].type, 'PASSWORD_CHANGED');
  assert.equal(result.nextCursor, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /internal-event-id|member-1|internal-family-id|grant-secret|internal-request-id|Renamed Member|renamed@example/,
  );
});

test('security audit pages retained events in stable tenant-bound order and checks current role first', async () => {
  const occurredAt = new Date('2026-07-11T02:03:04.000Z');
  const events = Array.from({ length: 52 }, (_, index) => ({
    id: `event-${String(52 - index).padStart(3, '0')}`,
    type: 'SESSION_REVOKED',
    actorKind: 'USER',
    actorLabel: 'Owner One',
    subjectLabel: 'Owner One',
    reason: 'Session ended.',
    context: null,
    occurredAt,
  }));
  let actor = owner();
  let rawCall = 0;
  let pageReads = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      return rawCall % 2 === 1 ? [{ id: 'org-1', lifecycleStatus: 'ACTIVE' }] : [actor];
    },
    securityAuditEvent: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) =>
        args.where.organisationId === 'org-1'
          ? events.find((event) => event.id === args.where.id) ?? null : null,
      findMany: async (args: { where: { organisationId: string; OR?: [{ occurredAt: { lt: Date } }, { occurredAt: Date; id: { lt: string } }] }; take: number }) => {
        pageReads += 1;
        assert.equal(args.where.organisationId, 'org-1');
        assert.equal(args.take, 51);
        return events.filter((event) => !args.where.OR || event.id < args.where.OR[1].id.lt).slice(0, args.take);
      },
    },
  };
  const service = new TeamLifecycleService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never);
  const first = await service.listSecurityAudit('org-1', actor.id);
  assert.equal(first.data.length, 50);
  assert.equal(first.nextCursor, 'event-003');
  const second = await service.listSecurityAudit('org-1', actor.id, first.nextCursor!);
  assert.equal(second.data.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(pageReads, 2);
  await assert.rejects(() => service.listSecurityAudit('org-1', actor.id, 'foreign-event'),
    (error: unknown) => error instanceof AppError && error.statusCode === 404);
  assert.equal(pageReads, 2, 'a foreign cursor cannot read a page');
  actor = owner({ role: 'MEMBER' });
  await assert.rejects(() => service.listSecurityAudit('org-1', actor.id, first.nextCursor!),
    (error: unknown) => error instanceof AppError && error.statusCode === 403);
  assert.equal(pageReads, 2, 'a demoted member cannot read a page');
});
