import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-throttling-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_auth_throttling_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { default: rateLimit }, { authRoutes }, { teamRoutes }] = await Promise.all([
  import('fastify'),
  import('@fastify/rate-limit'),
  import('../routes/auth/index.js'),
  import('../routes/team/index.js'),
]);

type SensitiveAuthCase = {
  name: string;
  url: string;
  payload: Record<string, string>;
  expectedStatusCode: number;
  expectedCode?: string;
};

const sensitiveAuthCases: SensitiveAuthCase[] = [
  {
    name: 'forgot-password',
    url: '/auth/forgot-password',
    payload: { email: 'missing@example.org' },
    expectedStatusCode: 200,
  },
  {
    name: 'reset-password',
    url: '/auth/reset-password',
    payload: { token: 'invalid-reset-token', password: 'NewPassword1' },
    expectedStatusCode: 400,
    expectedCode: 'INVALID_RESET_TOKEN',
  },
  {
    name: 'verify-email',
    url: '/auth/verify-email',
    payload: { token: 'invalid-verify-token' },
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
    name: 'accept-invite',
    url: '/team/accept-invite',
    payload: { token: 'invalid-invite-token', name: 'Invitee', password: 'NewPassword1' },
    expectedStatusCode: 400,
    expectedCode: 'INVALID_INVITE',
  },
];

async function buildSensitiveRoutesApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
    teamInvite: {
      findUnique: async () => null,
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
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
