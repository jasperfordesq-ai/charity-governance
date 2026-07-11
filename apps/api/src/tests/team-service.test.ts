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

// ── role-change authorization ──

test('a non-owner cannot change member roles', async () => {
  const service = new TeamService({} as never, noopEmail);
  await assert.rejects(
    () => service.updateMemberRole('org_1', 'actor', 'ADMIN', 'member', 'ADMIN'),
    (e: unknown) => codeOf(e) === 'FORBIDDEN',
  );
});

test('the owner cannot promote a member to OWNER (no silent owner transfer)', async () => {
  const service = new TeamService({} as never, noopEmail);
  await assert.rejects(
    () => service.updateMemberRole('org_1', 'owner', 'OWNER', 'member', 'OWNER'),
    (e: unknown) => codeOf(e) === 'OWNER_TRANSFER_UNSUPPORTED',
  );
});

test('the owner cannot change their own role', async () => {
  const service = new TeamService({} as never, noopEmail);
  await assert.rejects(
    () => service.updateMemberRole('org_1', 'owner', 'OWNER', 'owner', 'MEMBER'),
    (e: unknown) => codeOf(e) === 'CANNOT_CHANGE_OWN_ROLE',
  );
});

test('updateMemberRole rejects a member from another organisation (cross-tenant guard)', async () => {
  const calls: string[] = [];
  const prisma = {
    user: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        calls.push('findFirst');
        assert.deepEqual(args.where, { id: 'member_other_org', organisationId: 'org_1' });
        return null; // not in this org
      },
      update: async () => { calls.push('update'); return {}; },
    },
  };
  const service = new TeamService(prisma as never, noopEmail);
  await assert.rejects(
    () => service.updateMemberRole('org_1', 'owner', 'OWNER', 'member_other_org', 'ADMIN'),
    (e: unknown) => codeOf(e) === 'MEMBER_NOT_FOUND',
  );
  assert.equal(calls.includes('update'), false, 'must not update a member outside the organisation');
});

test('the account owner cannot be demoted via updateMemberRole', async () => {
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'other_owner', organisationId: 'org_1', role: 'OWNER' }),
      update: async () => ({}),
    },
  };
  const service = new TeamService(prisma as never, noopEmail);
  await assert.rejects(
    () => service.updateMemberRole('org_1', 'owner', 'OWNER', 'other_owner', 'MEMBER'),
    (e: unknown) => codeOf(e) === 'CANNOT_DEMOTE_OWNER',
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
}) {
  const created: Array<Record<string, unknown>> = [];
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
        $queryRaw: async () => [{
          id: 'u_new',
          organisationId: String(opts.invite?.organisationId ?? 'org_1'),
          role: String(opts.invite?.role ?? 'MEMBER'),
          userLifecycleStatus: 'ACTIVE',
          organisationLifecycleStatus: 'ACTIVE',
        }],
        subscription: { findUnique: async () => ({ plan: 'COMPLETE' }) },
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
          updateMany: async () => ({ count: opts.consumeCount ?? 1 }),
        },
      }),
  };
  return { service: new TeamService(prisma as never, noopEmail), created };
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

test('acceptInvite rejects when the token was already consumed concurrently', async () => {
  const invite = { id: 'inv_1', email: 'invitee@example.org', organisationId: 'org_1', role: 'MEMBER', acceptedAt: null, revokedAt: null, expiresAt: futureDate() };
  const { service } = buildAcceptService({ invite, consumeCount: 0 });
  await assert.rejects(() => service.acceptInvite({ token: 'x', name: 'A', password: 'Password1' }),
    (e: unknown) => codeOf(e) === 'INVALID_INVITE');
});

// ── revoke: cross-tenant guard ──

test('revoke rejects an invite from another organisation', async () => {
  const prisma = {
    teamInvite: {
      findFirst: async (args: { where: { id: string; organisationId: string } }) => {
        assert.deepEqual(args.where, { id: 'inv_other', organisationId: 'org_1' });
        return null;
      },
      update: async () => ({}),
    },
  };
  const service = new TeamService(prisma as never, noopEmail);
  await assert.rejects(
    () => service.revoke('org_1', 'inv_other', 'OWNER'),
    (e: unknown) => codeOf(e) === 'INVITE_NOT_FOUND',
  );
});
