import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'operator-realm-test-tenant-secret';
process.env.OWNER_JWT_SECRET = 'operator-realm-test-owner-secret';

const [
  { default: Fastify },
  { requireOperatorActionApproval, summariseOperatorAction },
  { requireOperatorSessionLevel },
  { securityHeadersPlugin },
  { connectorIdempotencyPlugin },
  { assertNonBrowserClient },
  { OWNER_ACCESS_TOKEN_COOKIE, OWNER_REFRESH_TOKEN_COOKIE },
] = await Promise.all([
  import('fastify'),
  import('../middleware/owner-action-approval.js'),
  import('../middleware/owner-session-level.js'),
  import('../plugins/security-headers.js'),
  import('../plugins/connector-idempotency.js'),
  import('../utils/non-browser-client.js'),
  import('../utils/owner-cookies.js'),
]);

/**
 * The operator realm's refusals, asserted the way the tenant realm's are: by
 * whether the handler ran, not by what the response said.
 *
 * Every app here registers BOTH onSend hooks the real server registers. With
 * exactly one, Fastify short-circuits a guard that sent without returning, and
 * the test passes for a guard that does not work. That is not a hypothetical:
 * it is what happened on 2026-09-20, when every refusal in this API turned out
 * to be advisory and a record was deleted while the agent was told it had been
 * refused.
 */

interface AppOptions {
  clientKind?: 'WEB' | 'MCP_CONNECTOR';
  accessLevel?: 'READ' | 'WRITE' | 'ADMIN';
  approvals?: Record<string, unknown>;
  tenantName?: string | null;
}

async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false });
  let handlerRan = false;

  await app.register(securityHeadersPlugin);
  await app.register(connectorIdempotencyPlugin);

  app.decorate('prisma', {
    operatorActionApproval: {
      findFirst: async () => null,
      create: async () => ({
        id: 'op-approval-1',
        summary: 'CLOSE the charity "Test Charity" — this ends its access to CharityPilot',
        resourceId: 'tenant-1',
        resourceLabel: 'Test Charity',
        expiresAt: new Date(Date.now() + 300_000),
        approvedAt: null,
      }),
      updateMany: async () => ({ count: 0 }),
      ...options.approvals,
    },
    organisation: {
      findUnique: async () =>
        options.tenantName === null ? null : { name: options.tenantName ?? 'Test Charity' },
    },
  } as never);

  app.addHook('onRequest', async (request) => {
    request.operator = { id: 'op-1', email: 'operator@example.org' };
    request.operatorSession = {
      id: 'opsess-1',
      clientKind: options.clientKind ?? 'MCP_CONNECTOR',
      accessLevel: options.accessLevel ?? 'ADMIN',
      familyId: '11111111-1111-4111-8111-111111111111',
    };
  });

  app.post<{ Params: { id: string } }>(
    '/tenants/:id/lifecycle',
    { preHandler: [requireOperatorSessionLevel('ADMIN'), requireOperatorActionApproval()] },
    async (_request, reply) => {
      handlerRan = true;
      return reply.status(200).send({ ok: true });
    },
  );

  return { app, ran: () => handlerRan };
}

// ---------------------------------------------------------------------------
// The approval guard actually stops the request
// ---------------------------------------------------------------------------

test('closing a charity without an approval does not close it', async () => {
  const { app, ran } = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    assert.equal(response.statusCode, 428);
    assert.equal(response.json().code, 'APPROVAL_REQUIRED');
    assert.equal(
      ran(),
      false,
      'a charity closed while the agent is told it was refused is the worst outcome of the two',
    );
  } finally {
    await app.close();
  }
});

test('the refusal names the charity and the command to run', async () => {
  const { app } = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    const body = response.json();
    assert.equal(body.resourceLabel, 'Test Charity');
    assert.match(body.summary, /Test Charity/);
    assert.equal(body.command, 'charitypilot-mcp approve op-approval-1 --realm operator');
  } finally {
    await app.close();
  }
});

test('a spent approval lets exactly that action through', async () => {
  // The other half, so the guard cannot pass the test above by refusing
  // everything for ever.
  const { app, ran } = await buildApp({
    approvals: {
      findFirst: async () => ({
        id: 'op-approval-1',
        approvedAt: new Date(Date.now() - 1000),
        consumedAt: null,
        expiresAt: new Date(Date.now() + 300_000),
        sessionFamilyId: '11111111-1111-4111-8111-111111111111',
      }),
      updateMany: async () => ({ count: 1 }),
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
      headers: { 'x-charitypilot-approval': 'op-approval-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(ran(), true);
  } finally {
    await app.close();
  }
});

test('an approval belonging to another session family is refused', async () => {
  const { app, ran } = await buildApp({
    approvals: {
      findFirst: async () => ({
        id: 'op-approval-1',
        approvedAt: new Date(Date.now() - 1000),
        consumedAt: null,
        expiresAt: new Date(Date.now() + 300_000),
        // Approved, unspent, unexpired — and somebody else's.
        sessionFamilyId: '22222222-2222-4222-8222-222222222222',
      }),
      updateMany: async () => ({ count: 1 }),
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
      headers: { 'x-charitypilot-approval': 'op-approval-1' },
    });

    assert.equal(response.statusCode, 428);
    assert.equal(ran(), false, 'a second connector must not spend the first one’s approval');
  } finally {
    await app.close();
  }
});

test('an approval that loses the single-spend race does not let the action through', async () => {
  const { app, ran } = await buildApp({
    approvals: {
      findFirst: async () => ({
        id: 'op-approval-1',
        approvedAt: new Date(Date.now() - 1000),
        consumedAt: null,
        expiresAt: new Date(Date.now() + 300_000),
        sessionFamilyId: '11111111-1111-4111-8111-111111111111',
      }),
      // The row looked usable and the conditional update found nothing to
      // spend, which is what the loser of a race sees.
      updateMany: async () => ({ count: 0 }),
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
      headers: { 'x-charitypilot-approval': 'op-approval-1' },
    });

    assert.equal(ran(), false, 'an approval may be spent once, and losing the race is not spending it');
    assert.equal(response.statusCode, 428);
  } finally {
    await app.close();
  }
});

test('the console is not asked for an approval at all', async () => {
  const { app, ran } = await buildApp({ clientKind: 'WEB' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(ran(), true, 'a person at a keyboard is already looking at the screen');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// The access level guard
// ---------------------------------------------------------------------------

test('a read-level operator session cannot close a charity', async () => {
  const { app, ran } = await buildApp({ accessLevel: 'READ' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'OPERATOR_SESSION_LEVEL_TOO_LOW');
    assert.equal(ran(), false);
  } finally {
    await app.close();
  }
});

test('a write-level operator session cannot close a charity either', async () => {
  // The destructive floor is ADMIN, not WRITE. Pinned so that lowering it is
  // a deliberate act rather than a plausible-looking edit.
  const { app, ran } = await buildApp({ accessLevel: 'WRITE' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(ran(), false);
  } finally {
    await app.close();
  }
});

test('the level guard runs before the approval guard, so a read session is never offered one', async () => {
  // Order matters for what a refused caller learns. A READ session that got a
  // 428 would be told to go and approve an action its level can never perform.
  const { app } = await buildApp({ accessLevel: 'READ' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/tenant-1/lifecycle',
      payload: { action: 'CLOSE', reason: 'test', expectedLifecycleVersion: 1 },
    });

    assert.equal(response.json().code, 'OPERATOR_SESSION_LEVEL_TOO_LOW');
    assert.equal(response.json().approvalId, undefined);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// The summary, which is what a person actually reads before typing a password
// ---------------------------------------------------------------------------

test('closing a charity is summarised in words, not as a route pattern', () => {
  const summary = summariseOperatorAction(
    'POST',
    '/api/v1/owner/tenants/:id/lifecycle',
    'Bright Futures',
    { action: 'CLOSE' },
  );

  assert.match(summary, /CLOSE/);
  assert.match(summary, /Bright Futures/);
  assert.match(summary, /ends its access/);
  assert.equal(
    summary.includes(':id'),
    false,
    'a person approving the end of a charity should not have to decode a route pattern',
  );
});

test('suspending and reactivating are distinguishable from closing', () => {
  const suspend = summariseOperatorAction('POST', '/tenants/:id/lifecycle', 'A', { action: 'SUSPEND' });
  const close = summariseOperatorAction('POST', '/tenants/:id/lifecycle', 'A', { action: 'CLOSE' });

  assert.match(suspend, /Suspend/);
  assert.equal(suspend.includes('ends its access'), false);
  assert.notEqual(suspend, close);
});

test('the summary never takes the action from anything but the body the API parsed', () => {
  // The action IS read from the body, because it is what the route will act
  // on. What must never happen is a caller-supplied summary: there is no
  // parameter here that lets one in.
  const summary = summariseOperatorAction('PATCH', '/tenants/:id/configuration', 'A', {
    summary: 'Something harmless',
    action: 'CLOSE',
  });

  assert.equal(summary.includes('Something harmless'), false);
  assert.match(summary, /configuration/);
});

// ---------------------------------------------------------------------------
// The realms do not mix
// ---------------------------------------------------------------------------

test('an operator console cookie is browser evidence and is refused on connector routes', () => {
  for (const cookie of [OWNER_ACCESS_TOKEN_COOKIE, OWNER_REFRESH_TOKEN_COOKIE]) {
    const verdict = assertNonBrowserClient({
      headers: { 'x-charitypilot-client': 'mcp-connector/0.1.0' },
      cookies: { [cookie]: 'whatever' },
    } as never);

    assert.equal(verdict.ok, false, `${cookie} must count as browser evidence`);
    assert.equal(
      verdict.ok === false && verdict.payload.code,
      'BROWSER_CLIENT_REJECTED',
    );
  }
});

test('a connector with no cookies and the right client header is allowed', () => {
  const verdict = assertNonBrowserClient({
    headers: { 'x-charitypilot-client': 'mcp-connector/0.1.0' },
    cookies: {},
  } as never);

  assert.equal(verdict.ok, true, 'the check must still admit the client it exists for');
});
