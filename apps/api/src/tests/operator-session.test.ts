import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-operator-session-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-operator-session-test';

const [{ issueOperatorSession, rotateOperatorSession, revokeOperatorSession, hashOperatorToken }] =
  await Promise.all([import('../services/operator-session.service.js')]);

interface StoredSession {
  id: string;
  operatorId: string;
  tokenHash: string;
  revokedAt: Date | null;
  expiresAt: Date;
  clientKind: string;
  accessLevel: string;
  familyId: string;
  familyCreatedAt: Date;
}

function sessionStore() {
  const rows: Record<string, StoredSession> = {};
  let n = 0;
  return {
    rows,
    prisma: {
      platformOperatorSession: {
        // Stores whatever it is given, rather than a hand-picked four fields.
        // A stub that silently drops a column reports a rotation as broken
        // when the column is added, and — worse the other way round — would
        // let a rotation that dropped the posture look like it worked.
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const id = `sess-${++n}`;
          rows[id] = {
            id,
            revokedAt: null,
            clientKind: 'WEB',
            accessLevel: 'ADMIN',
            familyId: `fam-${n}`,
            familyCreatedAt: new Date('2026-09-20T00:00:00.000Z'),
            ...(data as object),
          } as StoredSession;
          return rows[id];
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          return (
            Object.values(rows).find((r) => {
              if (where.tokenHash && r.tokenHash !== (where.tokenHash as string)) return false;
              if (where.revokedAt === null && r.revokedAt !== null) return false;
              const expiresAtGt = (where.expiresAt as Record<string, Date> | undefined)?.gt;
              if (expiresAtGt && r.expiresAt <= expiresAtGt) return false;
              return true;
            }) ?? null
          );
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          Object.values(rows).forEach((r) => {
            if (where.tokenHash && r.tokenHash !== (where.tokenHash as string)) return;
            if (where.revokedAt === null && r.revokedAt !== null) return;
            const expiresAtGt = (where.expiresAt as Record<string, Date> | undefined)?.gt;
            if (expiresAtGt && r.expiresAt <= expiresAtGt) return;
            Object.assign(r, data);
            count++;
          });
          return { count };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(rows[where.id], data);
          return rows[where.id];
        },
      },
    } as never,
  };
}

test('issuing a session stores only the hash of the refresh token', async () => {
  const { prisma, rows } = sessionStore();
  const tokens = await issueOperatorSession(prisma, 'op-1');

  assert.ok(tokens.accessToken.length > 0);
  assert.ok(tokens.refreshToken.length > 0);
  const stored = Object.values(rows)[0];
  assert.equal(stored.tokenHash, hashOperatorToken(tokens.refreshToken));
  assert.notEqual(stored.tokenHash, tokens.refreshToken, 'the raw refresh token must never be stored');
});

test('rotating a session revokes the old refresh token', async () => {
  const { prisma, rows } = sessionStore();
  const first = await issueOperatorSession(prisma, 'op-1');
  const second = await rotateOperatorSession(prisma, first.refreshToken);

  assert.notEqual(second.refreshToken, first.refreshToken);
  const old = Object.values(rows).find((r) => r.tokenHash === hashOperatorToken(first.refreshToken));
  assert.ok(old?.revokedAt instanceof Date, 'the rotated token must be revoked');
});

test('a revoked refresh token cannot be rotated again', async () => {
  const { prisma } = sessionStore();
  const first = await issueOperatorSession(prisma, 'op-1');
  await rotateOperatorSession(prisma, first.refreshToken);

  await assert.rejects(
    () => rotateOperatorSession(prisma, first.refreshToken),
    (err: unknown) => err instanceof Error && err.message === 'Invalid or expired session',
  );
});

test('logging out revokes the session', async () => {
  const { prisma, rows } = sessionStore();
  const tokens = await issueOperatorSession(prisma, 'op-1');
  await revokeOperatorSession(prisma, tokens.refreshToken);

  const row = Object.values(rows)[0];
  assert.ok(row.revokedAt instanceof Date);
});

test('revoking an unknown token is a no-op rather than an error', async () => {
  const { prisma } = sessionStore();
  await assert.doesNotReject(() => revokeOperatorSession(prisma, 'not-a-real-token'));
});

test('an expired but not revoked refresh token cannot be rotated', async () => {
  const { prisma, rows } = sessionStore();
  const tokens = await issueOperatorSession(prisma, 'op-1');

  const stored = Object.values(rows)[0];
  stored.expiresAt = new Date(Date.now() - 1000); // expire it

  const initialRowCount = Object.keys(rows).length;
  await assert.rejects(
    () => rotateOperatorSession(prisma, tokens.refreshToken),
    (err: unknown) => err instanceof Error && err.message === 'Invalid or expired session',
  );
  assert.equal(Object.keys(rows).length, initialRowCount, 'no new session should be created');
});

// ---------------------------------------------------------------------------
// Posture, added with the operator connector realm
// ---------------------------------------------------------------------------

test('a rotation carries the posture and the family forward', async () => {
  // Not an optimisation. guard_platform_operator_session pins a family to one
  // posture, so a rotation that dropped it would fail the insert against a
  // real database. Here it would silently return a session with more
  // authority than the one it replaced, which is the outcome worth pinning.
  const { prisma, rows } = sessionStore();
  const first = await issueOperatorSession(prisma, 'op-1', {
    clientKind: 'MCP_CONNECTOR',
    accessLevel: 'READ',
  });

  const second = await rotateOperatorSession(prisma, first.refreshToken, 'MCP_CONNECTOR');

  const successor = Object.values(rows).find(
    (row) => row.tokenHash === hashOperatorToken(second.refreshToken),
  );
  const original = Object.values(rows).find(
    (row) => row.tokenHash === hashOperatorToken(first.refreshToken),
  );

  assert.equal(successor?.accessLevel, 'READ', 'a read session must not come back as admin');
  assert.equal(successor?.clientKind, 'MCP_CONNECTOR');
  assert.equal(successor?.familyId, original?.familyId, 'the family must survive rotation');
  assert.deepEqual(successor?.familyCreatedAt, original?.familyCreatedAt);
});

test('a console refresh token cannot be rotated on the connector route', async () => {
  // What makes a stolen console credential useless to the connector. The
  // refusal is the same opaque one an unknown token gets, so the attempt
  // learns nothing about which half was wrong.
  const { prisma } = sessionStore();
  const console_ = await issueOperatorSession(prisma, 'op-1');

  await assert.rejects(
    () => rotateOperatorSession(prisma, console_.refreshToken, 'MCP_CONNECTOR'),
    /Invalid or expired session/,
  );
});

test('a connector refresh token cannot be rotated on the console route', async () => {
  const { prisma } = sessionStore();
  const connector = await issueOperatorSession(prisma, 'op-1', {
    clientKind: 'MCP_CONNECTOR',
    accessLevel: 'ADMIN',
  });

  await assert.rejects(
    () => rotateOperatorSession(prisma, connector.refreshToken, 'WEB'),
    /Invalid or expired session/,
  );
});

test('defaulting the posture gives a web session with full authority, as before', async () => {
  const { prisma, rows } = sessionStore();
  await issueOperatorSession(prisma, 'op-1');

  const stored = Object.values(rows)[0];
  assert.equal(stored?.clientKind, 'WEB');
  assert.equal(stored?.accessLevel, 'ADMIN');
});
