import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-login-timing-test-secret';

const { AuthService } = await import('../services/auth.service.js');

function mockPrismaNoUser() {
  return {
    user: {
      findUnique: async () => null,
    },
  } as never;
}

// Regression guard for the login timing-based user-enumeration fix: the no-user
// branch must spend the same bcrypt cost as the real path, so response latency
// does not reveal whether an account exists.
test('login spends bcrypt hashing time even when the email has no account', async () => {
  // Baseline: cost of one cost-12 bcrypt comparison on this machine.
  const dummyHash = bcrypt.hashSync('baseline-measurement', 12);
  const realStart = process.hrtime.bigint();
  await bcrypt.compare('whatever', dummyHash);
  const realCompareMs = Number(process.hrtime.bigint() - realStart) / 1e6;

  const service = new AuthService(mockPrismaNoUser(), {} as never);

  const loginStart = process.hrtime.bigint();
  await assert.rejects(
    service.login({ email: 'no-account@example.org', password: 'whatever' }),
    (err: unknown) => (err as { code?: string })?.code === 'INVALID_CREDENTIALS',
  );
  const loginMs = Number(process.hrtime.bigint() - loginStart) / 1e6;

  // A full bcrypt comparison dominates the no-user path, so it must take a large
  // fraction of a real compare — not the sub-millisecond of an early return.
  assert.ok(
    loginMs >= realCompareMs * 0.5,
    `login(no-account) took ${loginMs.toFixed(1)}ms but a single bcrypt compare is ` +
      `${realCompareMs.toFixed(1)}ms; the no-user path is not spending hashing time ` +
      '(timing-enumeration regression)',
  );
});

test('login returns the generic INVALID_CREDENTIALS error for unknown accounts', async () => {
  const service = new AuthService(mockPrismaNoUser(), {} as never);

  await assert.rejects(
    service.login({ email: 'no-account@example.org', password: 'whatever' }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; statusCode?: number };
      return e?.code === 'INVALID_CREDENTIALS' &&
        e?.statusCode === 401 &&
        e?.message === 'Invalid email or password';
    },
  );
});
