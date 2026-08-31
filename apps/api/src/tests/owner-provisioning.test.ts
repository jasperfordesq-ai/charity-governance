import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-provisioning-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-provisioning-test';

const [
  { provisionTenant },
  { Prisma },
  { default: Fastify },
  { ownerTenantRoutes },
  { signOperatorAccessToken },
] = await Promise.all([
  import('../services/owner-provisioning.service.js'),
  import('@prisma/client'),
  import('fastify'),
  import('../routes/owner/tenants.js'),
  import('../utils/owner-jwt.js'),
]);

const codeOf = (err: unknown) => (err as { code?: string })?.code;
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// Extracts the raw token riding a manual link's URL fragment
// (#token=<value>), never its query string.
function tokenFromFragmentLink(link: string): string {
  const url = new URL(link);
  const fragmentParams = new URLSearchParams(url.hash.slice(1));
  const token = fragmentParams.get('token');
  assert.ok(token, `expected a #token= fragment on ${link}`);
  return token as string;
}

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function emailServiceStub() {
  const calls = {
    welcome: [] as unknown[][],
    verification: [] as unknown[][],
    passwordRecovery: [] as unknown[][],
  };
  return {
    calls,
    emailService: {
      sendWelcomeEmail: async (...args: unknown[]) => {
        calls.welcome.push(args);
        return true;
      },
      sendEmailVerification: async (...args: unknown[]) => {
        calls.verification.push(args);
        return true;
      },
      sendPasswordRecoveryEmail: async (...args: unknown[]) => {
        calls.passwordRecovery.push(args);
        return { outcome: 'ACCEPTED', providerMessageId: 'test-message-id' } as const;
      },
    },
  };
}

function prismaStub(
  existingUsersByEmail: Record<string, unknown> = {},
  options: { userCreateError?: unknown } = {},
) {
  const calls = {
    orgs: 0,
    users: [] as Record<string, unknown>[],
    subs: [] as Record<string, unknown>[],
    recoveryRequests: [] as Record<string, unknown>[],
  };
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
    passwordRecoveryRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.recoveryRequests.push(data);
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
  const { emailService } = emailServiceStub();
  const result = await provisionTenant(prisma, INPUT, emailService);

  assert.equal(calls.orgs, 1);
  assert.equal(calls.users.length, 1);
  assert.equal(calls.users[0].role, 'OWNER');
  assert.equal(calls.users[0].email, 'ada@example.org');
  assert.equal(calls.subs.length, 1);
  assert.equal(calls.subs[0].plan, 'ESSENTIALS');
  assert.equal(calls.subs[0].status, 'TRIALING');
  assert.equal(result.organisationId, 'org-1');
  assert.equal(result.userId, 'u-1');
  assert.equal((result as { verifyToken?: unknown }).verifyToken, undefined, 'raw tokens must not be returned once the emails carry them');
});

test('the verify token is hashed at rest, and the raw token emailed matches that hash', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService, calls: emailCalls } = emailServiceStub();
  await provisionTenant(prisma, INPUT, emailService);

  assert.equal(emailCalls.verification.length, 1);
  const [to, name, rawVerifyToken] = emailCalls.verification[0] as [string, string, string];
  assert.equal(to, 'ada@example.org');
  assert.equal(name, 'Ada Lovelace');

  // Only the sha256 HASH of the verify token may be persisted; the raw token
  // is emailed and never stored. A regression that stored the raw token (or
  // stored nothing distinguishable from it) must fail this.
  const storedVerifyToken = calls.users[0].verifyToken as string;
  assert.notEqual(storedVerifyToken, rawVerifyToken);
  assert.equal(storedVerifyToken, sha256(rawVerifyToken));
});

test('a password-reset token is issued in the same transaction, hashed at rest, and the raw token emailed matches that hash', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService, calls: emailCalls } = emailServiceStub();
  await provisionTenant(prisma, INPUT, emailService);

  assert.equal(calls.recoveryRequests.length, 1, 'the reset token must be issued inside the same transaction as the user/org/subscription writes');
  const request = calls.recoveryRequests[0];
  assert.equal(request.source, 'OWNER_PROVISIONED');
  assert.equal(request.organisationId, 'org-1');
  assert.equal(request.userId, 'u-1');
  assert.equal(request.deliveryState, 'ACCEPTED');

  assert.equal(emailCalls.passwordRecovery.length, 1);
  const [to, name, rawResetToken] = emailCalls.passwordRecovery[0] as [string, string, string];
  assert.equal(to, 'ada@example.org');
  assert.equal(name, 'Ada Lovelace');

  const storedResetTokenHash = request.tokenHash as string;
  assert.notEqual(storedResetTokenHash, rawResetToken);
  // hashOpaqueToken (used here) and hashPasswordRecoveryToken (used by the
  // consuming /auth/reset-password endpoint) are both plain sha256 hex
  // digests, so this proves the link that gets emailed will actually resolve.
  assert.equal(storedResetTokenHash, sha256(rawResetToken));
  assert.match(rawResetToken, /^[A-Za-z0-9_-]{43}$/, 'must match the canonical reset-token shape resetPassword() requires');
});

test('the welcome email is sent with the organisation name', async () => {
  const { prisma } = prismaStub();
  const { emailService, calls: emailCalls } = emailServiceStub();
  await provisionTenant(prisma, INPUT, emailService);

  assert.equal(emailCalls.welcome.length, 1);
  assert.deepEqual(emailCalls.welcome[0], ['ada@example.org', 'Ada Lovelace', 'New Charity']);
});

test('the operator never supplies a password and none is usable', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService } = emailServiceStub();
  await provisionTenant(prisma, INPUT, emailService);
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
  const { emailService, calls: emailCalls } = emailServiceStub();
  await assert.rejects(
    () => provisionTenant(prisma, INPUT, emailService),
    (err: unknown) => codeOf(err) === 'EMAIL_ALREADY_REGISTERED',
  );
  assert.equal(calls.orgs, 0, 'no partial organisation may be created');
  assert.equal(calls.users.length, 0);
  assert.equal(calls.recoveryRequests.length, 0);
  assert.equal(emailCalls.welcome.length, 0, 'a rejected provision must never send mail');
  assert.equal(emailCalls.verification.length, 0);
  assert.equal(emailCalls.passwordRecovery.length, 0);
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
  const { emailService } = emailServiceStub();

  await assert.rejects(
    () => provisionTenant(prisma, INPUT, emailService),
    (err: unknown) => codeOf(err) === 'EMAIL_ALREADY_REGISTERED',
  );
});

test('a different existing email does not block provisioning', async () => {
  // Proves the stub (and the service) actually filter on where.email rather
  // than blocking on the mere presence of any existing user row.
  const { prisma, calls } = prismaStub({ 'someone-else@example.org': { id: 'u-existing' } });
  const { emailService } = emailServiceStub();
  const result = await provisionTenant(prisma, INPUT, emailService);

  assert.equal(calls.orgs, 1);
  assert.equal(calls.users.length, 1);
  assert.ok(result.organisationId.length > 0);
});

test('a non-canonical email is normalised before the duplicate check', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService } = emailServiceStub();
  await provisionTenant(prisma, { ...INPUT, ownerEmail: '  Ada@Example.ORG ' }, emailService);
  assert.equal(calls.users[0].email, 'ada@example.org');
});

test('trial days must be positive', async () => {
  const { prisma } = prismaStub();
  const { emailService } = emailServiceStub();
  await assert.rejects(
    () => provisionTenant(prisma, { ...INPUT, trialDays: 0 }, emailService),
    (err: unknown) => codeOf(err) === 'INVALID_TRIAL_DAYS',
  );
});

test('manual-link: no emails are sent and both links are returned in the fragment form', async () => {
  await withEnv(
    {
      CHARITYPILOT_DEPLOYMENT_MODE: undefined,
      CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      FRONTEND_URL: 'https://charitypilot.tail.example.ts.net',
    },
    async () => {
      const { prisma, calls } = prismaStub();
      const { emailService, calls: emailCalls } = emailServiceStub();
      const result = await provisionTenant(prisma, INPUT, emailService);

      assert.equal(emailCalls.welcome.length, 0, 'manual-link must never send mail');
      assert.equal(emailCalls.verification.length, 0);
      assert.equal(emailCalls.passwordRecovery.length, 0);

      assert.ok(result.links, 'manual-link must return links');
      assert.match(
        result.links!.setPassword,
        /^https:\/\/charitypilot\.tail\.example\.ts\.net\/reset-password#token=/,
      );
      assert.match(
        result.links!.verifyEmail,
        /^https:\/\/charitypilot\.tail\.example\.ts\.net\/verify-email#token=/,
      );

      // The link's raw token must recompute to the hash actually persisted —
      // proving the link that comes back will resolve, not just that it looks
      // right.
      const rawResetToken = tokenFromFragmentLink(result.links!.setPassword);
      const rawVerifyToken = tokenFromFragmentLink(result.links!.verifyEmail);
      assert.equal(calls.recoveryRequests[0].tokenHash, sha256(rawResetToken));
      assert.equal(calls.users[0].verifyToken as string, sha256(rawVerifyToken));
    },
  );
});

test('provider email: emails sent, no links in the response (today’s behaviour)', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService, calls: emailCalls } = emailServiceStub();
  const result = await provisionTenant(prisma, INPUT, emailService);

  assert.equal(emailCalls.welcome.length, 1);
  assert.equal(emailCalls.verification.length, 1);
  assert.equal(emailCalls.passwordRecovery.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'links'), false);
  assert.equal(calls.subs[0].status, 'TRIALING');
});

test('creates nothing when the manual-link origin is missing', async () => {
  await withEnv(
    {
      CHARITYPILOT_DEPLOYMENT_MODE: undefined,
      CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      FRONTEND_URL: undefined,
    },
    async () => {
      const { prisma, calls } = prismaStub();
      const { emailService, calls: emailCalls } = emailServiceStub();

      await assert.rejects(
        () => provisionTenant(prisma, INPUT, emailService),
        (err: unknown) => codeOf(err) === 'MANUAL_LINK_ORIGIN_INVALID',
      );

      // The failure must land BEFORE the transaction: no organisation, user,
      // subscription, or recovery request may exist, and no mail sent.
      assert.equal(calls.orgs, 0);
      assert.equal(calls.users.length, 0);
      assert.equal(calls.subs.length, 0);
      assert.equal(calls.recoveryRequests.length, 0);
      assert.equal(emailCalls.welcome.length, 0);
      assert.equal(emailCalls.verification.length, 0);
      assert.equal(emailCalls.passwordRecovery.length, 0);
    },
  );
});

test('comped billing creates ACTIVE with null trialEndsAt', async () => {
  const { prisma, calls } = prismaStub();
  const { emailService } = emailServiceStub();
  const result = await provisionTenant(
    prisma,
    { organisationName: 'Comped Charity', ownerName: 'Ada Lovelace', ownerEmail: 'comped@example.org', plan: 'COMPLETE', billing: 'comped' },
    emailService,
  );

  assert.equal(calls.subs.length, 1);
  assert.deepEqual(calls.subs[0], {
    organisationId: 'org-1',
    plan: 'COMPLETE',
    status: 'ACTIVE',
    trialEndsAt: null,
  });
  assert.ok(result.organisationId.length > 0);
});

test('comped billing does not require trialDays (INVALID_TRIAL_DAYS is a trial-only guard)', async () => {
  const { prisma } = prismaStub();
  const { emailService } = emailServiceStub();
  await provisionTenant(
    prisma,
    { organisationName: 'Comped Charity', ownerName: 'Ada Lovelace', ownerEmail: 'comped2@example.org', plan: 'ESSENTIALS', billing: 'comped' },
    emailService,
  );
  // No throw: reaching this line is the assertion.
});

function operatorAuthHeader() {
  return { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` };
}

async function buildProvisionRouteApp() {
  const OPERATOR_ROW = { id: 'op-1', email: 'owner@example.org', lifecycleStatus: 'ACTIVE' };
  const LIVE_SESSION = {
    id: 's-1',
    operatorId: 'op-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const { prisma, calls } = prismaStub();
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    platformOperatorSession: { findFirst: async () => LIVE_SESSION },
    platformOperator: { findUnique: async () => OPERATOR_ROW },
    $transaction: (prisma as unknown as { $transaction: unknown }).$transaction,
  } as never);
  await app.register(ownerTenantRoutes);
  return { app, calls };
}

test('route: trial billing requires trialDays; comped forbids it', async () => {
  const { app: app1 } = await buildProvisionRouteApp();
  const resMissingTrialDays = await app1.inject({
    method: 'POST',
    url: '/tenants',
    headers: operatorAuthHeader(),
    payload: { ...INPUT, billing: 'trial', trialDays: undefined },
  });
  assert.equal(resMissingTrialDays.statusCode, 400);
  assert.equal(resMissingTrialDays.json().code, 'VALIDATION_ERROR');
  await app1.close();

  const { app: app2 } = await buildProvisionRouteApp();
  const resComped = await app2.inject({
    method: 'POST',
    url: '/tenants',
    headers: operatorAuthHeader(),
    payload: { ...INPUT, billing: 'comped', trialDays: 30 },
  });
  assert.equal(resComped.statusCode, 400);
  assert.equal(resComped.json().code, 'VALIDATION_ERROR');
  await app2.close();
});

test('route: valid trial and comped payloads reach the service and succeed', async () => {
  const { app: app1 } = await buildProvisionRouteApp();
  const resTrial = await app1.inject({
    method: 'POST',
    url: '/tenants',
    headers: operatorAuthHeader(),
    payload: INPUT,
  });
  assert.equal(resTrial.statusCode, 201);
  await app1.close();

  const { app: app2 } = await buildProvisionRouteApp();
  const resComped = await app2.inject({
    method: 'POST',
    url: '/tenants',
    headers: operatorAuthHeader(),
    payload: {
      organisationName: 'Route Comped Charity',
      ownerName: 'Ada Lovelace',
      ownerEmail: 'route-comped@example.org',
      plan: 'ESSENTIALS',
      billing: 'comped',
    },
  });
  assert.equal(resComped.statusCode, 201);
  await app2.close();
});
