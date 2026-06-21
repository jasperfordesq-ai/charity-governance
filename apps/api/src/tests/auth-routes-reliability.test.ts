import assert from 'node:assert/strict';
import test from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
// The auth route group constructs an AuthService -> EmailService, which reads RESEND_API_KEY /
// EMAIL_FROM at construction time, and the guards/JWT utils read JWT_SECRET.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-routes-reliability-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_auth_routes_reliability_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { authRoutes }, { AuthService }, { signAccessToken }, { Prisma }] =
  await Promise.all([
    import('fastify'),
    import('../routes/auth/index.js'),
    import('../services/auth.service.js'),
    import('../utils/jwt.js'),
    import('@prisma/client'),
  ]);

// ── auth-input-validation-10 ──
// Each Zod-validated auth endpoint rejects a malformed/missing-field body with
// 400 {code:'VALIDATION_ERROR'} and a structured details array, never a 500 or stack leak.
test('auth endpoints reject malformed bodies with a 400 VALIDATION_ERROR and never 500', async () => {
  const app = Fastify({ logger: false });
  // Writes / lookups must never run: a malformed body is rejected before any service work.
  let userQueried = false;
  let transactionCalled = false;
  app.decorate('prisma', {
    user: {
      findUnique: async () => {
        userQueried = true;
        return null;
      },
      findFirst: async () => {
        userQueried = true;
        return null;
      },
    },
    $transaction: async () => {
      transactionCalled = true;
    },
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  const cases: Array<{ name: string; url: string; payload: Record<string, unknown> }> = [
    { name: 'register missing password', url: '/auth/register', payload: { email: 'owner@example.org', name: 'Owner', organisationName: 'Org' } },
    { name: 'login bad email', url: '/auth/login', payload: { email: 'not-an-email', password: 'NewPassword1' } },
    { name: 'forgot-password empty', url: '/auth/forgot-password', payload: {} },
    { name: 'reset-password empty token', url: '/auth/reset-password', payload: { token: '', password: 'NewPassword1' } },
    { name: 'verify-email empty', url: '/auth/verify-email', payload: {} },
  ];

  try {
    for (const c of cases) {
      const response = await app.inject({ method: 'POST', url: c.url, payload: c.payload });
      assert.equal(response.statusCode, 400, `${c.name}: expected 400`);
      const body = response.json();
      assert.equal(body.code, 'VALIDATION_ERROR', `${c.name}: expected VALIDATION_ERROR`);
      assert.ok(Array.isArray(body.details), `${c.name}: details must be an array`);
    }

    assert.equal(userQueried, false, 'no user lookup should run for a malformed body');
    assert.equal(transactionCalled, false, 'no creation transaction should run for a malformed body');
  } finally {
    await app.close();
  }
});

// ── auth-input-validation-11 ──
// register rejects passwords failing the strength policy with 400 VALIDATION_ERROR,
// never starting the org/user-creation transaction.
test('register rejects weak passwords without starting the creation transaction', async () => {
  const app = Fastify({ logger: false });
  let transactionCalled = false;
  app.decorate('prisma', {
    user: {
      findUnique: async () => null,
    },
    $transaction: async () => {
      transactionCalled = true;
    },
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'owner@example.org',
        password: 'alllowercase', // violates upper + digit rules
        name: 'Owner One',
        organisationName: 'Org One',
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'VALIDATION_ERROR');
    assert.equal(transactionCalled, false, 'a weak password must never start the creation transaction');
  } finally {
    await app.close();
  }
});

// ── auth-graceful-degradation-12 ──
// When the email provider fails to send the verification email, resendEmailVerification
// surfaces a clean 503 {code:'EMAIL_DELIVERY_FAILED'} rather than a 200 or 500.
test('resendEmailVerification surfaces a 503 when the verification email cannot be sent', async () => {
  const { AppError } = await import('../utils/errors.js');

  let updateCalled = false;
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'u1',
        email: 'owner@example.org',
        name: 'Owner One',
        emailVerified: false,
      }),
      update: async () => {
        updateCalled = true;
        return {};
      },
    },
  };
  const emailService = {
    // Simulate a provider that fails to deliver: send resolves falsy.
    sendEmailVerification: async () => false,
  };
  const service = new AuthService(prisma as never, emailService as never);

  await assert.rejects(
    () => service.resendEmailVerification('u1'),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 503 &&
      error.code === 'EMAIL_DELIVERY_FAILED',
  );

  // The token rotation update runs before the send attempt; the failure is surfaced cleanly.
  assert.equal(updateCalled, true);
});

// ── auth-input-validation-14 ──
// register flattens the DB-enforced unique-email race: when the creation transaction throws
// a Prisma P2002 unique-constraint error, the service returns the same neutral accepted
// message instead of leaking the conflict or 500ing, and sends no verification email.
test('register flattens a raced duplicate-email unique-constraint failure to the neutral message', async () => {
  let emailSent = false;
  const uniqueError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'User_email_key' },
  });
  const prisma = {
    user: {
      // Passes the pre-check (no existing user seen), so registration proceeds to the transaction.
      findUnique: async () => null,
      update: async () => ({}),
    },
    $transaction: async () => {
      throw uniqueError;
    },
  };
  const emailService = {
    sendWelcomeEmail: async () => {
      emailSent = true;
      return true;
    },
    sendEmailVerification: async () => {
      emailSent = true;
      return true;
    },
  };
  const service = new AuthService(prisma as never, emailService as never);

  const result = await service.register({
    email: 'taken@example.org',
    password: 'NewPassword1',
    name: 'New User',
    organisationName: 'New Org',
  });

  assert.match(result.message, /check your email/i);
  assert.equal(emailSent, false, 'no verification email is sent for a raced duplicate registration');
});

// ── auth-authz-boundary-18 ──
// GET /me requires a valid authenticated identity (authIdentityGuard): an unauthenticated
// request is rejected with 401 {code:'UNAUTHORIZED'}, and an authenticated request returns
// only the caller's own public user (no secrets).
test('GET /me requires authentication and returns only the caller\'s public user', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: {
      findFirst: async () => ({ id: 'sess-1' }),
    },
    user: {
      findUnique: async () => ({
        id: 'u1',
        email: 'owner@example.org',
        name: 'Owner One',
        role: 'OWNER',
        emailVerified: true,
        organisationId: 'org-1',
        // A secret that must never appear in the public response.
        passwordHash: '$2b$12$shouldNeverBeSerialised',
        organisation: { id: 'org-1', name: 'Org One' },
      }),
    },
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/auth/me' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().code, 'UNAUTHORIZED');

    const token = signAccessToken({
      userId: 'u1',
      organisationId: 'org-1',
      role: 'OWNER',
      sessionId: 'sess-1',
    });
    const authenticated = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(authenticated.statusCode, 200);
    const body = authenticated.json();
    assert.equal(body.id, 'u1');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'passwordHash'), false, 'public user must not leak passwordHash');
  } finally {
    await app.close();
  }
});
