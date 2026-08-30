import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-lifecycle-route-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-lifecycle-route-test';

// This file exists specifically to cover the route's own Zod schema (see
// routes/owner/tenants.ts), which is a distinct failure surface from the
// service-level guards covered by owner-tenant-lifecycle.test.ts. A
// service-only test calling transitionTenantLifecycle directly cannot catch
// a route schema that rejects a request before the service is ever reached.
const [{ default: Fastify }, { ownerTenantRoutes }, { signOperatorAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/owner/tenants.js'),
  import('../utils/owner-jwt.js'),
]);

const OPERATOR_ROW = { id: 'op-1', email: 'owner@example.org', lifecycleStatus: 'ACTIVE' };
const LIVE_SESSION = {
  id: 's-1',
  operatorId: 'op-1',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000),
};

async function buildApp(current: { lifecycleStatus: string; lifecycleVersion: number } | null) {
  const calls = { updates: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[] };
  const tx = {
    $queryRaw: async () => (current ? [{ id: 'org-1', ...current }] : []),
    organisation: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.updates.push(data);
        return { id: 'org-1' };
      },
      findUnique: async () => ({
        id: 'org-1',
        name: 'Test Charity',
        lifecycleStatus: current?.lifecycleStatus ?? 'ACTIVE',
        lifecycleVersion: current?.lifecycleVersion ?? 1,
        createdAt: new Date('2026-01-01'),
        subscription: null,
        _count: { users: 1 },
      }),
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.audits.push(data);
        return data;
      },
    },
  };

  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    platformOperatorSession: { findFirst: async () => LIVE_SESSION },
    platformOperator: { findUnique: async () => OPERATOR_ROW },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  } as never);
  await app.register(ownerTenantRoutes);
  return { app, calls };
}

function authHeader() {
  return { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` };
}

test('a whitespace-only reason is refused as REASON_REQUIRED by the service, not VALIDATION_ERROR by the route', async () => {
  const { app, calls } = await buildApp({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  const res = await app.inject({
    method: 'POST',
    url: '/tenants/org-1/lifecycle',
    headers: authHeader(),
    payload: { action: 'SUSPEND', reason: '   ', expectedLifecycleVersion: 1 },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'REASON_REQUIRED');
  assert.equal(calls.updates.length, 0, 'no write may happen when the reason is refused');
  assert.equal(calls.audits.length, 0, 'no audit event may be written when the reason is refused');
  await app.close();
});

test('a genuinely empty reason is still refused by the route schema', async () => {
  const { app, calls } = await buildApp({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  const res = await app.inject({
    method: 'POST',
    url: '/tenants/org-1/lifecycle',
    headers: authHeader(),
    payload: { action: 'SUSPEND', reason: '', expectedLifecycleVersion: 1 },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'VALIDATION_ERROR');
  assert.equal(calls.updates.length, 0);
  await app.close();
});

test('a valid suspend request reaches the service and succeeds through the route', async () => {
  const { app, calls } = await buildApp({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  const res = await app.inject({
    method: 'POST',
    url: '/tenants/org-1/lifecycle',
    headers: authHeader(),
    payload: { action: 'SUSPEND', reason: 'Non-payment after dunning', expectedLifecycleVersion: 1 },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.audits.length, 1);
  await app.close();
});
