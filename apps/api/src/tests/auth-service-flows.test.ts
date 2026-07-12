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

test('AuthService forwards forgot-password context to the durable recovery service', async () => {
  const calls: unknown[][] = [];
  const recovery = {
    requestPasswordReset: async (...args: unknown[]) => {
      calls.push(args);
      return { message: 'If an account with that email exists, a reset link has been sent.' };
    },
  };
  const service = new AuthService({} as never, emailSpy().service as never, recovery as never);
  const context = { ipAddress: '203.0.113.10', requestId: 'request-1' };

  const result = await service.forgotPassword('owner@example.org', context);

  assert.match(result.message, /if an account with that email exists/i);
  assert.deepEqual(calls, [['owner@example.org', context]]);
});

// ── resetPassword: token must be single-use and sessions revoked ──

test('AuthService forwards reset-password context to the durable recovery service', async () => {
  const calls: unknown[][] = [];
  const recovery = {
    resetPassword: async (...args: unknown[]) => {
      calls.push(args);
      return { message: 'Password has been reset successfully.' };
    },
  };
  const service = new AuthService({} as never, emailSpy().service as never, recovery as never);
  const context = { ipAddress: '203.0.113.10', requestId: 'request-2' };

  const result = await service.resetPassword('good-token', 'NewPassword1', context);

  assert.match(result.message, /reset successfully/i);
  assert.deepEqual(calls, [['good-token', 'NewPassword1', context]]);
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
