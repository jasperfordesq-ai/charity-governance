import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'team-service-test-secret';

const { TeamService } = await import('../services/team.service.js');

const noopEmail = { sendTeamInvite: async () => true } as never;
const codeOf = (err: unknown) => (err as { code?: string })?.code;

// ── invite authorization (privilege escalation guards) ──

test('a MEMBER cannot invite anyone', async () => {
  const service = new TeamService({} as never, noopEmail);
  await assert.rejects(
    () => service.invite('org_1', 'actor', 'MEMBER', { email: 'x@example.org', role: 'MEMBER' }),
    (e: unknown) => codeOf(e) === 'FORBIDDEN',
  );
});

test('an ADMIN cannot invite another ADMIN (only the owner can)', async () => {
  const service = new TeamService({} as never, noopEmail);
  await assert.rejects(
    () => service.invite('org_1', 'actor', 'ADMIN', { email: 'x@example.org', role: 'ADMIN' }),
    (e: unknown) => codeOf(e) === 'FORBIDDEN',
  );
});

// ── acceptInvite: token integrity + role/org binding ──

function futureDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d;
}

function buildAcceptService(opts: {
  invite: Record<string, unknown> | null;
  existingUser?: Record<string, unknown> | null;
  consumeCount?: number;
  subscription?: {
    plan: string;
    status?: string;
    trialEndsAt?: Date | null;
    currentPeriodEnd?: Date | null;
  } | null;
}) {
  const created: Array<Record<string, unknown>> = [];
  const state = { consumeCalls: 0 };
  let rawCall = 0;
  const prisma = {
    teamInvite: {
      findUnique: async () => opts.invite,
    },
    user: {
      findUnique: async () => opts.existingUser ?? null,
    },
    authSession: {
      create: async () => ({ id: 'sess_1' }),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: async () => {
          rawCall += 1;
          if (rawCall === 1) {
            return [{
              id: String(opts.invite?.organisationId ?? 'org_1'),
              lifecycleStatus: 'ACTIVE',
            }];
          }
          return [{
            id: 'u_new',
            organisationId: String(opts.invite?.organisationId ?? 'org_1'),
            role: String(opts.invite?.role ?? 'MEMBER'),
            userLifecycleStatus: 'ACTIVE',
            organisationLifecycleStatus: 'ACTIVE',
          }];
        },
        subscription: {
          findUnique: async () => opts.subscription === undefined
            ? { plan: 'COMPLETE' }
            : opts.subscription,
        },
        authSession: {
          create: async () => ({ id: 'sess_1' }),
        },
        user: {
          count: async () => 0,
          create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return {
              id: 'u_new',
              email: args.data.email,
              name: args.data.name,
              role: args.data.role,
              emailVerified: true,
              organisationId: args.data.organisationId,
              organisation: { id: args.data.organisationId, name: 'Org' },
            };
          },
        },
        teamInvite: {
          count: async () => 0,
          updateMany: async () => {
            state.consumeCalls += 1;
            return { count: opts.consumeCount ?? 1 };
          },
        },
      }),
  };
  return { service: new TeamService(prisma as never, noopEmail), created, state };
}

test('acceptInvite rejects a missing token', async () => {
  const { service } = buildAcceptService({ invite: null });
  await assert.rejects(() => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (e: unknown) => codeOf(e) === 'INVALID_INVITE');
});

for (const badState of [
  { label: 'already accepted', invite: { acceptedAt: new Date() } },
  { label: 'revoked', invite: { revokedAt: new Date() } },
  { label: 'expired', invite: { expiresAt: new Date(Date.now() - 1000) } },
]) {
  test(`acceptInvite rejects an invite that is ${badState.label}`, async () => {
    const invite = {
      id: 'inv_1', email: 'invitee@example.org', organisationId: 'org_1', role: 'MEMBER',
      acceptedAt: null, revokedAt: null, expiresAt: futureDate(), ...badState.invite,
    };
    const { service } = buildAcceptService({ invite });
    await assert.rejects(() => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
      (e: unknown) => codeOf(e) === 'INVALID_INVITE');
  });
}

test('acceptInvite rejects when a user with the invited email already exists', async () => {
  const invite = { id: 'inv_1', email: 'invitee@example.org', organisationId: 'org_1', role: 'MEMBER', acceptedAt: null, revokedAt: null, expiresAt: futureDate() };
  const { service } = buildAcceptService({ invite, existingUser: { id: 'u_existing' } });
  await assert.rejects(() => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (e: unknown) => codeOf(e) === 'INVALID_INVITE');
});

test('acceptInvite binds the new user to the role and organisation from the INVITE, not the request', async () => {
  const invite = { id: 'inv_1', email: 'invitee@example.org', organisationId: 'org_from_invite', role: 'ADMIN', acceptedAt: null, revokedAt: null, expiresAt: futureDate() };
  const { service, created } = buildAcceptService({ invite, consumeCount: 1 });

  const result = await service.acceptInvite({ token: 'x', name: 'New Admin', password: 'Password1' });

  assert.equal(created.length, 1);
  assert.equal(created[0].role, 'ADMIN', 'role must come from the invite');
  assert.equal(created[0].organisationId, 'org_from_invite', 'org must come from the invite');
  assert.equal(created[0].emailVerified, true);
  assert.equal((result as { user: { email: string } }).user.email, 'invitee@example.org');
  assert.ok((result as { accessToken?: string }).accessToken, 'session tokens are issued on success');
});

for (const subscriptionCase of [
  {
    label: 'an expired trial',
    subscription: {
      plan: 'COMPLETE',
      status: 'TRIALING',
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      currentPeriodEnd: null,
    },
  },
  {
    label: 'a past-due subscription outside grace',
    subscription: {
      plan: 'COMPLETE',
      status: 'PAST_DUE',
      trialEndsAt: null,
      currentPeriodEnd: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    },
  },
  {
    label: 'a cancelled subscription',
    subscription: {
      plan: 'COMPLETE',
      status: 'CANCELLED',
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
  },
  {
    label: 'an expired subscription',
    subscription: {
      plan: 'COMPLETE',
      status: 'EXPIRED',
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
  },
]) {
  test(`acceptInvite rejects ${subscriptionCase.label} before consuming the invitation`, async () => {
    const invite = {
      id: `inv_${subscriptionCase.subscription.status.toLowerCase()}`,
      email: `${subscriptionCase.subscription.status.toLowerCase()}@example.org`,
      organisationId: 'org_1',
      role: 'MEMBER',
      acceptedAt: null,
      revokedAt: null,
      expiresAt: futureDate(),
    };
    const { service, created, state } = buildAcceptService({
      invite,
      subscription: subscriptionCase.subscription,
    });

    await assert.rejects(
      () => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
      (error: unknown) => codeOf(error) === 'INVALID_INVITE',
    );
    assert.equal(state.consumeCalls, 0);
    assert.equal(created.length, 0);
  });
}

for (const subscriptionCase of [
  {
    label: 'an active subscription',
    subscription: {
      plan: 'COMPLETE',
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
  },
  {
    label: 'a past-due subscription inside grace',
    subscription: {
      plan: 'COMPLETE',
      status: 'PAST_DUE',
      trialEndsAt: null,
      currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  },
]) {
  test(`acceptInvite permits ${subscriptionCase.label}`, async () => {
    const invite = {
      id: `inv_allowed_${subscriptionCase.subscription.status.toLowerCase()}`,
      email: `allowed-${subscriptionCase.subscription.status.toLowerCase()}@example.org`,
      organisationId: 'org_1',
      role: 'MEMBER',
      acceptedAt: null,
      revokedAt: null,
      expiresAt: futureDate(),
    };
    const originalGraceDays = process.env.PAST_DUE_GRACE_DAYS;
    process.env.PAST_DUE_GRACE_DAYS = '7';
    try {
      const { service, created, state } = buildAcceptService({
        invite,
        subscription: subscriptionCase.subscription,
      });

      const result = await service.acceptInvite({
        token: 'x',
        name: 'Allowed Member',
        password: 'Password1',
      });

      assert.equal(state.consumeCalls, 1);
      assert.equal(created.length, 1);
      assert.equal((result as { user: { email: string } }).user.email, invite.email);
      assert.ok((result as { refreshToken?: string }).refreshToken);
    } finally {
      if (originalGraceDays === undefined) delete process.env.PAST_DUE_GRACE_DAYS;
      else process.env.PAST_DUE_GRACE_DAYS = originalGraceDays;
    }
  });
}

test('acceptInvite rejects when the token was already consumed concurrently', async () => {
  const invite = { id: 'inv_1', email: 'invitee@example.org', organisationId: 'org_1', role: 'MEMBER', acceptedAt: null, revokedAt: null, expiresAt: futureDate() };
  const { service } = buildAcceptService({ invite, consumeCount: 0 });
  await assert.rejects(() => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (e: unknown) => codeOf(e) === 'INVALID_INVITE');
});

// ── revoke: cross-tenant guard ──

test('revoke rejects an invite from another organisation', async () => {
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }];
      if (rawCall === 2) return [{ id: 'owner', name: 'Owner', role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
      return [];
    },
    teamInvite: { updateMany: async () => ({ count: 0 }) },
    securityAuditEvent: { create: async () => ({}) },
  };
  const prisma = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  };
  const service = new TeamService(prisma as never, noopEmail);
  await assert.rejects(
    () => service.revoke(
      'org_1',
      'inv_other',
      'owner',
      'OWNER',
      'The invitation belongs to another organisation.',
    ),
    (e: unknown) => codeOf(e) === 'INVITE_NOT_FOUND',
  );
});

test('revoked invitations persist distinct bounded subject-label snapshots', async () => {
  const labels: string[] = [];
  const actorLabels: string[] = [];
  const longActorName = `${'O'.repeat(159)} ${'A'.repeat(40)}`;
  const revoke = async (inviteId: string, email: string) => {
    let rawCall = 0;
    const tx = {
      $queryRaw: async () => {
        rawCall += 1;
        if (rawCall === 1) return [{ id: 'org_1', lifecycleStatus: 'ACTIVE' }];
        if (rawCall === 2) {
          return [{ id: 'owner', name: longActorName, role: 'OWNER', lifecycleStatus: 'ACTIVE' }];
        }
        return [{ id: inviteId, email, role: 'MEMBER', acceptedAt: null, revokedAt: null }];
      },
      teamInvite: { updateMany: async () => ({ count: 1 }) },
      securityAuditEvent: {
        create: async ({ data }: { data: { actorLabel: string; subjectLabel: string } }) => {
          actorLabels.push(data.actorLabel);
          labels.push(data.subjectLabel);
          return {};
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    };
    await new TeamService(prisma as never, noopEmail).revoke(
      'org_1',
      inviteId,
      'owner',
      'OWNER',
      'This pending invitation is no longer required.',
    );
  };

  await revoke('invite-1', 'first.invitee@example.org');
  await revoke('invite-2', 'second.invitee@example.org');

  assert.deepEqual(labels, [
    'Invitation for first.invitee@example.org',
    'Invitation for second.invitee@example.org',
  ]);
  assert.deepEqual(actorLabels, ['O'.repeat(159), 'O'.repeat(159)]);
  assert.equal(actorLabels.every((label) => label === label.trim()), true);
  assert.equal(labels.every((label) => label.length <= 160), true);
});
