import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'operator-login-test-tenant-secret';
process.env.OWNER_JWT_SECRET = 'operator-login-test-owner-secret';
process.env.AUTH_RECOVERY_ROOT_KEY = process.env.AUTH_RECOVERY_ROOT_KEY
  ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const [
  { default: Fastify },
  { ownerConnectorAuthRoutes },
  { securityHeadersPlugin },
  { connectorIdempotencyPlugin },
  { sealTotpSecret },
  { generateTotpSecret, totp, fromBase32 },
] = await Promise.all([
  import('fastify'),
  import('../routes/owner/connector.js'),
  import('../plugins/security-headers.js'),
  import('../plugins/connector-idempotency.js'),
  import('../services/operator-second-factor.service.js'),
  import('../utils/totp.js'),
]);

/**
 * The operator connector's sign-in, against the real route.
 *
 * Built with BOTH onSend hooks the server registers, for the reason every
 * guard test in this codebase now is: with exactly one, Fastify short-circuits
 * a reply that was sent but not returned, and the test passes for a route that
 * does not work.
 *
 * Every case here was found by the live suite before it was written down.
 */
const PASSWORD = 'OperatorLogin!2026';
const CLIENT_HEADER = { 'x-charitypilot-client': 'mcp-connector/0.1.0' };

async function buildApp(operator: Record<string, unknown> | null) {
  const app = Fastify({ logger: false });
  await app.register(securityHeadersPlugin);
  await app.register(connectorIdempotencyPlugin);

  app.decorate('prisma', {
    platformOperator: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (!operator) return null;
        if (where.email && operator['email'] !== where.email) return null;
        return operator;
      },
    },
    platformOperatorSession: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'opsess-1',
        ...data,
      }),
    },
    platformOperatorRecoveryCode: {
      updateMany: async () => ({ count: 0 }),
    },
  } as never);

  await app.register(ownerConnectorAuthRoutes, { prefix: '/api/v1/owner/auth/connector' });
  return app;
}

async function operatorRow(options: { enrolled: boolean }) {
  const secret = generateTotpSecret();
  return {
    row: {
      id: 'op-1',
      email: 'operator@example.org',
      name: 'Operator',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      lifecycleStatus: 'ACTIVE',
      totpEnrolledAt: options.enrolled ? new Date('2026-09-20T00:00:00.000Z') : null,
      totpSecret: options.enrolled ? sealTotpSecret(secret) : null,
    },
    secret,
  };
}

function login(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/connector/login',
    headers: CLIENT_HEADER,
    payload: { email: 'operator@example.org', password: PASSWORD, accessLevel: 'ADMIN', ...body },
  });
}

test('an operator with no enrolled authenticator is refused, and told where to enrol', async () => {
  const { row } = await operatorRow({ enrolled: false });
  const app = await buildApp(row);
  try {
    const response = await login(app, {});

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'OPERATOR_SECOND_FACTOR_REQUIRED');
    assert.match(response.json().error, /\/owner\/security/);
  } finally {
    await app.close();
  }
});

test('a wrong authenticator code is refused with one clean 401, not a 500', async () => {
  // Found by the live suite: the refusal reached the connector as a generic
  // sign-in failure, and the server logged "Reply was already sent". A route
  // that answers twice answers with whatever the second attempt produces,
  // which here was a 500 that says nothing a person can act on.
  const { row } = await operatorRow({ enrolled: true });
  const app = await buildApp(row);
  try {
    const response = await login(app, { code: '000000' });

    assert.equal(response.statusCode, 401, 'a wrong code is a 401, never a 500');
    assert.equal(response.json().code, 'SECOND_FACTOR_REQUIRED');
    assert.match(response.json().error, /authenticator code/i);
  } finally {
    await app.close();
  }
});

test('the right code signs in, returns tokens in the body and sets no cookie', async () => {
  const { row, secret } = await operatorRow({ enrolled: true });
  const app = await buildApp(row);
  try {
    const response = await login(app, { code: totp(fromBase32(secret)) });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.operator.email, 'operator@example.org');
    assert.ok(body.accessToken && body.refreshToken);
    assert.equal(body.session.clientKind, 'MCP_CONNECTOR');
    assert.equal(
      response.headers['set-cookie'],
      undefined,
      'a response that sets no cookie cannot be the target of login CSRF, which is '
        + 'what lets this route waive the origin requirement',
    );
    assert.equal(body.session.dataScope, undefined, 'this realm has no data scope');
  } finally {
    await app.close();
  }
});

test('a wrong password is refused before the second factor is even considered', async () => {
  const { row } = await operatorRow({ enrolled: true });
  const app = await buildApp(row);
  try {
    const response = await login(app, { password: 'WrongPassword!', code: '000000' });

    assert.equal(response.statusCode, 401);
    assert.equal(
      response.json().code,
      'INVALID_CREDENTIALS',
      'the refusal must not say whether the account has a second factor',
    );
  } finally {
    await app.close();
  }
});

test('an unknown operator learns nothing about whether the account exists', async () => {
  const app = await buildApp(null);
  try {
    const response = await login(app, { code: '000000' });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'INVALID_CREDENTIALS');
  } finally {
    await app.close();
  }
});

test('a browser-shaped request is refused before any credential is read', async () => {
  const { row } = await operatorRow({ enrolled: true });
  const app = await buildApp(row);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/connector/login',
      headers: { ...CLIENT_HEADER, origin: 'https://console.example.org' },
      payload: { email: 'operator@example.org', password: PASSWORD, accessLevel: 'ADMIN' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'BROWSER_CLIENT_REJECTED');
  } finally {
    await app.close();
  }
});

test('an unreadable enrolment is refused once, not answered twice', async () => {
  // Found by the live suite, where a secret sealed with a different key made
  // the route answer, fail to answer, and then answer again: one 500 from the
  // unreadable secret, an ERR_HTTP_HEADERS_SENT on top of it, and a
  // FST_ERR_REP_ALREADY_SENT on top of that. A route that answers twice
  // answers with whatever the last attempt produced.
  const { row } = await operatorRow({ enrolled: true });
  const app = await buildApp({ ...row, totpSecret: { v: 1, iv: 'AAAA', tag: 'BBBB', ciphertext: 'CCCC' } });
  try {
    const response = await login(app, { code: '000000' });

    assert.notEqual(response.statusCode, 200, 'a broken second factor must fail closed');
    assert.equal(
      typeof response.json().code,
      'string',
      'the caller gets one structured refusal, not a half-written response',
    );
  } finally {
    await app.close();
  }
});
