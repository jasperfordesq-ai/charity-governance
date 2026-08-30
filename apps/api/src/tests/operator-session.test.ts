import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-operator-session-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-operator-session-test';

const [{ issueOperatorSession, rotateOperatorSession, revokeOperatorSession, hashOperatorToken }] =
  await Promise.all([import('../services/operator-session.service.js')]);

function sessionStore() {
  const rows: Record<string, { id: string; operatorId: string; tokenHash: string; revokedAt: Date | null; expiresAt: Date }> = {};
  let n = 0;
  return {
    rows,
    prisma: {
      platformOperatorSession: {
        create: async ({ data }: { data: { operatorId: string; tokenHash: string; expiresAt: Date } }) => {
          const id = `sess-${++n}`;
          rows[id] = { id, operatorId: data.operatorId, tokenHash: data.tokenHash, revokedAt: null, expiresAt: data.expiresAt };
          return rows[id];
        },
        findFirst: async ({ where }: { where: { tokenHash: string } }) =>
          Object.values(rows).find(
            (r) => r.tokenHash === where.tokenHash && r.revokedAt === null && r.expiresAt > new Date(),
          ) ?? null,
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

  await assert.rejects(() => rotateOperatorSession(prisma, first.refreshToken), /INVALID_OPERATOR_REFRESH/);
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
