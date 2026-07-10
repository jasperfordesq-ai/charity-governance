import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-service-flows-test-secret';

const { AuthService } = await import('../services/auth.service.js');

type Call = { name: string; args: unknown };

function emailSpy() {
  const sent: Call[] = [];
  return {
    sent,
    service: {
      sendWelcomeEmail: async (...a: unknown[]) => { sent.push({ name: 'welcome', args: a }); return true; },
      sendEmailVerification: async (...a: unknown[]) => { sent.push({ name: 'verify', args: a }); return true; },
      sendPasswordReset: async (...a: unknown[]) => { sent.push({ name: 'reset', args: a }); return true; },
    },
  };
}

// ── forgotPassword: must never reveal whether an account exists ──

test('forgotPassword sends a reset link for a known account and returns the generic message', async () => {
  const updates: Call[] = [];
  const email = emailSpy();
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'u1', email: 'owner@example.org', name: 'Owner' }),
      update: async (args: unknown) => { updates.push({ name: 'user.update', args }); return {}; },
    },
  };
  const service = new AuthService(prisma as never, email.service as never);

  const result = await service.forgotPassword('owner@example.org');

  assert.match(result.message, /if an account with that email exists/i);
  assert.equal(updates.length, 1, 'a reset token must be stored for a known account');
  // The stored token must be hashed, not the raw token.
  const data = (updates[0].args as { data: { resetToken: string } }).data;
  assert.match(data.resetToken, /^[a-f0-9]{64}$/, 'reset token must be stored as a sha256 hash');
  assert.equal(email.sent.filter((s) => s.name === 'reset').length, 1);
});

test('forgotPassword keeps its neutral response when email delivery resolves false', async () => {
  let emailAttempted = false;
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'u1', email: 'owner@example.org', name: 'Owner' }),
      update: async () => ({}),
    },
  };
  const service = new AuthService(prisma as never, {
    sendPasswordReset: async () => {
      emailAttempted = true;
      return false;
    },
  } as never);

  const result = await service.forgotPassword('owner@example.org');

  assert.match(result.message, /if an account with that email exists/i);
  assert.equal(emailAttempted, true);
});

test('forgotPassword returns the same message and does nothing for an unknown account', async () => {
  const updates: Call[] = [];
  const email = emailSpy();
  const prisma = {
    user: {
      findUnique: async () => null,
      update: async (args: unknown) => { updates.push({ name: 'user.update', args }); return {}; },
    },
  };
  const service = new AuthService(prisma as never, email.service as never);

  const result = await service.forgotPassword('ghost@example.org');

  assert.match(result.message, /if an account with that email exists/i);
  assert.equal(updates.length, 0, 'no token is stored for an unknown account');
  assert.equal(email.sent.length, 0, 'no email is sent for an unknown account');
});

// ── resetPassword: token must be single-use and sessions revoked ──

function resetPrisma(opts: { found: boolean; consumeCount: number; revoked?: Call[] }) {
  const revoked = opts.revoked ?? [];
  return {
    user: {
      findFirst: async () => (opts.found ? { id: 'u1' } : null),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        user: { updateMany: async () => ({ count: opts.consumeCount }) },
        authSession: { updateMany: async (args: unknown) => { revoked.push({ name: 'revoke', args }); return { count: 3 }; } },
      }),
  };
}

test('resetPassword rejects an invalid or expired token', async () => {
  const service = new AuthService(resetPrisma({ found: false, consumeCount: 0 }) as never, emailSpy().service as never);
  await assert.rejects(
    () => service.resetPassword('bad-token', 'NewPassword1'),
    (err: unknown) => (err as { code?: string; statusCode?: number })?.code === 'INVALID_RESET_TOKEN' &&
      (err as { statusCode?: number })?.statusCode === 400,
  );
});

test('resetPassword consumes the token, sets the password, and revokes all sessions', async () => {
  const revoked: Call[] = [];
  const service = new AuthService(resetPrisma({ found: true, consumeCount: 1, revoked }) as never, emailSpy().service as never);

  const result = await service.resetPassword('good-token', 'NewPassword1');

  assert.match(result.message, /reset successfully/i);
  assert.equal(revoked.length, 1, 'all active sessions must be revoked on password reset');
  const where = (revoked[0].args as { where: { userId: string; revokedAt: null } }).where;
  assert.equal(where.userId, 'u1');
  assert.equal(where.revokedAt, null);
});

test('resetPassword rejects when the token was already consumed concurrently', async () => {
  // findFirst saw the token, but the atomic consume updated 0 rows (another
  // request won the race) — must fail rather than silently set the password.
  const service = new AuthService(resetPrisma({ found: true, consumeCount: 0 }) as never, emailSpy().service as never);
  await assert.rejects(
    () => service.resetPassword('good-token', 'NewPassword1'),
    (err: unknown) => (err as { code?: string })?.code === 'INVALID_RESET_TOKEN',
  );
});

// ── verifyEmail: token must be single-use ──

test('verifyEmail rejects an invalid or expired token', async () => {
  const prisma = { user: { findFirst: async () => null } };
  const service = new AuthService(prisma as never, emailSpy().service as never);
  await assert.rejects(
    () => service.verifyEmail('bad'),
    (err: unknown) => (err as { code?: string })?.code === 'INVALID_VERIFY_TOKEN',
  );
});

test('verifyEmail marks the account verified when the token is valid', async () => {
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'u1' }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new AuthService(prisma as never, emailSpy().service as never);
  const result = await service.verifyEmail('good');
  assert.match(result.message, /verified successfully/i);
});

test('verifyEmail rejects when the token was already consumed concurrently', async () => {
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'u1' }),
      updateMany: async () => ({ count: 0 }),
    },
  };
  const service = new AuthService(prisma as never, emailSpy().service as never);
  await assert.rejects(
    () => service.verifyEmail('good'),
    (err: unknown) => (err as { code?: string })?.code === 'INVALID_VERIFY_TOKEN',
  );
});

// ── register: must not reveal that an email is already taken ──

test('register returns the neutral accepted message and creates nothing for an existing email', async () => {
  const writes: Call[] = [];
  const email = emailSpy();
  const prisma = {
    user: { findUnique: async () => ({ id: 'existing', email: 'taken@example.org' }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => { writes.push({ name: 'transaction', args: null }); return cb({}); },
  };
  const service = new AuthService(prisma as never, email.service as never);

  const result = await service.register({
    email: 'taken@example.org',
    password: 'NewPassword1',
    name: 'New User',
    organisationName: 'New Org',
  });

  assert.match(result.message, /check your email/i);
  assert.equal(writes.length, 0, 'must not start an org/user creation transaction for an existing email');
  assert.equal(email.sent.length, 0);
});
