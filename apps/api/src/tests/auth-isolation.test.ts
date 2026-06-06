import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-with-enough-entropy';
process.env.JWT_EXPIRY = '1h';

function createReply() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

function conflictData(boardMemberId?: string | null) {
  return {
    boardMemberId,
    trusteeName: 'Trustee One',
    matter: 'Supplier contract',
    nature: 'Trustee has a potential connection to a supplier.',
    dateDeclared: '2026-05-01',
    actionTaken: 'Trustee left the room while the board discussed the contract.',
  };
}

test('authGuard uses current database role and organisation instead of stale JWT claims', async () => {
  const { authGuard } = await import('../middleware/auth.js');
  const { signAccessToken } = await import('../utils/jwt.js');

  const token = signAccessToken({
    userId: 'user-1',
    organisationId: 'old-org',
    role: 'ADMIN',
    sessionId: 'session-1',
  } as never);

  const request = {
    headers: { authorization: `Bearer ${token}` },
    server: {
      prisma: {
        authSession: {
          findFirst: async (query: { where: { id: string; userId: string } }) => {
            assert.equal(query.where.id, 'session-1');
            assert.equal(query.where.userId, 'user-1');
            return { id: 'session-1' };
          },
        },
        user: {
          findUnique: async (query: { where: { id: string } }) => {
            assert.equal(query.where.id, 'user-1');
            return { id: 'user-1', organisationId: 'current-org', role: 'MEMBER' };
          },
        },
      },
    },
  };
  const reply = createReply();

  await authGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload, undefined);
  assert.deepEqual((request as { user?: unknown }).user, {
    userId: 'user-1',
    organisationId: 'current-org',
    role: 'MEMBER',
    sessionId: 'session-1',
  });
});

test('authGuard rejects access tokens whose backing session has been revoked', async () => {
  const { authGuard } = await import('../middleware/auth.js');
  const { signAccessToken } = await import('../utils/jwt.js');

  const token = signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'revoked-session',
  } as never);

  const request = {
    headers: { authorization: `Bearer ${token}` },
    server: {
      prisma: {
        authSession: {
          findFirst: async () => null,
        },
        user: {
          findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'OWNER' }),
        },
      },
    },
  };
  const reply = createReply();

  await authGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 401);
  assert.deepEqual(reply.payload, { error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  assert.equal((request as { user?: unknown }).user, undefined);
});

test('non-owner admins may invite members but not new admins', async () => {
  const { TeamService } = await import('../services/team.service.js');
  const { AppError } = await import('../utils/errors.js');
  const createdRoles: string[] = [];
  const prisma = {
    organisation: { findUnique: async () => ({ id: 'org-1', name: 'Org One' }) },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) =>
        query.where.id ? { id: query.where.id, name: 'Inviting Admin', organisationId: 'org-1' } : null,
    },
    teamInvite: {
      findFirst: async () => null,
      create: async ({ data }: { data: { email: string; role: string; expiresAt: Date } }) => {
        createdRoles.push(data.role);
        return {
          id: `invite-${createdRoles.length}`,
          email: data.email,
          role: data.role,
          invitedBy: { name: 'Inviting Admin' },
          acceptedAt: null,
          revokedAt: null,
          expiresAt: data.expiresAt,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        };
      },
    },
  };
  const emailService = { sendTeamInvite: async () => true };
  const service = new TeamService(prisma as never, emailService as never);

  const memberInvite = await service.invite('org-1', 'admin-1', 'ADMIN', {
    email: 'member@example.org',
    role: 'MEMBER',
  });
  assert.equal(memberInvite.role, 'MEMBER');

  await assert.rejects(
    () =>
      service.invite('org-1', 'admin-1', 'ADMIN', {
        email: 'admin@example.org',
        role: 'ADMIN',
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403 && error.code === 'FORBIDDEN',
  );
  assert.deepEqual(createdRoles, ['MEMBER']);
});

test('owners may invite admins', async () => {
  const { TeamService } = await import('../services/team.service.js');
  const prisma = {
    organisation: { findUnique: async () => ({ id: 'org-1', name: 'Org One' }) },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) =>
        query.where.id ? { id: query.where.id, name: 'Owner', organisationId: 'org-1' } : null,
    },
    teamInvite: {
      findFirst: async () => null,
      create: async ({ data }: { data: { email: string; role: string; expiresAt: Date } }) => ({
        id: 'invite-1',
        email: data.email,
        role: data.role,
        invitedBy: { name: 'Owner' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: data.expiresAt,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    },
  };
  const emailService = { sendTeamInvite: async () => true };
  const service = new TeamService(prisma as never, emailService as never);

  const invite = await service.invite('org-1', 'owner-1', 'OWNER', {
    email: 'admin@example.org',
    role: 'ADMIN',
  });

  assert.equal(invite.role, 'ADMIN');
});

test('conflict records reject board members from another organisation on create', async () => {
  const { GovernanceRegisterService } = await import('../services/governance-register.service.js');
  const { AppError } = await import('../utils/errors.js');
  let createCalled = false;
  const prisma = {
    boardMember: {
      findFirst: async (query: { where: { id: string; organisationId: string } }) => {
        assert.deepEqual(query.where, { id: 'board-other-org', organisationId: 'org-1' });
        return null;
      },
    },
    conflictRecord: {
      create: async () => {
        createCalled = true;
        return {};
      },
    },
  };
  const service = new GovernanceRegisterService(prisma as never);

  await assert.rejects(
    () => service.createConflict('org-1', conflictData('board-other-org')),
    (error: unknown) => error instanceof AppError && error.statusCode === 404 && error.code === 'BOARD_MEMBER_NOT_FOUND',
  );
  assert.equal(createCalled, false);
});

test('conflict records reject board members from another organisation on update', async () => {
  const { GovernanceRegisterService } = await import('../services/governance-register.service.js');
  const { AppError } = await import('../utils/errors.js');
  let updateCalled = false;
  const prisma = {
    boardMember: {
      findFirst: async (query: { where: { id: string; organisationId: string } }) => {
        assert.deepEqual(query.where, { id: 'board-other-org', organisationId: 'org-1' });
        return null;
      },
    },
    conflictRecord: {
      findFirst: async () => ({ id: 'conflict-1', organisationId: 'org-1' }),
      update: async () => {
        updateCalled = true;
        return {};
      },
    },
  };
  const service = new GovernanceRegisterService(prisma as never);

  await assert.rejects(
    () => service.updateConflict('org-1', 'conflict-1', { boardMemberId: 'board-other-org' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404 && error.code === 'BOARD_MEMBER_NOT_FOUND',
  );
  assert.equal(updateCalled, false);
});

test('refresh token rotation fails without creating a replacement session when revoke loses the race', async () => {
  const { rotateSessionTokens } = await import('../services/session-tokens.js');
  const { AppError } = await import('../utils/errors.js');
  const createdSessions: string[] = [];
  let rawExecuteCount = 0;
  const future = new Date(Date.now() + 60_000);
  const tx = {
    authSession: {
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { refreshTokenHash: string } }) => {
        createdSessions.push(data.refreshTokenHash);
        return {};
      },
    },
  };
  const prisma = {
    $queryRaw: async () => [{ id: 'session-1', userId: 'user-1', expiresAt: future, revokedAt: null }],
    $executeRaw: async () => {
      rawExecuteCount += 1;
      if (rawExecuteCount === 2) {
        createdSessions.push('raw-insert');
      }
      return rawExecuteCount === 1 ? 0 : 1;
    },
    $transaction: async (operation: unknown) =>
      typeof operation === 'function' ? operation(tx) : Promise.all(operation as Promise<unknown>[]),
    user: {
      findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'OWNER' }),
    },
  };

  await assert.rejects(
    () => rotateSessionTokens(prisma as never, 'old-refresh-token'),
    (error: unknown) => error instanceof AppError && error.statusCode === 401 && error.code === 'INVALID_REFRESH_TOKEN',
  );
  assert.deepEqual(createdSessions, []);
});
