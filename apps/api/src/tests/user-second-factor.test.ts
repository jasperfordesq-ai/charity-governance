import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'charity-user-second-factor-test-secret-value';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_user-second-factor-test';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const { verifyUserLoginSecondFactor } = await import('../services/user-second-factor.service.js');
const { verifyUserPasswordChangeSecondFactor } = await import('../services/user-second-factor.service.js');
const { removeUserSecondFactor } = await import('../services/user-second-factor.service.js');
const { default: bcrypt } = await import('bcryptjs');
const { issueLoginSessionTokens } = await import('../services/session-tokens.js');
const { sealUserTotpSecret, openUserTotpSecret } = await import('../services/user-totp-crypto.js');
const { generateTotpSecret, fromBase32, totp, matchingTotpStep } = await import('../utils/totp.js');

const actor = { id: 'user-1', organisationId: 'org-1', name: 'Test Trustee' };

function fakeFactorClient(secret: string, enrolled = true) {
  const factor = {
    userId: actor.id,
    secret: sealUserTotpSecret(secret),
    pendingAt: enrolled ? null : new Date(),
    enrolledAt: enrolled ? new Date() : null,
    lastUsedStep: null as number | null,
    failedAttempts: 0,
    failedWindowAt: null as Date | null,
    blockedUntil: null as Date | null,
  };
  const events: string[] = [];
  const reasons: string[] = [];
  const storedRecovery = createHash('sha256').update('ABCDEF234567').digest('hex');
  let recoveryUsed = false;
  const client = {
    $queryRaw: async () => [factor],
    userSecondFactor: {
      update: async ({ data }: { data: Partial<typeof factor> }) => {
        Object.assign(factor, data);
      },
    },
    userSecondFactorRecoveryCode: {
      updateMany: async ({ where }: { where: { codeHash: string; usedAt: null } }) => {
        if (where.codeHash !== storedRecovery || recoveryUsed) return { count: 0 };
        recoveryUsed = true;
        return { count: 1 };
      },
    },
    securityAuditEvent: { create: async ({ data }: { data: { type: string; reason: string } }) => {
      events.push(data.type);
      reasons.push(data.reason);
    } },
  };
  return { client: client as never, factor, events, reasons };
}

test('password-change MFA recovery proof is single-use and labelled for that action', async () => {
  const { client, events, reasons } = fakeFactorClient(generateTotpSecret());
  const familyId = 'a44f8784-f454-4ddf-8985-b829bad774e8';
  assert.equal(await verifyUserPasswordChangeSecondFactor(client, actor,
    { recoveryCode: 'ABCDEF-234567' }, familyId), null);
  assert.deepEqual(events, ['SECOND_FACTOR_RECOVERY_USED']);
  assert.deepEqual(reasons, ['A one-time recovery code was used for password change.']);
  assert.equal((await verifyUserPasswordChangeSecondFactor(client, actor,
    { recoveryCode: 'ABCDEF-234567' }, familyId))?.code, 'SECOND_FACTOR_REQUIRED');
});

test('charity-user secret is sealed, opens with its key, and rejects a different root', () => {
  const secret = generateTotpSecret();
  const sealed = sealUserTotpSecret(secret);
  assert.equal(openUserTotpSecret(sealed), secret);
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-different-charity-user-secret-value-12345';
  try { assert.throws(() => openUserTotpSecret(sealed), /could not be opened/); }
  finally { process.env.JWT_SECRET = original; }
});

test('a matching TOTP step is reported for replay prevention', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  assert.equal(matchingTotpStep(secret, totp(fromBase32(secret), now), now),
    Math.floor(now / 30_000));
  assert.equal(matchingTotpStep(secret, 'not a code', now), null);
});

test('an enrolled account rejects password-only sign-in and one-time code replay', async () => {
  const secret = generateTotpSecret();
  const { client, factor } = fakeFactorClient(secret);
  assert.equal((await verifyUserLoginSecondFactor(client, actor, {}))?.code, 'SECOND_FACTOR_REQUIRED');
  const code = totp(fromBase32(secret));
  await verifyUserLoginSecondFactor(client, actor, { code });
  assert.equal(typeof factor.lastUsedStep, 'number');
  assert.equal((await verifyUserLoginSecondFactor(client, actor, { code }))?.code, 'SECOND_FACTOR_REQUIRED');
});

test('one recovery code works once and writes a count-free security event', async () => {
  const { client, events } = fakeFactorClient(generateTotpSecret());
  await verifyUserLoginSecondFactor(client, actor, { recoveryCode: 'ABCDEF-234567' });
  assert.deepEqual(events, ['SECOND_FACTOR_RECOVERY_USED']);
  assert.equal((await verifyUserLoginSecondFactor(client, actor, { recoveryCode: 'ABCDEF-234567' }))?.code,
    'SECOND_FACTOR_REQUIRED');
});

test('a pending authenticator cannot gate sign-in before enrolment completes', async () => {
  const { client } = fakeFactorClient(generateTotpSecret(), false);
  await verifyUserLoginSecondFactor(client, actor, {});
});

test('invalid codes consume a shared account budget, while an omitted code does not', async () => {
  const { client, factor } = fakeFactorClient(generateTotpSecret());
  assert.equal((await verifyUserLoginSecondFactor(client, actor, {}))?.code, 'SECOND_FACTOR_REQUIRED');
  assert.equal(factor.failedAttempts, 0);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failure = await verifyUserLoginSecondFactor(client, actor, { code: '000000' });
    assert.equal(factor.failedAttempts, attempt);
    assert.equal(failure?.code, attempt === 5 ? 'SECOND_FACTOR_RATE_LIMITED' : 'SECOND_FACTOR_REQUIRED');
  }
  assert.ok(factor.blockedUntil);
  assert.equal((await verifyUserLoginSecondFactor(client, actor, { recoveryCode: 'ABCDEF-234567' }))?.code,
    'SECOND_FACTOR_RATE_LIMITED');
  assert.equal(factor.failedAttempts, 5);
});

test('a failed MFA attempt commits its shared budget without creating a session', async () => {
  const { client, factor } = fakeFactorClient(generateTotpSecret());
  let committed = false;
  let sessionsCreated = 0;
  const transaction = {
    ...(client as unknown as Record<string, unknown>),
    $queryRaw: async (strings: TemplateStringsArray) =>
      String(strings[0]).includes('principal_organisation')
        ? [{ id: 'user-1', organisationId: 'org-1', role: 'OWNER',
          passwordHash: 'hash', userLifecycleStatus: 'ACTIVE', organisationLifecycleStatus: 'ACTIVE' }]
        : [factor],
    authSession: { create: async () => { sessionsCreated += 1; return { id: 'session-new' }; } },
  };
  const prisma = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const result = await work(transaction);
    committed = true;
    return result;
  } };
  await assert.rejects(() => issueLoginSessionTokens(prisma as never, {
    id: actor.id, organisationId: actor.organisationId, role: 'OWNER',
    passwordHash: 'hash', name: actor.name,
  }, undefined, { code: 'invalid' }),
  (error: { code?: string }) => error.code === 'SECOND_FACTOR_REQUIRED');
  assert.equal(committed, true);
  assert.equal(factor.failedAttempts, 1);
  assert.equal(sessionsCreated, 0);
});

test('a recent recovery-authenticated browser family can remove MFA with its password; another family cannot', async () => {
  const { client } = fakeFactorClient(generateTotpSecret());
  let deleted = false;
  let revoked = false;
  const transaction = {
    ...(client as unknown as Record<string, unknown>),
    userSecondFactor: { delete: async () => { deleted = true; } },
    securityAuditEvent: {
      findFirst: async ({ where }: { where: { subjectSessionId: string } }) =>
        where.subjectSessionId === 'recovery-family' ? { id: 'event-1' } : null,
      create: async () => ({}),
    },
    authSession: { updateMany: async () => { revoked = true; return { count: 1 }; } },
  };
  const prisma = {
    user: { findUnique: async () => ({
      ...actor, email: 'trustee@example.org', passwordHash: bcrypt.hashSync('RightPassword1', 4),
      lifecycleStatus: 'ACTIVE', organisation: { lifecycleStatus: 'ACTIVE' },
    }) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transaction),
  };
  await assert.rejects(() => removeUserSecondFactor(prisma as never, actor.id,
    'RightPassword1', {}, 'ordinary-family'),
  (error: { code?: string }) => error.code === 'SECOND_FACTOR_REQUIRED');
  assert.equal(deleted, false);
  await removeUserSecondFactor(prisma as never, actor.id, 'RightPassword1', {}, 'recovery-family');
  assert.equal(deleted, true);
  assert.equal(revoked, true);
});

test('account-factor settings refuse connector sessions while allowing the same user in the browser', async () => {
  const [{ default: Fastify }, { authRoutes }, { signAccessToken }] = await Promise.all([
    import('fastify'), import('../routes/auth/index.js'), import('../utils/jwt.js'),
  ]);
  let clientKind: 'WEB' | 'MCP_CONNECTOR' = 'MCP_CONNECTOR';
  let factorReads = 0;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({
      id: 'session-1', familyId: 'family-1', clientKind, accessLevel: 'ADMIN', dataScope: 'WITHHELD',
    }) },
    user: { findUnique: async () => ({
      id: 'user-1', organisationId: 'org-1', role: 'MEMBER', emailVerified: true,
      lifecycleStatus: 'ACTIVE', organisation: { lifecycleStatus: 'ACTIVE' },
    }) },
    userSecondFactor: { findUnique: async () => { factorReads += 1; return null; } },
  } as never);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  const token = signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'MEMBER', sessionId: 'session-1' });
  try {
    const connector = await app.inject({ method: 'GET', url: '/api/v1/auth/second-factor',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(connector.statusCode, 403);
    assert.equal(connector.json().code, 'WEB_SESSION_REQUIRED');
    assert.equal(factorReads, 0);
    const connectorChange = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'CurrentPassword1', newPassword: 'DifferentPassword2' } });
    assert.equal(connectorChange.statusCode, 403);
    assert.equal(connectorChange.json().code, 'WEB_SESSION_REQUIRED');
    clientKind = 'WEB';
    const browser = await app.inject({ method: 'GET', url: '/api/v1/auth/second-factor',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(browser.statusCode, 200);
    assert.equal(browser.json().enrolled, false);
    assert.equal(browser.headers['cache-control'], 'no-store');
    const browserChange = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'CurrentPassword1', newPassword: 'weak' } });
    assert.equal(browserChange.statusCode, 400);
    assert.equal(browserChange.json().code, 'VALIDATION_ERROR');
  } finally { await app.close(); }
});
