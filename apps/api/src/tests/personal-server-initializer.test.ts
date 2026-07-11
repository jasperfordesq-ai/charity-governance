import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';
import {
  getPersonalServerInitializerConfig,
  initializePersonalServer,
} from '../jobs/initialize-personal-server.js';
import {
  getPersonalServerPasswordReset,
  getPersonalServerResetLinkRequest,
  issuePersonalServerResetLink,
  resetPersonalServerPassword,
} from '../jobs/personal-server-account.js';
import { hashOpaqueToken } from '../services/session-tokens.js';

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
      return [{ pg_advisory_xact_lock: null }];
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
  const tx = {
    $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
    organisation: { count: async () => 1 },
    user: {
      findUnique: async () => ({
        id: 'owner-1',
        email: 'owner@charity.local',
        lifecycleStatus: 'ACTIVE',
        organisationId: 'org-1',
      }),
      updateMany: async ({ data }: { data: { passwordHash: string } }) => {
        passwordHash = data.passwordHash;
        return { count: 1 };
      },
    },
    authSession: {
      updateMany: async (query: Record<string, unknown>) => {
        sessionUpdate = query;
        return { count: 3 };
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

  let updateData: { resetToken: string; resetTokenExpiry: Date } | undefined;
  const tx = {
    $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
    organisation: { count: async () => 1 },
    user: {
      findUnique: async () => ({ id: 'owner-1', organisationId: 'org-1', lifecycleStatus: 'ACTIVE' }),
      updateMany: async ({ data }: { data: { resetToken: string; resetTokenExpiry: Date } }) => {
        updateData = data;
        return { count: 1 };
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
  assert.ok(updateData);
  assert.equal(updateData.resetToken, hashOpaqueToken(plaintextToken));
  assert.notEqual(updateData.resetToken, plaintextToken);
  assert.equal(updateData.resetTokenExpiry.toISOString(), '2026-07-11T15:00:00.000Z');
  assert.deepEqual(result, {
    resetLinkCreated: true,
    resetUrl: resetUrl.toString(),
    expiresAt: '2026-07-11T15:00:00.000Z',
  });
});
