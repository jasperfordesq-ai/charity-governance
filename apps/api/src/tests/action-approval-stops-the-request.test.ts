import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'approval-stops-request-test-secret';

const [
  { default: Fastify },
  { requireActionApproval },
  { securityHeadersPlugin },
  { connectorIdempotencyPlugin },
] = await Promise.all([
  import('fastify'),
  import('../middleware/action-approval.js'),
  import('../plugins/security-headers.js'),
  import('../plugins/connector-idempotency.js'),
]);

/**
 * The approval guard's whole purpose is that the action does not happen.
 *
 * Refusing in the response while carrying the action out anyway is the worst
 * possible outcome: the agent reports that nothing happened, the person is
 * never asked, and the record is gone. Every test around this one asserts the
 * refusal reaches the caller; this one asserts the handler never runs, which
 * is a different claim and was not previously made anywhere.
 */
async function buildApp(options: { approvals?: Record<string, unknown> } = {}) {
  const app = Fastify({ logger: false });
  let handlerRan = false;

  // The two hooks the real server has, because the bug this test exists for
  // only appears with more than one of them: with a second onSend registered,
  // a guard that sent its refusal without returning the reply stopped
  // short-circuiting the request, and the deletion went ahead while the agent
  // was told it had been refused. Building this app without them would test a
  // server nobody runs.
  await app.register(securityHeadersPlugin);
  await app.register(connectorIdempotencyPlugin);

  app.decorate('prisma', {
    authActionApproval: {
      findFirst: async () => null,
      create: async () => ({
        id: 'approval-1',
        summary: 'Permanently delete risk "One"',
        resourceId: 'risk-1',
        expiresAt: new Date(Date.now() + 300_000),
        approvedAt: null,
      }),
      updateMany: async () => ({ count: 0 }),
      ...options.approvals,
    },
    riskRecord: { findFirst: async () => ({ title: 'One' }) },
  } as never);

  app.addHook('onRequest', async (request) => {
    request.user = {
      userId: 'u1',
      organisationId: 'org-1',
      role: 'ADMIN',
      sessionId: 'sess-1',
    };
    request.authSession = {
      id: 'sess-1',
      familyId: 'fam-1',
      clientKind: 'MCP_CONNECTOR',
      accessLevel: 'ADMIN',
      dataScope: 'FULL',
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/governance-registers/risks/:id',
    { preHandler: [requireActionApproval()] },
    async (_request, reply) => {
      handlerRan = true;
      return reply.status(204).send();
    },
  );

  return { app, ran: () => handlerRan };
}

test('a refused removal does not happen', async () => {
  const { app, ran } = await buildApp();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/governance-registers/risks/risk-1',
    });

    assert.equal(response.statusCode, 428);
    assert.equal(response.json().code, 'APPROVAL_REQUIRED');
    assert.equal(
      ran(),
      false,
      'the refusal must stop the request, not merely describe it: a record deleted '
        + 'while the agent is told it was refused is the worst outcome of the two',
    );
  } finally {
    await app.close();
  }
});

test('an approval that is spent lets the removal through', async () => {
  // The other half, so the guard cannot be made to pass the test above by
  // refusing everything for ever.
  const { app, ran } = await buildApp({
    approvals: {
      findFirst: async () => ({
        id: 'approval-1',
        approvedAt: new Date(Date.now() - 1000),
        consumedAt: null,
        expiresAt: new Date(Date.now() + 300_000),
        sessionFamilyId: 'fam-1',
      }),
      updateMany: async () => ({ count: 1 }),
    },
  });
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/governance-registers/risks/risk-1',
      headers: { 'x-charitypilot-approval': 'approval-1' },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(ran(), true);
  } finally {
    await app.close();
  }
});

test('a browser session is not asked for an approval at all', async () => {
  const app = Fastify({ logger: false });
  let handlerRan = false;
  app.decorate('prisma', {} as never);
  app.addHook('onRequest', async (request) => {
    request.user = { userId: 'u1', organisationId: 'org-1', role: 'ADMIN', sessionId: 's' };
    request.authSession = {
      id: 's',
      familyId: 'f',
      clientKind: 'WEB',
      accessLevel: 'ADMIN',
      dataScope: 'FULL',
    };
  });
  app.delete('/thing', { preHandler: [requireActionApproval()] }, async (_request, reply) => {
    handlerRan = true;
    return reply.status(204).send();
  });

  try {
    const response = await app.inject({ method: 'DELETE', url: '/thing' });
    assert.equal(response.statusCode, 204);
    assert.equal(handlerRan, true, 'a person at a keyboard is already looking at the screen');
  } finally {
    await app.close();
  }
});
