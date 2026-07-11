import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

// Auth routes/services reach utils/jwt, which intentionally reads JWT_SECRET
// at module construction time. Keep this test self-contained like the existing
// route reliability suites instead of depending on a developer shell secret.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'personal-server-auth-test-secret';

const [
  { authRoutes },
  { TeamService },
  {
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    setAuthCookies,
  },
] = await Promise.all([
  import('../routes/auth/index.js'),
  import('../services/team.service.js'),
  import('../utils/auth-cookies.js'),
]);

const ENV_KEYS = [
  'NODE_ENV',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'FRONTEND_URL',
  'NEXT_PUBLIC_API_URL',
] as const;

async function withEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const before = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('personal-server registration and provider-backed recovery routes return 404 before validation, lookup, or mutation', { concurrency: false }, async () => {
  await withEnv({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    FRONTEND_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
  }, async () => {
    let userQueried = false;
    let transactionCalled = false;
    const app = Fastify({ logger: false });
    app.decorate('prisma', {
      user: {
        findUnique: async () => {
          userQueried = true;
          return null;
        },
        findFirst: async () => {
          userQueried = true;
          return null;
        },
      },
      $transaction: async () => {
        transactionCalled = true;
      },
    } as never);
    await app.register(authRoutes, { prefix: '/auth' });

    try {
      for (const payload of [
        {},
        {
          email: 'new-owner@example.org',
          password: 'ValidPassword1!',
          name: 'New Owner',
          organisationName: 'Second Organisation',
        },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/auth/register', payload });
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.json(), { error: 'Not found', code: 'NOT_FOUND' });
      }

      for (const request of [
        { url: '/auth/forgot-password', payload: {} },
        { url: '/auth/forgot-password', payload: { email: 'owner@charity.local' } },
        { url: '/auth/resend-verification', payload: {} },
      ]) {
        const response = await app.inject({ method: 'POST', ...request });
        assert.equal(response.statusCode, 404, request.url);
        assert.deepEqual(response.json(), { error: 'Not found', code: 'NOT_FOUND' });
      }

      const resetResponse = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {},
      });
      assert.equal(resetResponse.statusCode, 400, 'manual reset tokens remain consumable in personal-server mode');
      assert.equal(resetResponse.json().code, 'VALIDATION_ERROR');
      assert.equal(userQueried, false);
      assert.equal(transactionCalled, false);
    } finally {
      await app.close();
    }
  });
});

async function issuedCookies(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): Promise<string[]> {
  return withEnv(env, async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    app.get('/set', async (_request, reply) => {
      setAuthCookies(reply, { accessToken: 'access', refreshToken: 'refresh' });
      return { ok: true };
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/set' });
      const header = response.headers['set-cookie'];
      return (Array.isArray(header) ? header : [header ?? '']) as string[];
    } finally {
      await app.close();
    }
  });
}

test('personal-server cookies are non-Secure only for a fully matched exact loopback HTTP origin', { concurrency: false }, async () => {
  const loopbackCookies = await issuedCookies({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    FRONTEND_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
  });
  assert.equal(loopbackCookies.length, 2);
  for (const value of loopbackCookies) {
    assert.match(value, /HttpOnly/iu);
    assert.match(value, /SameSite=Lax/iu);
    assert.doesNotMatch(value, /;\s*Secure(?:;|$)/iu);
  }
  assert.ok(loopbackCookies.some((value) => value.startsWith(`${ACCESS_TOKEN_COOKIE}=`)));
  assert.ok(loopbackCookies.some((value) => value.startsWith(`${REFRESH_TOKEN_COOKIE}=`)));

  for (const env of [
    {
      NODE_ENV: 'production',
      CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      FRONTEND_URL: 'https://charitypilot.home.arpa',
      NEXT_PUBLIC_API_URL: 'https://charitypilot.home.arpa',
    },
    {
      NODE_ENV: 'production',
      CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      FRONTEND_URL: 'http://127.0.0.1:3003',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3002',
    },
    {
      NODE_ENV: 'production',
      CHARITYPILOT_DEPLOYMENT_MODE: undefined,
      FRONTEND_URL: 'http://127.0.0.1:3003',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
    },
  ]) {
    const cookies = await issuedCookies(env);
    for (const value of cookies) assert.match(value, /;\s*Secure(?:;|$)/iu);
  }
});

function inviteHarness() {
  let storedToken = '';
  let emailInvocations = 0;
  const prisma = {
    organisation: { findUnique: async () => ({ id: 'org-1', name: 'One Charity' }) },
    subscription: {
      findUnique: async () => ({
        plan: 'COMPLETE',
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: null,
      }),
    },
    user: {
      findUnique: async (query: { where: { id?: string; email?: string } }) => (
        query.where.id
          ? { id: 'owner-1', name: 'Owner', role: 'OWNER', organisationId: 'org-1', lifecycleStatus: 'ACTIVE' }
          : null
      ),
    },
    teamInvite: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async ({ data }: { data: { token: string } }) => {
        storedToken = data.token;
        return { id: 'invite-1' };
      },
    },
  };
  const emailService = {
    sendTeamInvite: async () => {
      emailInvocations += 1;
      return true;
    },
  };
  return {
    service: new TeamService(prisma as never, emailService as never),
    storedToken: () => storedToken,
    emailInvocations: () => emailInvocations,
  };
}

test('personal-server invite returns a fragment-only one-time URL and does not call Resend', { concurrency: false }, async () => {
  await withEnv({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    FRONTEND_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3003',
  }, async () => {
    const harness = inviteHarness();
    const result = await harness.service.invite('org-1', 'owner-1', 'OWNER', {
      email: 'member@example.org',
      role: 'MEMBER',
    });

    assert.ok('manualInviteUrl' in result);
    assert.equal(typeof result.manualInviteUrl, 'string');
    const inviteUrl = new URL(result.manualInviteUrl);
    assert.equal(inviteUrl.origin, 'http://127.0.0.1:3003');
    assert.equal(inviteUrl.pathname, '/accept-invite');
    assert.equal(inviteUrl.search, '');
    assert.match(inviteUrl.hash, /^#token=[A-Za-z0-9_-]+$/u);
    const plaintextToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('token');
    assert.ok(plaintextToken);
    assert.notEqual(harness.storedToken(), plaintextToken, 'the database stores only the token hash');
    assert.equal(harness.emailInvocations(), 0);
  });
});

test('normal deployment invite remains neutral and never exposes the token', { concurrency: false }, async () => {
  await withEnv({
    NODE_ENV: 'production',
    CHARITYPILOT_DEPLOYMENT_MODE: undefined,
    FRONTEND_URL: 'https://app.charitypilot.ie',
    NEXT_PUBLIC_API_URL: 'https://api.charitypilot.ie',
  }, async () => {
    const harness = inviteHarness();
    const result = await harness.service.invite('org-1', 'owner-1', 'OWNER', {
      email: 'member@example.org',
      role: 'MEMBER',
    });

    assert.deepEqual(result, { message: 'If the invite can be sent, we will email the recipient.' });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'manualInviteUrl'), false);
    assert.equal(harness.emailInvocations(), 1);
  });
});
