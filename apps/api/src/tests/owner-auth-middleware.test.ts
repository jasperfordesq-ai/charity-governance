import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-mw-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-mw-test';

const [{ default: Fastify }, { requirePlatformOperator }, { signOperatorAccessToken }, { signAccessToken }] =
  await Promise.all([
    import('fastify'),
    import('../middleware/owner-auth.js'),
    import('../utils/owner-jwt.js'),
    import('../utils/jwt.js'),
  ]);

function appWith(operatorRow: unknown, sessionRow: unknown) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    platformOperatorSession: {
      findFirst: async (opts: any) => {
        // Stub honors the where clause: only return sessionRow if it passes all filters.
        if (!sessionRow) return null;
        const where = opts?.where || {};
        const session = sessionRow as any;
        // Check id and operatorId match
        if (where.id && session.id !== where.id) return null;
        if (where.operatorId && session.operatorId !== where.operatorId) return null;
        // Check revokedAt is null if required
        if (where.revokedAt === null && session.revokedAt !== null) return null;
        // Check expiresAt > date if required
        if (where.expiresAt?.gt && session.expiresAt <= where.expiresAt.gt) return null;
        return sessionRow;
      },
    },
    platformOperator: { findUnique: async () => operatorRow },
  } as never);
  app.get('/probe', { preHandler: [requirePlatformOperator] }, async (request) => ({
    operatorId: (request as { operator?: { id: string } }).operator?.id,
  }));
  return app;
}

const activeOperator = { id: 'op-1', email: 'owner@example.org', lifecycleStatus: 'ACTIVE' };
const liveSession = { id: 's-1', operatorId: 'op-1', revokedAt: null, expiresAt: new Date(Date.now() + 3600000) };

test('a valid operator token is accepted and decorates request.operator', async () => {
  const app = appWith(activeOperator, liveSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().operatorId, 'op-1');
  await app.close();
});

test('a tenant token is rejected', async () => {
  const app = appWith(activeOperator, liveSession);
  const tenantToken = signAccessToken({ userId: 'u-1', organisationId: 'org-1', role: 'OWNER', sessionId: 's-1' });
  const res = await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${tenantToken}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'OWNER_UNAUTHORIZED');
  await app.close();
});

test('a missing token is rejected', async () => {
  const app = appWith(activeOperator, liveSession);
  const res = await app.inject({ method: 'GET', url: '/probe' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a revoked session is rejected even with a valid signature', async () => {
  const revokedSession = { id: 's-1', operatorId: 'op-1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) };
  const app = appWith(activeOperator, revokedSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('an expired session is rejected even with a valid signature', async () => {
  const expiredSession = { id: 's-1', operatorId: 'op-1', revokedAt: null, expiresAt: new Date(Date.now() - 3600000) };
  const app = appWith(activeOperator, expiredSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a suspended operator is rejected', async () => {
  const app = appWith({ ...activeOperator, lifecycleStatus: 'SUSPENDED' }, liveSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a missing operator row is rejected', async () => {
  const app = appWith(null, liveSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
