import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'session-posture-test-secret-value-32-chars';
process.env.NODE_ENV ??= 'test';

const {
  issueSessionTokensInTransaction,
  rotateSessionTokens,
} = await import('../services/session-tokens.js');

type Row = Record<string, unknown>;

const ACTIVE_USER = {
  id: 'usr-1',
  organisationId: 'org-1',
  role: 'OWNER' as const,
  passwordHash: 'hash',
  userLifecycleStatus: 'ACTIVE',
  organisationLifecycleStatus: 'ACTIVE',
};

/**
 * A stand-in for the transaction client. It records what the service asks the
 * database to write, which is the only thing these tests are about: whether
 * the posture reaches the row.
 */
function fakeTx(options: { familyRows?: Row[] } = {}) {
  const created: Row[] = [];
  const updated: Row[] = [];
  return {
    created,
    updated,
    client: {
      $queryRaw: async () => options.familyRows ?? [ACTIVE_USER],
      authSession: {
        create: async ({ data }: { data: Row }) => {
          created.push(data);
          return { id: `sess-${created.length}` };
        },
        update: async ({ data }: { data: Row }) => {
          updated.push(data);
          return { id: 'sess-updated' };
        },
        updateMany: async ({ data }: { data: Row }) => {
          updated.push(data);
          return { count: 1 };
        },
      },
    },
  };
}

test('issuance defaults to a full-authority web session, so nothing about the web changes', async () => {
  const tx = fakeTx();
  await issueSessionTokensInTransaction(tx.client as never, {
    id: ACTIVE_USER.id,
    organisationId: ACTIVE_USER.organisationId,
    role: ACTIVE_USER.role,
  });

  assert.equal(tx.created.length, 1);
  assert.equal(tx.created[0]!.clientKind, 'WEB');
  assert.equal(tx.created[0]!.accessLevel, 'ADMIN');
});

test('an explicit posture is written as given', async () => {
  const tx = fakeTx();
  await issueSessionTokensInTransaction(
    tx.client as never,
    { id: ACTIVE_USER.id, organisationId: ACTIVE_USER.organisationId, role: ACTIVE_USER.role },
    { clientKind: 'MCP_CONNECTOR', accessLevel: 'READ' },
  );

  assert.equal(tx.created[0]!.clientKind, 'MCP_CONNECTOR');
  assert.equal(tx.created[0]!.accessLevel, 'READ');
});

function rotatingPrisma(familyRow: Row) {
  const tx = fakeTx({ familyRows: [familyRow] });
  const prisma = {
    // The locator read, then the family lock inside the transaction.
    $queryRaw: async () => [{ id: familyRow.sessionId, userId: familyRow.id, familyId: familyRow.familyId }],
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
      const inner = {
        ...tx.client,
        $queryRaw: async () => [familyRow],
      };
      return fn(inner);
    },
  };
  return { prisma, tx };
}

function connectorFamilyRow(overrides: Row = {}): Row {
  return {
    ...ACTIVE_USER,
    sessionId: 'sess-old',
    refreshTokenHash: '',
    familyId: '11111111-1111-4111-8111-111111111111',
    familyCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    deviceLabel: 'Jasper laptop',
    clientKind: 'MCP_CONNECTOR',
    accessLevel: 'READ',
    ...overrides,
  };
}

test('rotation carries the posture into the successor session', async () => {
  const { prisma, tx } = rotatingPrisma(connectorFamilyRow());
  // The locator hash must match the family row's, so compute it the same way.
  const { hashOpaqueToken } = await import('../services/session-tokens.js');
  const token = 'a-refresh-token';
  const row = connectorFamilyRow({ refreshTokenHash: hashOpaqueToken(token) });
  const rotating = rotatingPrisma(row);

  await rotateSessionTokens(rotating.prisma as never, token);

  const successor = rotating.tx.created.at(-1)!;
  assert.equal(successor.clientKind, 'MCP_CONNECTOR', 'a rotated session must not widen');
  assert.equal(successor.accessLevel, 'READ');
  assert.equal(
    successor.deviceLabel,
    'Jasper laptop',
    'the device label was being lost on every refresh; it is carried now too',
  );
  assert.equal(successor.familyId, row.familyId, 'the family is unchanged');
  void prisma;
  void tx;
});

test('a refresh token minted for one channel cannot be spent on another', async () => {
  const { hashOpaqueToken } = await import('../services/session-tokens.js');
  const token = 'a-connector-token';
  const row = connectorFamilyRow({ refreshTokenHash: hashOpaqueToken(token) });
  const { prisma, tx } = rotatingPrisma(row);

  await assert.rejects(
    () => rotateSessionTokens(prisma as never, token, 'WEB'),
    /refresh token/i,
    'a connector token presented on the web channel must be refused',
  );
  assert.equal(tx.created.length, 0, 'no successor may be minted');
});

test('rotation without an expected channel is unchanged, so the web path still works', async () => {
  const { hashOpaqueToken } = await import('../services/session-tokens.js');
  const token = 'a-web-token';
  const row = connectorFamilyRow({
    refreshTokenHash: hashOpaqueToken(token),
    clientKind: 'WEB',
    accessLevel: 'ADMIN',
  });
  const { prisma, tx } = rotatingPrisma(row);

  await rotateSessionTokens(prisma as never, token);
  assert.equal(tx.created.length, 1);
  assert.equal(tx.created[0]!.clientKind, 'WEB');
  assert.equal(tx.created[0]!.accessLevel, 'ADMIN');
});

/* --- enforcement: what a narrowed session may actually do ---------------- */

const { requireSessionLevel } = await import('../middleware/session-level.js');

function fakeReply() {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: Record<string, unknown>) {
      sent.body = body;
      return reply;
    },
  };
  return { reply, sent };
}

function requestAt(accessLevel: 'READ' | 'WRITE' | 'ADMIN') {
  return { authSession: { id: 's1', clientKind: 'MCP_CONNECTOR' as const, accessLevel } };
}

test('an admin-level action refuses a write-level session, naming the level', async () => {
  const guard = requireSessionLevel('ADMIN');
  const { reply, sent } = fakeReply();

  await guard(requestAt('WRITE') as never, reply as never);

  assert.equal(sent.status, 403);
  assert.equal(sent.body?.code, 'SESSION_LEVEL_TOO_LOW');
  assert.match(String(sent.body?.error), /administrator access/i);
  assert.doesNotMatch(String(sent.body?.error), /\n\s+at /, 'no stack trace');
});

test('an admin-level action allows an admin-level session', async () => {
  const guard = requireSessionLevel('ADMIN');
  const { reply, sent } = fakeReply();

  await guard(requestAt('ADMIN') as never, reply as never);

  assert.equal(sent.status, undefined, 'nothing is sent, so the route runs');
});

test('a write-level action refuses a read-only session but allows write and admin', async () => {
  const guard = requireSessionLevel('WRITE');

  const readOnly = fakeReply();
  await guard(requestAt('READ') as never, readOnly.reply as never);
  assert.equal(readOnly.sent.status, 403);

  for (const level of ['WRITE', 'ADMIN'] as const) {
    const allowed = fakeReply();
    await guard(requestAt(level) as never, allowed.reply as never);
    assert.equal(allowed.sent.status, undefined, `${level} must be allowed`);
  }
});

test('a request with no posture is treated as full authority, so the web is unaffected', async () => {
  const guard = requireSessionLevel('ADMIN');
  const { reply, sent } = fakeReply();

  await guard({} as never, reply as never);

  assert.equal(sent.status, undefined);
});
