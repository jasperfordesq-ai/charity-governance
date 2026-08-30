import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-setpw-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-setpw-test';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, bcrypt, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('bcryptjs'),
    import('../routes/owner/index.js'),
  ]);

const RAW_TOKEN = 'a-valid-reset-token';
const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

async function buildApp(operator: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: {
      findFirst: async () => operator,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    platformOperatorSession: { updateMany: async () => ({ count: 0 }) },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return { app, updates };
}

const liveOperator = {
  id: 'op-1',
  email: 'owner@example.org',
  resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
};

test('a valid token sets the password and clears the token', async () => {
  const { app, updates } = await buildApp(liveOperator);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  assert.equal(res.statusCode, 200);
  const written = updates[0];
  assert.equal(written.resetToken, null, 'the reset token must be single-use');
  assert.equal(written.resetTokenExpiry, null);
  assert.ok(await bcrypt.default.compare('a-long-enough-new-password', written.passwordHash as string));
  await app.close();
});

test('an unknown or already-used token is refused', async () => {
  const { app, updates } = await buildApp(null);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: 'wrong', password: 'a-long-enough-new-password' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_RESET_TOKEN');
  assert.equal(updates.length, 0);
  await app.close();
});

test('a short password is refused before any write', async () => {
  const { app, updates } = await buildApp(liveOperator);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'short' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(updates.length, 0);
  await app.close();
});

test('the raw token is never used as a lookup key', async () => {
  // The column stores a sha256 hash; querying by the raw value would never match
  // and would mean the CLI-issued link could not work at all.
  let observedWhere: Record<string, unknown> | undefined;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        observedWhere = where;
        return liveOperator;
      },
      update: async () => ({}),
    },
    platformOperatorSession: { updateMany: async () => ({ count: 0 }) },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });

  await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  assert.equal(observedWhere?.resetToken, TOKEN_HASH);
  assert.notEqual(observedWhere?.resetToken, RAW_TOKEN);
  await app.close();
});
