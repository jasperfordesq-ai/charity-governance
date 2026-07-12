import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';

// personal-server-account reaches session-tokens/utils/jwt. Set the required
// import-time secret explicitly so CI never depends on an ambient developer env.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'personal-server-initializer-test-secret';
process.env.AUTH_RECOVERY_SECRET = 'ab'.repeat(32);

const [
  {
    getPersonalServerInitializerConfig,
    initializePersonalServer,
  },
  {
    getPersonalServerPasswordReset,
    getPersonalServerResetLinkRequest,
    issuePersonalServerResetLink,
    resetPersonalServerPassword,
  },
  { hashOpaqueToken },
  { authRecoverySecretFingerprint },
] = await Promise.all([
  import('../jobs/initialize-personal-server.js'),
  import('../jobs/personal-server-account.js'),
  import('../services/session-tokens.js'),
  import('../services/password-recovery-crypto.js'),
]);

const AUTH_RECOVERY_CONTROL = {
  id: 1,
  blocked: false,
  generation: 1,
  activeSecretFingerprint: authRecoverySecretFingerprint(),
  retiredSecretFingerprint: null,
};

const VALID_INITIALIZER_ENV = {
  NODE_ENV: 'production',
  CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
  PERSONAL_SERVER_ORGANISATION_NAME: 'My Charity',
  PERSONAL_SERVER_OWNER_NAME: 'Local Owner',
  PERSONAL_SERVER_OWNER_EMAIL: 'owner@charity.local',
  PERSONAL_SERVER_OWNER_PASSWORD: 'StrongLocal1!Password',
};

test('personal-server initializer requires canonical transient owner inputs and a strong password', () => {
  assert.deepEqual(getPersonalServerInitializerConfig(VALID_INITIALIZER_ENV), {
    organisationName: 'My Charity',
    ownerName: 'Local Owner',
    ownerEmail: 'owner@charity.local',
    ownerPassword: 'StrongLocal1!Password',
  });

  for (const env of [
    { ...VALID_INITIALIZER_ENV, NODE_ENV: 'development' },
    { ...VALID_INITIALIZER_ENV, CHARITYPILOT_DEPLOYMENT_MODE: 'public' },
    { ...VALID_INITIALIZER_ENV, PERSONAL_SERVER_OWNER_EMAIL: 'Owner@charity.local' },
    { ...VALID_INITIALIZER_ENV, PERSONAL_SERVER_OWNER_PASSWORD: 'weak-password' },
    { ...VALID_INITIALIZER_ENV, PERSONAL_SERVER_ORGANISATION_NAME: ' My Charity' },
  ]) {
    assert.throws(() => getPersonalServerInitializerConfig(env));
  }
});

function initializerHarness(counts = { organisations: 0, users: 0 }) {
  const principleWrites: unknown[] = [];
  const standardWrites: unknown[] = [];
  const organisationWrites: Array<Record<string, unknown>> = [];
  const userWrites: Array<Record<string, unknown>> = [];
  const subscriptionWrites: Array<Record<string, unknown>> = [];
  let advisoryLockCalls = 0;
  let transactionOptions: unknown;

  const tx = {
    $queryRaw: async () => {
      advisoryLockCalls += 1;
      return [{ acquired: 1 }];
    },
    governancePrinciple: {
      upsert: async (query: { where: { number: number } }) => {
        principleWrites.push(query);
        return { id: `principle-${query.where.number}` };
      },
    },
    governanceStandard: {
      upsert: async (query: unknown) => {
        standardWrites.push(query);
        return {};
      },
    },
    organisation: {
      count: async () => counts.organisations,
      create: async (query: { data: Record<string, unknown> }) => {
        organisationWrites.push(query.data);
        return { id: 'org-1' };
      },
    },
    user: {
      count: async () => counts.users,
      create: async (query: { data: Record<string, unknown> }) => {
        userWrites.push(query.data);
        return { id: 'owner-1' };
      },
    },
    subscription: {
      create: async (query: { data: Record<string, unknown> }) => {
        subscriptionWrites.push(query.data);
        return { id: 'subscription-1' };
      },
    },
  };
  const client = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
      transactionOptions = options;
      return callback(tx);
    },
  };

  return {
    client,
    principleWrites,
    standardWrites,
    organisationWrites,
    userWrites,
    subscriptionWrites,
    advisoryLockCalls: () => advisoryLockCalls,
    transactionOptions: () => transactionOptions,
  };
}

test('initializer creates exactly one blank organisation, verified owner, COMPLETE entitlement, and governance references', async () => {
  const harness = initializerHarness();
  const now = new Date('2026-07-11T12:00:00.000Z');
  const config = getPersonalServerInitializerConfig(VALID_INITIALIZER_ENV);
  const result = await initializePersonalServer(harness.client as never, config, now);

  const standardCount = GOVERNANCE_PRINCIPLES.reduce(
    (total, principle) => total + principle.standards.length,
    0,
  );
  assert.deepEqual(result, {
    initialized: true,
    organisationCreated: 1,
    ownerCreated: 1,
    principleCount: GOVERNANCE_PRINCIPLES.length,
    standardCount,
  });
  assert.equal(harness.advisoryLockCalls(), 1);
  assert.deepEqual(harness.transactionOptions(), { isolationLevel: 'Serializable' });
  assert.equal(harness.principleWrites.length, GOVERNANCE_PRINCIPLES.length);
  assert.equal(harness.standardWrites.length, standardCount);

  assert.deepEqual(harness.organisationWrites, [{ name: 'My Charity' }]);
  assert.equal(harness.userWrites.length, 1);
  const owner = harness.userWrites[0];
  assert.deepEqual({
    email: owner.email,
    name: owner.name,
    role: owner.role,
    organisationId: owner.organisationId,
    emailVerified: owner.emailVerified,
  }, {
    email: 'owner@charity.local',
    name: 'Local Owner',
    role: 'OWNER',
    organisationId: 'org-1',
    emailVerified: true,
  });
  assert.equal(await bcrypt.compare('StrongLocal1!Password', owner.passwordHash as string), true);

  assert.deepEqual(harness.subscriptionWrites, [{
    organisationId: 'org-1',
    plan: 'COMPLETE',
    status: 'ACTIVE',
    trialEndsAt: null,
    currentPeriodStart: now,
    currentPeriodEnd: null,
  }]);
});

test('initializer refuses every nonempty Organisation/User state before writing any reference or tenant data', async () => {
  for (const counts of [
    { organisations: 1, users: 0 },
    { organisations: 0, users: 1 },
    { organisations: 1, users: 1 },
  ]) {
    const harness = initializerHarness(counts);
    await assert.rejects(
      () => initializePersonalServer(
        harness.client as never,
        getPersonalServerInitializerConfig(VALID_INITIALIZER_ENV),
      ),
      /Organisation and User tables must both be empty/u,
    );
    assert.equal(harness.principleWrites.length, 0);
    assert.equal(harness.standardWrites.length, 0);
    assert.equal(harness.organisationWrites.length, 0);
    assert.equal(harness.userWrites.length, 0);
    assert.equal(harness.subscriptionWrites.length, 0);
  }
});

test('compiled account reset validates transient credentials, changes one active user, and revokes sessions', async () => {
  const config = getPersonalServerPasswordReset({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PERSONAL_SERVER_ACCOUNT_EMAIL: 'owner@charity.local',
    PERSONAL_SERVER_ACCOUNT_PASSWORD: 'Replacement2!Password',
  });
  assert.deepEqual(config, {
    email: 'owner@charity.local',
    password: 'Replacement2!Password',
  });

  let passwordHash = '';
  let sessionUpdate: Record<string, unknown> | undefined;
  let recoveryTermination: Record<string, unknown> | undefined;
  let auditData: Record<string, unknown> | undefined;
  const mutationOrder: string[] = [];
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [AUTH_RECOVERY_CONTROL];
      if (rawCall === 2) return [{ acquired: 1 }];
      if (rawCall === 3) return [{
        id: 'owner-1',
        email: 'owner@charity.local',
        name: 'Personal Owner',
        lifecycleStatus: 'ACTIVE',
        organisationId: 'org-1',
      }];
      return [];
    },
    organisation: { count: async () => 1 },
    user: {
      updateMany: async ({ data }: { data: { passwordHash: string } }) => {
        mutationOrder.push('password');
        passwordHash = data.passwordHash;
        return { count: 1 };
      },
    },
    passwordRecoveryRequest: {
      updateMany: async (query: Record<string, unknown>) => {
        mutationOrder.push('recovery');
        recoveryTermination = query;
        return { count: 2 };
      },
    },
    authSession: {
      updateMany: async (query: Record<string, unknown>) => {
        sessionUpdate = query;
        return { count: 3 };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditData = data;
        return { id: 'audit-1' };
      },
    },
  };
  const client = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const now = new Date('2026-07-11T13:00:00.000Z');
  const result = await resetPersonalServerPassword(client as never, config, now);

  assert.deepEqual(result, { passwordReset: true, sessionsRevoked: 3 });
  assert.equal(await bcrypt.compare('Replacement2!Password', passwordHash), true);
  assert.deepEqual(sessionUpdate, {
    where: { userId: 'owner-1', revokedAt: null },
    data: { revokedAt: now, revocationReason: 'PASSWORD_RESET' },
  });
  assert.deepEqual((recoveryTermination as { where: unknown }).where, {
    userId: 'owner-1',
    organisationId: 'org-1',
    terminatedAt: null,
  });
  assert.equal((recoveryTermination as { data: { terminationReason: string } }).data.terminationReason, 'PASSWORD_RESET_COMPLETED');
  assert.deepEqual(mutationOrder, ['recovery', 'password']);
  assert.equal(auditData?.type, 'ALL_SESSIONS_REVOKED');
  assert.equal(
    ((auditData?.context ?? {}) as Record<string, unknown>).eventKind,
    'PASSWORD_RESET_COMPLETED',
  );
  assert.equal(auditData?.actorKind, 'SUPPORT');
  assert.equal(
    ((auditData?.context ?? {}) as Record<string, unknown>).terminatedRequestCount,
    2,
  );

  assert.throws(() => getPersonalServerPasswordReset({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PERSONAL_SERVER_ACCOUNT_EMAIL: 'OWNER@charity.local',
    PERSONAL_SERVER_ACCOUNT_PASSWORD: 'Replacement2!Password',
  }));
});

test('compiled reset-link stores only a one-hour token hash and returns the exact fragment URL', async () => {
  const command = getPersonalServerResetLinkRequest({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    FRONTEND_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
    PERSONAL_SERVER_ACCOUNT_EMAIL: 'owner@charity.local',
  });
  assert.deepEqual(command, {
    email: 'owner@charity.local',
    origin: 'http://127.0.0.1:3003',
  });

  let requestData: Record<string, unknown> | undefined;
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) return [AUTH_RECOVERY_CONTROL];
      if (rawCall === 2) return [{ acquired: 1 }];
      return [{ id: 'owner-1', organisationId: 'org-1', lifecycleStatus: 'ACTIVE' }];
    },
    organisation: { count: async () => 1 },
    passwordRecoveryRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        requestData = data;
        return data;
      },
    },
  };
  const client = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const now = new Date('2026-07-11T14:00:00.000Z');
  const result = await issuePersonalServerResetLink(client as never, command, now);
  const resetUrl = new URL(result.resetUrl);
  const plaintextToken = new URLSearchParams(resetUrl.hash.slice(1)).get('token');

  assert.equal(resetUrl.origin, 'http://127.0.0.1:3003');
  assert.equal(resetUrl.pathname, '/reset-password');
  assert.equal(resetUrl.search, '');
  assert.ok(plaintextToken);
  assert.ok(requestData);
  assert.equal(requestData.source, 'PERSONAL_SERVER_OPERATOR');
  assert.equal(requestData.deliveryState, 'ACCEPTED');
  assert.equal(requestData.tokenHash, hashOpaqueToken(plaintextToken));
  assert.notEqual(requestData.tokenHash, plaintextToken);
  assert.equal((requestData.expiresAt as Date).toISOString(), '2026-07-11T15:00:00.000Z');
  assert.deepEqual(result, {
    resetLinkCreated: true,
    resetUrl: resetUrl.toString(),
    expiresAt: '2026-07-11T15:00:00.000Z',
  });
});
