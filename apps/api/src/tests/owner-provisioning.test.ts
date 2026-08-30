import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-provisioning-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-provisioning-test';

const [{ provisionTenant }, { Prisma }] = await Promise.all([
  import('../services/owner-provisioning.service.js'),
  import('@prisma/client'),
]);

const codeOf = (err: unknown) => (err as { code?: string })?.code;

function prismaStub(
  existingUsersByEmail: Record<string, unknown> = {},
  options: { userCreateError?: unknown } = {},
) {
  const calls = { orgs: 0, users: [] as Record<string, unknown>[], subs: [] as Record<string, unknown>[] };
  const tx = {
    user: {
      // Honours the where clause it is given: a stub that ignored where.email
      // would let the duplicate-email test pass even if the service looked up
      // the wrong email (or an empty where), which is exactly the bug this
      // must catch.
      findUnique: async ({ where }: { where: { email: string } }) => existingUsersByEmail[where.email] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.userCreateError) throw options.userCreateError;
        calls.users.push(data);
        return { id: 'u-1', ...data };
      },
      update: async () => ({}),
    },
    organisation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.orgs += 1;
        return { id: 'org-1', ...data };
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.subs.push(data);
        return data;
      },
    },
  };
  return { calls, prisma: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never };
}

const INPUT = {
  organisationName: 'New Charity',
  ownerName: 'Ada Lovelace',
  ownerEmail: 'ada@example.org',
  plan: 'ESSENTIALS' as const,
  trialDays: 30,
};

test('provisioning creates org, OWNER user and subscription', async () => {
  const { prisma, calls } = prismaStub();
  const result = await provisionTenant(prisma, INPUT);

  assert.equal(calls.orgs, 1);
  assert.equal(calls.users.length, 1);
  assert.equal(calls.users[0].role, 'OWNER');
  assert.equal(calls.users[0].email, 'ada@example.org');
  assert.equal(calls.subs.length, 1);
  assert.equal(calls.subs[0].plan, 'ESSENTIALS');
  assert.equal(calls.subs[0].status, 'TRIALING');
  assert.ok(result.verifyToken.length > 0);

  // Only the sha256 HASH of the verify token may be persisted; the raw token
  // is returned to the caller and never stored. A regression that stored the
  // raw token (or stored nothing distinguishable from it) must fail this.
  const storedVerifyToken = calls.users[0].verifyToken;
  assert.notEqual(storedVerifyToken, result.verifyToken);
  assert.equal(storedVerifyToken, crypto.createHash('sha256').update(result.verifyToken).digest('hex'));
});

test('the operator never supplies a password and none is usable', async () => {
  const { prisma, calls } = prismaStub();
  await provisionTenant(prisma, INPUT);
  const created = calls.users[0];
  assert.equal(typeof created.passwordHash, 'string');
  assert.notEqual(created.passwordHash, '');
  assert.equal(created.emailVerified, false);
});

test('a duplicate email returns 409 and creates nothing', async () => {
  // AuthService.register deliberately reports success for a taken email to
  // prevent enumeration. For a trusted operator that would silently no-op, so
  // the owner path must fail loudly instead.
  const { prisma, calls } = prismaStub({ 'ada@example.org': { id: 'u-existing' } });
  await assert.rejects(
    () => provisionTenant(prisma, INPUT),
    (err: unknown) => codeOf(err) === 'EMAIL_ALREADY_REGISTERED',
  );
  assert.equal(calls.orgs, 0, 'no partial organisation may be created');
  assert.equal(calls.users.length, 0);
});

test('a concurrent duplicate email (caught only by the DB unique constraint) still returns 409, not a raw 500', async () => {
  // Under READ COMMITTED, two concurrent provisionTenant calls for the same
  // email can both pass the pre-check's tx.user.findUnique before either
  // commits. The loser's tx.user.create then violates User.email's unique
  // constraint and Prisma raises a P2002 PrismaClientKnownRequestError, not
  // an AppError. That must be caught and rethrown as the same 409 the
  // pre-check produces, not left to escape as an unhandled 500.
  const uniqueConstraintError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'User_email_key' },
  });
  const { prisma } = prismaStub({}, { userCreateError: uniqueConstraintError });

  await assert.rejects(
    () => provisionTenant(prisma, INPUT),
    (err: unknown) => codeOf(err) === 'EMAIL_ALREADY_REGISTERED',
  );
});

test('a different existing email does not block provisioning', async () => {
  // Proves the stub (and the service) actually filter on where.email rather
  // than blocking on the mere presence of any existing user row.
  const { prisma, calls } = prismaStub({ 'someone-else@example.org': { id: 'u-existing' } });
  const result = await provisionTenant(prisma, INPUT);

  assert.equal(calls.orgs, 1);
  assert.equal(calls.users.length, 1);
  assert.ok(result.organisationId.length > 0);
});

test('a non-canonical email is normalised before the duplicate check', async () => {
  const { prisma, calls } = prismaStub();
  await provisionTenant(prisma, { ...INPUT, ownerEmail: '  Ada@Example.ORG ' });
  assert.equal(calls.users[0].email, 'ada@example.org');
});

test('trial days must be positive', async () => {
  const { prisma } = prismaStub();
  await assert.rejects(
    () => provisionTenant(prisma, { ...INPUT, trialDays: 0 }),
    (err: unknown) => codeOf(err) === 'INVALID_TRIAL_DAYS',
  );
});
