import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'approval-role-boundary-test-secret';

const [
  { default: Fastify },
  { default: cookie },
  { authRoutes },
  { connectorAuthRoutes },
  { CONNECTOR_CLIENT_HEADER },
  { signAccessToken },
] = await Promise.all([
  import('fastify'),
  import('@fastify/cookie'),
  import('../routes/auth/index.js'),
  import('../routes/auth/connector.js'),
  import('../utils/non-browser-client.js'),
  import('../utils/jwt.js'),
]);

test('demoted Members cannot read or grant old action approvals in either client', async () => {
  let role: 'ADMIN' | 'MEMBER' = 'ADMIN';
  let approvalReads = 0;
  let approvalWrites = 0;
  const refusals: Record<string, unknown>[] = [];
  const summary = 'Permanently delete trustee Aoife Chairperson';
  const approval = {
    id: 'approval-1', summary, method: 'DELETE', routePattern: '/board-members/:id',
    resourceId: 'trustee-1', createdAt: new Date('2026-09-29T10:00:00.000Z'),
    expiresAt: new Date('2026-09-29T10:05:00.000Z'), approvedAt: null, consumedAt: null,
  };
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.decorate('prisma', {
    authSession: { findFirst: async (args: { where: { id: string } }) => ({
      id: args.where.id, familyId: 'family-1',
      clientKind: args.where.id === 'session-web' ? 'WEB' : 'MCP_CONNECTOR',
      accessLevel: 'ADMIN', dataScope: 'FULL',
    }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role, emailVerified: true, lifecycleStatus: 'ACTIVE', organisation: { lifecycleStatus: 'ACTIVE' } }) },
    authActionApproval: {
      findMany: async () => { approvalReads += 1; return [approval]; },
      findFirst: async () => { approvalReads += 1; return approval; },
      updateMany: async () => { approvalWrites += 1; return { count: 1 }; },
    },
    securityAuditEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { refusals.push(data); return { id: 'refusal-1' }; } },
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(connectorAuthRoutes, { prefix: '/auth/connector' });

  const browserToken = signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'ADMIN', sessionId: 'session-web' });
  const connectorToken = signAccessToken({ userId: 'user-1', organisationId: 'org-1', role: 'ADMIN', sessionId: 'session-connector' });
  const browserHeaders = { authorization: `Bearer ${browserToken}` };
  const connectorHeaders = { authorization: `Bearer ${connectorToken}`, [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0' };
  try {
    const before = await app.inject({ method: 'GET', url: '/auth/approvals', headers: browserHeaders });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().data[0].summary, summary);
    approvalReads = 0;
    for (const request of [
      { method: 'GET' as const, url: '/auth/approvals', headers: connectorHeaders },
      { method: 'POST' as const, url: '/auth/approvals/approval-1/grant', headers: connectorHeaders, payload: { password: 'irrelevant' } },
    ]) {
      const denied = await app.inject(request);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().code, 'WEB_SESSION_REQUIRED');
    }
    assert.equal(approvalReads, 0);
    assert.equal(approvalWrites, 0);
    const refused = await app.inject({ method: 'POST', url: '/auth/approvals/approval-1/grant',
      headers: browserHeaders, payload: { password: 'irrelevant' } });
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.json().code, 'APPROVAL_REFUSED');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].type, 'ACTION_APPROVAL_REFUSED');
    assert.deepEqual(refusals[0].context, { clientKind: 'WEB' });
    assert.equal(JSON.stringify(refusals[0]).includes('approval-1'), false);
    assert.equal(JSON.stringify(refusals[0]).includes('irrelevant'), false);
    role = 'MEMBER';
    approvalReads = 0;

    for (const request of [
      { method: 'GET' as const, url: '/auth/approvals', headers: browserHeaders },
      { method: 'POST' as const, url: '/auth/approvals/approval-1/grant', headers: browserHeaders, payload: { password: 'irrelevant' } },
      { method: 'GET' as const, url: '/auth/connector/approvals/approval-1', headers: connectorHeaders },
      { method: 'POST' as const, url: '/auth/connector/approve', headers: connectorHeaders, payload: { approvalId: 'approval-1', password: 'irrelevant' } },
    ]) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
      assert.equal(response.json().code, 'FORBIDDEN');
      assert.equal(JSON.stringify(response.json()).includes(summary), false);
    }
    assert.equal(approvalReads, 0, 'Member denial must happen before reading an old approval summary');
    assert.equal(approvalWrites, 0, 'Member denial must happen before granting an old approval');
    assert.equal(refusals.length, 1, 'Member denial must happen before any refusal audit write');
  } finally {
    await app.close();
  }
});
