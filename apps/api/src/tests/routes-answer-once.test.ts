import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'answer-once-test-tenant-secret';
process.env.OWNER_JWT_SECRET = 'answer-once-test-owner-secret-at-least-32-chars';
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
 * A route answers the request exactly once.
 *
 * `reply.sent` is `raw.writableEnded`, which stays false until `res.end()` has
 * actually run. An async `onSend` hook makes `reply.send()` return before that,
 * so a handler that sends and then resolves with `undefined` hands Fastify's
 * `wrapThenable` a payload of `undefined` while `reply.sent` is still false.
 * Fastify reads that as "the handler never answered" and sends a second time:
 * the whole `onSend` chain runs again and `onSendEnd` writes a head that is
 * already written, which is the `ERR_HTTP_HEADERS_SENT` the live server logged.
 *
 * Whether the second send happens is decided by microtask count. With exactly
 * one async `onSend` hook Fastify's own end-of-send is queued first and wins,
 * and everything looks fine; with two it loses. The server registers two, so
 * these build with both, for the same reason `guards-stop-the-request` does.
 *
 * Counting `onSend` runs rather than reading the response body is deliberate:
 * the client still receives the *first*, correct answer, so every assertion
 * about status or payload passes while the server is answering twice. That is
 * exactly why this went unnoticed. The count is the only honest witness.
 */
const PASSWORD = 'AnswerOnce!2026';
const CLIENT_HEADER = { 'x-charitypilot-client': 'mcp-connector/0.1.0' };

function buildApp(operator: Record<string, unknown> | null) {
  const app = Fastify({ logger: false });
  const sendChainRuns = { count: 0 };

  return (async () => {
    await app.register(securityHeadersPlugin);
    await app.register(connectorIdempotencyPlugin);

    // Registered last so it observes the complete chain. Async on purpose:
    // a synchronous hook costs no extra microtask and would hide the defect.
    app.addHook('onSend', async (_request, _reply, payload) => {
      sendChainRuns.count += 1;
      return payload;
    });

    app.decorate('prisma', {
      platformOperator: {
        findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
          if (!operator) return null;
          if (where.email && operator['email'] !== where.email) return null;
          return operator;
        },
      },
      platformOperatorSession: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'opsess-1', ...data }),
      },
      platformOperatorRecoveryCode: {
        updateMany: async () => ({ count: 0 }),
      },
    } as never);

    await app.register(ownerConnectorAuthRoutes, { prefix: '/api/v1/owner/auth/connector' });
    return { app, sendChainRuns };
  })();
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

async function loginOnce(
  operator: Record<string, unknown> | null,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; sendChainRuns: number }> {
  const { app, sendChainRuns } = await buildApp(operator);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/connector/login',
      headers: CLIENT_HEADER,
      payload: { email: 'operator@example.org', password: PASSWORD, accessLevel: 'ADMIN', ...body },
    });
    // The second send is queued, not immediate: let the loop drain before counting.
    await new Promise((resolve) => setImmediate(resolve));
    return { statusCode: response.statusCode, sendChainRuns: sendChainRuns.count };
  } finally {
    await app.close();
  }
}

test('a 500 raised inside the handler is answered once, not twice', async () => {
  // The live case: a secret sealed with a different key. `checkOperatorSecondFactor`
  // throws AppError(500, OPERATOR_SECOND_FACTOR_UNREADABLE), the handler catches it
  // and calls handleError, and the server then answered a second time on top.
  const { row } = await operatorRow({ enrolled: true });
  const result = await loginOnce(
    { ...row, totpSecret: { v: 1, iv: 'AAAA', tag: 'BBBB', ciphertext: 'CCCC' } },
    { code: '000000' },
  );

  assert.equal(result.statusCode, 500);
  assert.equal(
    result.sendChainRuns,
    1,
    'the onSend chain ran more than once, which means the route answered the request '
      + 'more than once; the second answer is what produced ERR_HTTP_HEADERS_SENT',
  );
});

test('a refusal is answered once', async () => {
  // Not a 500 and not the operator realm's fault: any handler that sends without
  // returning does this. Pinned here so a fix aimed only at 500s cannot pass.
  const { row } = await operatorRow({ enrolled: false });
  const result = await loginOnce(row, {});

  assert.equal(result.statusCode, 403);
  assert.equal(result.sendChainRuns, 1, 'a 403 refusal must be sent exactly once too');
});

test('a successful sign-in is answered once', async () => {
  const { row, secret } = await operatorRow({ enrolled: true });
  const result = await loginOnce(row, { code: totp(fromBase32(secret)) });

  assert.equal(result.statusCode, 200);
  assert.equal(result.sendChainRuns, 1, 'the success path sends without returning too');
});

test('a validation failure is answered once', async () => {
  const { row } = await operatorRow({ enrolled: true });
  const result = await loginOnce(row, { accessLevel: 'NOT_A_LEVEL' });

  assert.equal(result.statusCode, 400);
  assert.equal(result.sendChainRuns, 1, 'the ZodError branch sends without returning too');
});
