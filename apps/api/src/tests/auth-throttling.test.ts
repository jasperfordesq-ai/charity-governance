import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-throttling-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_auth_throttling_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { default: rateLimit }, { default: cookie }, { authRoutes }, { teamRoutes }] = await Promise.all([
  import('fastify'),
  import('@fastify/rate-limit'),
  import('@fastify/cookie'),
  import('../routes/auth/index.js'),
  import('../routes/team/index.js'),
]);

type SensitiveAuthCase = {
  name: string;
  url: string;
  payload: Record<string, string>;
  alternatePayload?: Record<string, string>;
  expectedStatusCode: number;
  expectedCode?: string;
};

const sensitiveAuthCases: SensitiveAuthCase[] = [
  {
    name: 'forgot-password',
    url: '/auth/forgot-password',
    payload: { email: 'missing@example.org' },
    alternatePayload: { email: 'other-missing@example.org' },
    expectedStatusCode: 200,
  },
  {
    name: 'reset-password',
    url: '/auth/reset-password',
    payload: { token: 'invalid-reset-token', password: 'NewPassword1' },
    alternatePayload: { token: 'another-invalid-reset-token', password: 'NewPassword1' },
    expectedStatusCode: 400,
    expectedCode: 'INVALID_RESET_TOKEN',
  },
  {
    name: 'verify-email',
    url: '/auth/verify-email',
    payload: { token: 'invalid-verify-token' },
    alternatePayload: { token: 'another-invalid-verify-token' },
    expectedStatusCode: 400,
    expectedCode: 'INVALID_VERIFY_TOKEN',
  },
  {
    name: 'resend-verification',
    url: '/auth/resend-verification',
    payload: {},
    expectedStatusCode: 401,
    expectedCode: 'UNAUTHORIZED',
  },
  {
    name: 'refresh',
    url: '/auth/refresh',
    payload: { refreshToken: 'invalid-refresh-token-a' },
    alternatePayload: { refreshToken: 'invalid-refresh-token-b' },
    expectedStatusCode: 401,
    expectedCode: 'INVALID_REFRESH_TOKEN',
  },
  {
    name: 'accept-invite',
    url: '/team/accept-invite',
    payload: { token: 'invalid-invite-token', name: 'Invitee', password: 'NewPassword1' },
    alternatePayload: { token: 'another-invalid-invite-token', name: 'Invitee', password: 'NewPassword1' },
    expectedStatusCode: 400,
    expectedCode: 'INVALID_INVITE',
  },
];

async function buildSensitiveRoutesApp(prismaOverrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
    teamInvite: {
      findUnique: async () => null,
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    ...prismaOverrides,
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(teamRoutes, { prefix: '/team' });
  return app;
}

for (const routeCase of sensitiveAuthCases) {
  test(`${routeCase.name} has route-specific throttling below the global limit`, { concurrency: false }, async () => {
    const app = await buildSensitiveRoutesApp();

    try {
      const responses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        responses.push(
          await app.inject({
            method: 'POST',
            url: routeCase.url,
            payload: routeCase.payload,
          }),
        );
      }

      for (const response of responses.slice(0, 5)) {
        assert.equal(response.statusCode, routeCase.expectedStatusCode, response.body);
        if (routeCase.expectedCode) {
          assert.equal(response.json().code, routeCase.expectedCode);
        }
      }
      assert.equal(responses[5].statusCode, 429);
    } finally {
      await app.close();
    }
  });
}

for (const routeCase of sensitiveAuthCases.filter((candidate) => candidate.alternatePayload)) {
  test(`${routeCase.name} throttling is keyed by caller and normalized body identifier`, { concurrency: false }, async () => {
    const app = await buildSensitiveRoutesApp();
    const alternatePayload = routeCase.alternatePayload;
    assert.ok(alternatePayload, `${routeCase.name} must define an alternate payload for identifier-key tests`);

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: 'POST',
          url: routeCase.url,
          payload: routeCase.payload,
        });
        assert.equal(res.statusCode, routeCase.expectedStatusCode, res.body);
      }

      const sameIdentifier = await app.inject({
        method: 'POST',
        url: routeCase.url,
        payload: routeCase.payload,
      });
      assert.equal(sameIdentifier.statusCode, 429, sameIdentifier.body);

      const otherIdentifier = await app.inject({
        method: 'POST',
        url: routeCase.url,
        payload: alternatePayload,
      });
      assert.equal(otherIdentifier.statusCode, routeCase.expectedStatusCode, otherIdentifier.body);
      if (routeCase.expectedCode) {
        assert.equal(otherIdentifier.json().code, routeCase.expectedCode);
      }
    } finally {
      await app.close();
    }
  });
}

test('login throttling is keyed by caller and normalized email identifier', { concurrency: false }, async () => {
  const app = await buildSensitiveRoutesApp();

  try {
    const firstEmailPayload = { email: 'Trustee@Example.ORG', password: 'WrongPassword1' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: firstEmailPayload,
      });
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().code, 'INVALID_CREDENTIALS');
    }

    const sameEmailRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'trustee@example.org', password: 'WrongPassword1' },
    });
    assert.equal(sameEmailRes.statusCode, 429, sameEmailRes.body);

    const otherEmailRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'another@example.org', password: 'WrongPassword1' },
    });
    assert.equal(otherEmailRes.statusCode, 401, otherEmailRes.body);
    assert.equal(otherEmailRes.json().code, 'INVALID_CREDENTIALS');
  } finally {
    await app.close();
  }
});

test('register throttling is keyed by caller and normalized email identifier', { concurrency: false }, async () => {
  const app = await buildSensitiveRoutesApp({
    user: {
      findUnique: async () => ({ id: 'existing-user' }),
      findFirst: async () => null,
    },
  });

  try {
    const firstEmailPayload = {
      email: 'Owner@Example.ORG',
      password: 'NewPassword1',
      name: 'Existing Owner',
      organisationName: 'Existing Charity',
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: firstEmailPayload,
      });
      assert.equal(res.statusCode, 202, res.body);
    }

    const sameEmailRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...firstEmailPayload, email: 'owner@example.org' },
    });
    assert.equal(sameEmailRes.statusCode, 429, sameEmailRes.body);

    const otherEmailRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...firstEmailPayload, email: 'another-owner@example.org' },
    });
    assert.equal(otherEmailRes.statusCode, 202, otherEmailRes.body);
  } finally {
    await app.close();
  }
});

test('resend-verification throttling is keyed by caller credential', { concurrency: false }, async () => {
  const app = await buildSensitiveRoutesApp();

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/resend-verification',
        headers: { authorization: 'Bearer invalid-access-token-a' },
        payload: {},
      });
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().code, 'UNAUTHORIZED');
    }

    const sameCredentialRes = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      headers: { authorization: 'Bearer invalid-access-token-a' },
      payload: {},
    });
    assert.equal(sameCredentialRes.statusCode, 429, sameCredentialRes.body);

    const otherCredentialRes = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      headers: { authorization: 'Bearer invalid-access-token-b' },
      payload: {},
    });
    assert.equal(otherCredentialRes.statusCode, 401, otherCredentialRes.body);
    assert.equal(otherCredentialRes.json().code, 'UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

test('logout throttling is keyed by refresh token identifier', { concurrency: false }, async () => {
  const app = await buildSensitiveRoutesApp();

  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        payload: { refreshToken: 'invalid-logout-token-a' },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json(), { ok: true });
    }

    const sameTokenRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'invalid-logout-token-a' },
    });
    assert.equal(sameTokenRes.statusCode, 429, sameTokenRes.body);

    const otherTokenRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'invalid-logout-token-b' },
    });
    assert.equal(otherTokenRes.statusCode, 200, otherTokenRes.body);
    assert.deepEqual(otherTokenRes.json(), { ok: true });
  } finally {
    await app.close();
  }
});
