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
  const originalCompare = bcrypt.compare;
  const compareCalls: Array<{ password: string; hash: string }> = [];
  const service = new AuthService(mockPrismaNoUser(), {} as never);

  bcrypt.compare = async (password: string, hash: string) => {
    compareCalls.push({ password, hash });
    return false;
  };

  try {
    await assert.rejects(
      service.login({ email: 'no-account@example.org', password: 'whatever' }),
      (err: unknown) => (err as { code?: string })?.code === 'INVALID_CREDENTIALS',
    );
  } finally {
    bcrypt.compare = originalCompare;
  }

  assert.equal(compareCalls.length, 1);
  assert.equal(compareCalls[0]?.password, 'whatever');
  assert.match(compareCalls[0]?.hash, /^\$2[aby]\$12\$/);
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
