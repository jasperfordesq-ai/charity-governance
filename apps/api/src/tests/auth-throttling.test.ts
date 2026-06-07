import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'auth-throttling-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_auth_throttling_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { default: rateLimit }, { authRoutes }] = await Promise.all([
  import('fastify'),
  import('@fastify/rate-limit'),
  import('../routes/auth/index.js'),
]);

type SensitiveAuthCase = {
  name: string;
  url: string;
  payload: Record<string, string>;
};

const sensitiveAuthCases: SensitiveAuthCase[] = [
  {
    name: 'forgot-password',
    url: '/auth/forgot-password',
    payload: { email: 'missing@example.org' },
  },
  {
    name: 'reset-password',
    url: '/auth/reset-password',
    payload: { token: 'invalid-reset-token', password: 'NewPassword1' },
  },
  {
    name: 'verify-email',
    url: '/auth/verify-email',
    payload: { token: 'invalid-verify-token' },
  },
  {
    name: 'resend-verification',
    url: '/auth/resend-verification',
    payload: {},
  },
];

async function buildAuthApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
  } as never);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}

for (const routeCase of sensitiveAuthCases) {
  test(`${routeCase.name} has route-specific throttling below the global limit`, { concurrency: false }, async () => {
    const app = await buildAuthApp();

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

      assert.equal(responses.slice(0, 5).some((response) => response.statusCode === 429), false);
      assert.equal(responses[5].statusCode, 429);
    } finally {
      await app.close();
    }
  });
}
