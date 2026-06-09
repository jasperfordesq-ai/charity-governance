import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-with-enough-entropy';
process.env.JWT_EXPIRY = '1h';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_auth_isolation_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const REGISTRATION_ACCEPTED_MESSAGE = 'If this registration can be completed, check your email for next steps.';
const TEAM_INVITE_ACCEPTED_MESSAGE = 'If the invite can be sent, we will email the recipient.';

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
            return { id: 'user-1', organisationId: 'current-org', role: 'MEMBER', emailVerified: true };
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

test('authGuard rejects valid sessions for users whose email is not verified', async () => {
  const { authGuard } = await import('../middleware/auth.js');
  const { signAccessToken } = await import('../utils/jwt.js');

  const token = signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  } as never);

  const request = {
    headers: { authorization: `Bearer ${token}` },
    server: {
      prisma: {
        authSession: {
          findFirst: async () => ({ id: 'session-1' }),
        },
        user: {
          findUnique: async () => ({
            id: 'user-1',
            organisationId: 'org-1',
            role: 'OWNER',
            emailVerified: false,
          }),
        },
      },
    },
  };
  const reply = createReply();

  await authGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 403);
  assert.deepEqual(reply.payload, {
    error: 'Please verify your email before continuing',
    code: 'EMAIL_NOT_VERIFIED',
  });
  assert.equal((request as { user?: unknown }).user, undefined);
});

test('authIdentityGuard allows valid sessions for users whose email is not verified', async () => {
  const { authIdentityGuard } = await import('../middleware/auth.js');
  const { signAccessToken } = await import('../utils/jwt.js');

  const token = signAccessToken({
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  } as never);

  const request = {
    headers: { authorization: `Bearer ${token}` },
    server: {
      prisma: {
        authSession: {
          findFirst: async () => ({ id: 'session-1' }),
        },
        user: {
          findUnique: async () => ({
            id: 'user-1',
            organisationId: 'org-1',
            role: 'OWNER',
            emailVerified: false,
          }),
        },
      },
    },
  };
  const reply = createReply();

  await authIdentityGuard(request as never, reply as never);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload, undefined);
  assert.deepEqual((request as { user?: unknown }).user, {
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  });
});

test('access tokens are signed and verified with the pinned HS256 algorithm', async () => {
  const { default: jwt } = await import('jsonwebtoken');
  const { signAccessToken, verifyAccessToken } = await import('../utils/jwt.js');

  const payload = {
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  } as const;
  const token = signAccessToken(payload);

  assert.equal(jwt.decode(token, { complete: true })?.header.alg, 'HS256');
  assert.deepEqual(verifyAccessToken(token), payload);

  const hs384Token = jwt.sign(payload, process.env.JWT_SECRET as string, {
    algorithm: 'HS384',
    expiresIn: '1h',
  });

  assert.throws(() => verifyAccessToken(hs384Token), /invalid algorithm/);
});

test('access tokens are bound to the CharityPilot issuer and API audience', async () => {
  const { default: jwt } = await import('jsonwebtoken');
  const { signAccessToken, verifyAccessToken } = await import('../utils/jwt.js');

  const payload = {
    userId: 'user-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 'session-1',
  } as const;
  const token = signAccessToken(payload);
  const decoded = jwt.decode(token, { complete: true });
  const decodedPayload = decoded?.payload && typeof decoded.payload === 'object'
    ? decoded.payload
    : {};

  assert.equal(decodedPayload.iss, 'charitypilot-api');
  assert.equal(decodedPayload.aud, 'charitypilot-web');
  assert.deepEqual(verifyAccessToken(token), payload);

  const wrongAudienceToken = jwt.sign(payload, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '1h',
    issuer: 'charitypilot-api',
    audience: 'attacker-client',
  });
  const missingIssuerToken = jwt.sign(payload, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '1h',
    audience: 'charitypilot-web',
  });

  assert.throws(() => verifyAccessToken(wrongAudienceToken));
  assert.throws(() => verifyAccessToken(missingIssuerToken));
});

test('resendEmailVerification rotates the token and emails unverified users', async () => {
  const { AuthService } = await import('../services/auth.service.js');

  let updateData: { verifyToken?: string; verifyTokenExpiry?: Date } | undefined;
  const sentMessages: Array<{ email: string; name: string; token: string }> = [];
  const prisma = {
    user: {
      findUnique: async (query: { where: { id: string } }) => {
        assert.equal(query.where.id, 'user-1');
        return {
          id: 'user-1',
          email: 'owner@example.org',
          name: 'Owner One',
          emailVerified: false,
        };
      },
      update: async ({ data }: { data: { verifyToken: string; verifyTokenExpiry: Date } }) => {
        updateData = data;
        return {};
      },
    },
  };
  const emailService = {
    sendEmailVerification: async (email: string, name: string, token: string) => {
      sentMessages.push({ email, name, token });
      return true;
    },
  };
  const service = new AuthService(prisma as never, emailService as never);

  const result = await (service as unknown as {
    resendEmailVerification(userId: string): Promise<{ message: string }>;
  }).resendEmailVerification('user-1');

  assert.deepEqual(result, { message: 'Verification email sent.' });
  assert.match(updateData?.verifyToken ?? '', /^[a-f0-9]{64}$/);
  assert.ok(updateData?.verifyTokenExpiry instanceof Date);
  assert.ok(updateData.verifyTokenExpiry.getTime() > Date.now());
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].email, 'owner@example.org');
  assert.equal(sentMessages[0].name, 'Owner One');
  assert.ok(sentMessages[0].token.length >= 32);
});

test('resendEmailVerification does not issue a new token for verified users', async () => {
  const { AuthService } = await import('../services/auth.service.js');

  let updateCalled = false;
  let emailCalled = false;
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'owner@example.org',
        name: 'Owner One',
        emailVerified: true,
      }),
      update: async () => {
        updateCalled = true;
      },
    },
  };
  const emailService = {
    sendEmailVerification: async () => {
      emailCalled = true;
    },
  };
  const service = new AuthService(prisma as never, emailService as never);

  const result = await (service as unknown as {
    resendEmailVerification(userId: string): Promise<{ message: string }>;
  }).resendEmailVerification('user-1');

  assert.deepEqual(result, { message: 'Email is already verified.' });
  assert.equal(updateCalled, false);
  assert.equal(emailCalled, false);
});

test('register route does not disclose duplicate emails or issue session cookies', async () => {
  const [{ default: Fastify }, { authRoutes }] = await Promise.all([
    import('fastify'),
    import('../routes/auth/index.js'),
  ]);

  let transactionCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    user: {
      findUnique: async (query: { where: { email: string } }) => {
        assert.equal(query.where.email, 'owner@example.org');
        return { id: 'existing-user' };
      },
    },
    $transaction: async () => {
      transactionCalled = true;
    },
  } as never);
  await app.register(authRoutes, { prefix: '/auth' });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'Owner@Example.Org',
        password: 'NewPassword1',
        name: 'Owner One',
        organisationName: 'Org One',
      },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { message: REGISTRATION_ACCEPTED_MESSAGE });
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(transactionCalled, false);
  } finally {
    await app.close();
  }
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
      updateMany: async () => ({ count: 0 }),
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
  assert.deepEqual(memberInvite, { message: TEAM_INVITE_ACCEPTED_MESSAGE });

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
  const sentInvites: Array<{ email: string; role: string }> = [];
  const prisma = {
    organisation: { findUnique: async () => ({ id: 'org-1', name: 'Org One' }) },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) =>
        query.where.id ? { id: query.where.id, name: 'Owner', organisationId: 'org-1' } : null,
    },
    teamInvite: {
      updateMany: async () => ({ count: 0 }),
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
  const emailService = {
    sendTeamInvite: async (email: string, _orgName: string, _inviterName: string, _token: string, role: string) => {
      sentInvites.push({ email, role });
      return true;
    },
  };
  const service = new TeamService(prisma as never, emailService as never);

  const result = await service.invite('org-1', 'owner-1', 'OWNER', {
    email: 'admin@example.org',
    role: 'ADMIN',
  });

  assert.deepEqual(result, { message: TEAM_INVITE_ACCEPTED_MESSAGE });
  assert.deepEqual(sentInvites, [{ email: 'admin@example.org', role: 'ADMIN' }]);
});

test('team invite route returns an accepted response without exposing invite details', async () => {
  const [{ default: Fastify }, { teamRoutes }, { signAccessToken }] = await Promise.all([
    import('fastify'),
    import('../routes/team/index.js'),
    import('../utils/jwt.js'),
  ]);

  let createCalled = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: {
      findFirst: async () => ({ id: 'session-1' }),
    },
    subscription: {
      findUnique: async () => ({
        status: 'TRIALING',
        trialEndsAt: new Date(Date.now() + 60_000),
      }),
    },
    organisation: {
      findUnique: async () => ({ id: 'org-1', name: 'Org One' }),
    },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) =>
        query.where.id
          ? { id: 'user-1', organisationId: 'org-1', role: 'OWNER', emailVerified: true, name: 'Owner One' }
          : null,
    },
    teamInvite: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async ({ data }: { data: { email: string; role: string; expiresAt: Date } }) => {
        createCalled = true;
        return {
          id: 'invite-1',
          email: data.email,
          role: data.role,
          invitedBy: { name: 'Owner One' },
          acceptedAt: null,
          revokedAt: null,
          expiresAt: data.expiresAt,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        };
      },
    },
  } as never);
  await app.register(teamRoutes, { prefix: '/team' });

  try {
    const token = signAccessToken({
      userId: 'user-1',
      organisationId: 'org-1',
      role: 'OWNER',
      sessionId: 'session-1',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/team/invites',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'invitee@example.org', role: 'MEMBER' },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { message: TEAM_INVITE_ACCEPTED_MESSAGE });
    assert.equal(createCalled, true);
  } finally {
    await app.close();
  }
});

test('team invites do not disclose why an invite recipient is unavailable', async () => {
  const { TeamService } = await import('../services/team.service.js');

  const scenarios = [
    {
      name: 'same organisation member',
      existingUser: { id: 'member-1', organisationId: 'org-1' },
      existingInvite: null,
    },
    {
      name: 'another organisation user',
      existingUser: { id: 'member-2', organisationId: 'org-2' },
      existingInvite: null,
    },
    {
      name: 'active invite',
      existingUser: null,
      existingInvite: { id: 'invite-1' },
    },
  ];

  for (const scenario of scenarios) {
    let createCalled = false;
    let emailCalled = false;
    const prisma = {
      organisation: { findUnique: async () => ({ id: 'org-1', name: 'Org One' }) },
      user: {
        findUnique: async (query: { where: { id?: string; email?: string } }) =>
          query.where.id ? { id: query.where.id, name: 'Owner', organisationId: 'org-1' } : scenario.existingUser,
      },
      teamInvite: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => scenario.existingInvite,
        create: async ({ data }: { data: { email: string; role: string; expiresAt: Date } }) => {
          createCalled = true;
          return {
            id: 'invite-1',
            email: data.email,
            role: data.role,
            invitedBy: { name: 'Owner' },
            acceptedAt: null,
            revokedAt: null,
            expiresAt: data.expiresAt,
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
          };
        },
      },
    };
    const emailService = {
      sendTeamInvite: async () => {
        emailCalled = true;
        return true;
      },
    };
    const service = new TeamService(prisma as never, emailService as never);

    const result = await service.invite('org-1', 'owner-1', 'OWNER', {
      email: `${scenario.name.replace(/\s+/g, '-')}@example.org`,
      role: 'MEMBER',
    });

    assert.deepEqual(result, { message: TEAM_INVITE_ACCEPTED_MESSAGE });
    assert.equal(createCalled, scenario.existingInvite === null, scenario.name);
    assert.equal(emailCalled, false, scenario.name);
  }
});

test('team invites flatten database-enforced duplicate active invite races', async () => {
  const [{ TeamService }, { Prisma }] = await Promise.all([
    import('../services/team.service.js'),
    import('@prisma/client'),
  ]);

  let createCalled = false;
  let emailCalled = false;
  const uniqueError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'TeamInvite_active_email_unique' },
  });
  const prisma = {
    organisation: { findUnique: async () => ({ id: 'org-1', name: 'Org One' }) },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) =>
        query.where.id ? { id: query.where.id, name: 'Owner', organisationId: 'org-1' } : null,
    },
    teamInvite: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async () => {
        createCalled = true;
        throw uniqueError;
      },
    },
  };
  const emailService = {
    sendTeamInvite: async () => {
      emailCalled = true;
      return true;
    },
  };
  const service = new TeamService(prisma as never, emailService as never);

  const result = await service.invite('org-1', 'owner-1', 'OWNER', {
    email: 'invitee@example.org',
    role: 'MEMBER',
  });

  assert.deepEqual(result, { message: TEAM_INVITE_ACCEPTED_MESSAGE });
  assert.equal(createCalled, true);
  assert.equal(emailCalled, false);
});

test('acceptInvite consumes the invite atomically before issuing a session', async () => {
  const { TeamService } = await import('../services/team.service.js');
  const { hashOpaqueToken } = await import('../services/session-tokens.js');

  const future = new Date(Date.now() + 60_000);
  let inviteConsumed = false;
  const prisma = {
    teamInvite: {
      findUnique: async () => ({
        id: 'invite-1',
        token: hashOpaqueToken('invite-token'),
        email: 'invitee@example.org',
        role: 'MEMBER',
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Org One' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: future,
      }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; token: string; acceptedAt: null; revokedAt: null; expiresAt: { gt: Date } };
        data: { acceptedAt: Date };
      }) => {
        assert.equal(where.id, 'invite-1');
        assert.equal(where.token, hashOpaqueToken('invite-token'));
        assert.equal(where.acceptedAt, null);
        assert.equal(where.revokedAt, null);
        assert.ok(where.expiresAt.gt instanceof Date);
        assert.ok(data.acceptedAt instanceof Date);
        if (inviteConsumed) return { count: 0 };
        inviteConsumed = true;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => null,
      create: async () => ({
        id: 'user-1',
        email: 'invitee@example.org',
        name: 'Invitee',
        role: 'MEMBER',
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Org One' },
      }),
    },
    authSession: {
      create: async () => ({ id: 'session-1' }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new TeamService(prisma as never, {} as never);

  const result = await service.acceptInvite({
    token: 'invite-token',
    name: 'Invitee',
    password: 'NewPassword1',
  });

  assert.equal(result.user.id, 'user-1');
  assert.equal(inviteConsumed, true);
});

test('acceptInvite rejects invite reuse when another request already consumed it', async () => {
  const { TeamService } = await import('../services/team.service.js');
  const { AppError } = await import('../utils/errors.js');
  const { hashOpaqueToken } = await import('../services/session-tokens.js');

  let userCreated = false;
  const prisma = {
    teamInvite: {
      findUnique: async () => ({
        id: 'invite-1',
        token: hashOpaqueToken('invite-token'),
        email: 'invitee@example.org',
        role: 'MEMBER',
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Org One' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async () => ({ count: 0 }),
    },
    user: {
      findUnique: async () => null,
      create: async () => {
        userCreated = true;
        return {};
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new TeamService(prisma as never, {} as never);

  await assert.rejects(
    () =>
      service.acceptInvite({
        token: 'invite-token',
        name: 'Invitee',
        password: 'NewPassword1',
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'INVALID_INVITE',
  );

  assert.equal(userCreated, false);
});

test('acceptInvite does not disclose that the invite email already belongs to an account', async () => {
  const { TeamService } = await import('../services/team.service.js');
  const { AppError } = await import('../utils/errors.js');
  const { hashOpaqueToken } = await import('../services/session-tokens.js');

  let inviteConsumed = false;
  let userCreated = false;
  const prisma = {
    teamInvite: {
      findUnique: async () => ({
        id: 'invite-1',
        token: hashOpaqueToken('invite-token'),
        email: 'invitee@example.org',
        role: 'MEMBER',
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Org One' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async () => {
        inviteConsumed = true;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({ id: 'existing-user', email: 'invitee@example.org' }),
      create: async () => {
        userCreated = true;
        return {};
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new TeamService(prisma as never, {} as never);

  await assert.rejects(
    () =>
      service.acceptInvite({
        token: 'invite-token',
        name: 'Invitee',
        password: 'NewPassword1',
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 400 &&
      error.code === 'INVALID_INVITE' &&
      error.message === 'This invite is invalid or has expired',
  );

  assert.equal(inviteConsumed, false);
  assert.equal(userCreated, false);
});

test('acceptInvite maps raced user email uniqueness failures to invalid invite', async () => {
  const [{ TeamService }, { AppError }, { hashOpaqueToken }, { Prisma }] = await Promise.all([
    import('../services/team.service.js'),
    import('../utils/errors.js'),
    import('../services/session-tokens.js'),
    import('@prisma/client'),
  ]);

  let sessionCreated = false;
  const uniqueError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'User_email_key' },
  });
  const prisma = {
    teamInvite: {
      findUnique: async () => ({
        id: 'invite-1',
        token: hashOpaqueToken('invite-token'),
        email: 'invitee@example.org',
        role: 'MEMBER',
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Org One' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async () => ({ count: 1 }),
    },
    user: {
      findUnique: async () => null,
      create: async () => {
        throw uniqueError;
      },
    },
    authSession: {
      create: async () => {
        sessionCreated = true;
        return { id: 'session-1' };
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new TeamService(prisma as never, {} as never);

  await assert.rejects(
    () =>
      service.acceptInvite({
        token: 'invite-token',
        name: 'Invitee',
        password: 'NewPassword1',
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 400 &&
      error.code === 'INVALID_INVITE' &&
      error.message === 'This invite is invalid or has expired',
  );

  assert.equal(sessionCreated, false);
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

test('refresh token replay revokes active sessions for the affected user', async () => {
  const { rotateSessionTokens } = await import('../services/session-tokens.js');
  const { AppError } = await import('../utils/errors.js');
  let userSessionsRevoked = false;
  const future = new Date(Date.now() + 60_000);
  const prisma = {
    $queryRaw: async () => [{
      id: 'old-session',
      userId: 'user-1',
      expiresAt: future,
      revokedAt: new Date(Date.now() - 1000),
    }],
    $executeRaw: async () => {
      userSessionsRevoked = true;
      return 1;
    },
    user: {
      findUnique: async () => {
        throw new Error('user lookup should not run for replayed refresh tokens');
      },
    },
    authSession: {
      create: async () => {
        throw new Error('replacement session should not be created for replayed refresh tokens');
      },
    },
  };

  await assert.rejects(
    () => rotateSessionTokens(prisma as never, 'replayed-refresh-token'),
    (error: unknown) => error instanceof AppError && error.statusCode === 401 && error.code === 'INVALID_REFRESH_TOKEN',
  );
  assert.equal(userSessionsRevoked, true);
});

test('resetPassword consumes the reset token atomically before revoking sessions', async () => {
  const { AuthService } = await import('../services/auth.service.js');
  const { hashOpaqueToken } = await import('../services/session-tokens.js');

  let consumed = false;
  const sessionUpdates: unknown[] = [];
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1' }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; resetToken: string; resetTokenExpiry: { gt: Date } };
        data: { passwordHash: string; resetToken: null; resetTokenExpiry: null };
      }) => {
        assert.equal(where.id, 'user-1');
        assert.equal(where.resetToken, hashOpaqueToken('reset-token'));
        assert.ok(where.resetTokenExpiry.gt instanceof Date);
        assert.equal(typeof data.passwordHash, 'string');
        assert.notEqual(data.passwordHash, 'NewPassword1');
        assert.equal(data.resetToken, null);
        assert.equal(data.resetTokenExpiry, null);
        if (consumed) return { count: 0 };
        consumed = true;
        return { count: 1 };
      },
    },
    authSession: {
      updateMany: async (args: unknown) => {
        sessionUpdates.push(args);
        return { count: 2 };
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new AuthService(prisma as never, {} as never);

  const result = await service.resetPassword('reset-token', 'NewPassword1');

  assert.deepEqual(result, { message: 'Password has been reset successfully.' });
  assert.equal(consumed, true);
  assert.equal(sessionUpdates.length, 1);
});

test('resetPassword rejects token reuse when another request already consumed it', async () => {
  const { AuthService } = await import('../services/auth.service.js');
  const { AppError } = await import('../utils/errors.js');

  let sessionRevoked = false;
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1' }),
      updateMany: async () => ({ count: 0 }),
    },
    authSession: {
      updateMany: async () => {
        sessionRevoked = true;
        return { count: 1 };
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new AuthService(prisma as never, {} as never);

  await assert.rejects(
    () => service.resetPassword('reset-token', 'NewPassword1'),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'INVALID_RESET_TOKEN',
  );

  assert.equal(sessionRevoked, false);
});
