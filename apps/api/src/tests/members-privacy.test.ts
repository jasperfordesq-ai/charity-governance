import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'members-privacy-test-secret';

const [{ default: Fastify }, { memberRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/members/index.js'),
  import('../utils/jwt.js'),
]);

function token(role: 'MEMBER' | 'ADMIN') {
  return `Bearer ${signAccessToken({ userId: 'user-1', organisationId: 'org-1', role, sessionId: 'session-1' })}`;
}

async function appFor(role: 'MEMBER' | 'ADMIN', onRead: (args: unknown) => void) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => ({ status: 'ACTIVE', plan: 'COMPLETE', currentPeriodEnd: new Date(Date.now() + 60_000), trialEndsAt: null }) },
    member: { findMany: async (args: unknown) => { onRead(args); return []; } },
  } as never);
  await app.register(memberRoutes);
  return app;
}

test('statutory membership address register denies Members before database read', async () => {
  let reads = 0;
  const member = await appFor('MEMBER', () => { reads += 1; });
  try {
    const response = await member.inject({ method: 'GET', url: '/?includeFormer=true', headers: { authorization: token('MEMBER') } });
    assert.equal(response.statusCode, 403);
    assert.equal(reads, 0);
  } finally { await member.close(); }

  const admin = await appFor('ADMIN', (args) => {
    reads += 1;
    assert.deepEqual((args as { where: unknown }).where, { organisationId: 'org-1' });
  });
  try {
    const response = await admin.inject({ method: 'GET', url: '/?includeFormer=true', headers: { authorization: token('ADMIN') } });
    assert.equal(response.statusCode, 200);
    assert.equal(reads, 1);
  } finally { await admin.close(); }
});
