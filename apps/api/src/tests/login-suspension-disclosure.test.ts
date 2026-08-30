import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-disclosure-test';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_disclosure_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ AuthService }, bcrypt] = await Promise.all([
  import('../services/auth.service.js'),
  import('bcryptjs'),
]);

const PASSWORD = 'correct-horse-battery-staple';
const codeOf = (err: unknown) => (err as { code?: string })?.code;
const statusOf = (err: unknown) => (err as { statusCode?: number })?.statusCode;

async function serviceFor(userLifecycle: string, orgLifecycle: string) {
  const passwordHash = await bcrypt.default.hash(PASSWORD, 10);
  return new AuthService({
    user: {
      findUnique: async () => ({
        id: 'u-1',
        email: 'user@example.org',
        name: 'User',
        passwordHash,
        role: 'OWNER',
        emailVerified: true,
        lifecycleStatus: userLifecycle,
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Charity', lifecycleStatus: orgLifecycle },
      }),
    },
  } as never);
}

test('a wrong password against a SUSPENDED organisation stays generic', async () => {
  // This is the security property of the whole change: the explanation must be
  // unreachable without valid credentials, or it becomes an enumeration oracle.
  const service = await serviceFor('ACTIVE', 'SUSPENDED');
  const err = await service.login({ email: 'user@example.org', password: 'wrong' }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 401);
  assert.equal(codeOf(err), 'INVALID_CREDENTIALS');
});

test('a correct password against a SUSPENDED organisation explains why', async () => {
  const service = await serviceFor('ACTIVE', 'SUSPENDED');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ORGANISATION_SUSPENDED');
});

test('a correct password against a CLOSED organisation explains why', async () => {
  const service = await serviceFor('ACTIVE', 'CLOSED');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ORGANISATION_CLOSED');
});

test('a suspended user in an active organisation is told about the account', async () => {
  const service = await serviceFor('SUSPENDED', 'ACTIVE');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ACCOUNT_SUSPENDED');
});

test('an unknown email is still a generic 401', async () => {
  const service = new AuthService({ user: { findUnique: async () => null } } as never);
  const err = await service.login({ email: 'nobody@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 401);
  assert.equal(codeOf(err), 'INVALID_CREDENTIALS');
});
