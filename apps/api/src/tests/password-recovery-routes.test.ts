import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

process.env.AUTH_RECOVERY_SECRET = Buffer.alloc(48, 0x6d).toString('base64url');
process.env.FRONTEND_URL = 'https://app.charitypilot.ie';
process.env.JWT_SECRET = 'password-recovery-routes-test-jwt-secret';
delete process.env.CHARITYPILOT_DEPLOYMENT_MODE;

const { authRoutes } = await import('../routes/auth/index.js');
const { authRecoverySecretFingerprint } = await import('../services/password-recovery-crypto.js');

const CONTROL_ROW = {
  id: 1,
  blocked: false,
  generation: 1,
  activeSecretFingerprint: authRecoverySecretFingerprint(process.env.AUTH_RECOVERY_SECRET),
  retiredSecretFingerprint: null,
};

async function buildApp(prisma: unknown) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', prisma as never);
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}

function neutralRecoveryPrisma(knownAccount: boolean) {
  const now = new Date('2026-07-10T12:00:00.000Z');
  const created: Array<Record<string, unknown>> = [];
  let queryIndex = 0;
  const user = {
    id: 'recovery-route-user',
    organisationId: 'recovery-route-org',
    email: 'owner@example.org',
    name: 'Owner',
    lifecycleStatus: 'ACTIVE',
    organisation: { lifecycleStatus: 'ACTIVE' },
  };
  const tx = {
    $queryRaw: async () => {
      const current = queryIndex;
      queryIndex += 1;
      if (current === 0) return [CONTROL_ROW];
      if (current === 1) return [{ acquired: 1 }];
      if (current >= 2 && current <= 5) return [{ count: 1 }];
      if (current === 6) return knownAccount
        ? [{ id: user.organisationId, lifecycleStatus: 'ACTIVE' }]
        : [];
      if (current === 7) return knownAccount ? [user] : [];
      if (current === 8) return [{ now }];
      throw new Error(`Unexpected recovery route query ${current}`);
    },
    $executeRaw: async () => 1,
    user: {
      findUnique: async () => knownAccount ? user : null,
    },
    passwordRecoveryRequest: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
  };
  return {
    prisma: {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    },
    created,
  };
}

test('forgot-password returns the same 202 response for known and unknown accounts', async () => {
  const responses: Array<{ statusCode: number; body: unknown }> = [];
  for (const knownAccount of [true, false]) {
    const fixture = neutralRecoveryPrisma(knownAccount);
    const app = await buildApp(fixture.prisma);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: knownAccount ? 'owner@example.org' : 'missing@example.org' },
      });
      responses.push({ statusCode: response.statusCode, body: response.json() });
      assert.equal(JSON.stringify(fixture.created).includes('missing@example.org'), false);
    } finally {
      await app.close();
    }
  }

  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(responses[0], {
    statusCode: 202,
    body: {
      message: 'If an active account exists and another request is allowed, password-recovery instructions will arrive shortly.',
    },
  });
});

test('forgot-password rejects overlong account identifiers identically before database lookup', async () => {
  const suffix = '@example.org';
  const email = `${'a'.repeat(255 - suffix.length)}${suffix}`;
  const responses: Array<{ statusCode: number; body: unknown }> = [];
  for (const hypotheticalAccountExists of [true, false]) {
    let transactionCalls = 0;
    const app = await buildApp({
      $transaction: async () => {
        transactionCalls += 1;
        throw new Error(`database lookup must not run: ${hypotheticalAccountExists}`);
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });
      responses.push({ statusCode: response.statusCode, body: response.json() });
      assert.equal(transactionCalls, 0);
      assert.equal(response.body.includes(email), false);
    } finally {
      await app.close();
    }
  }

  assert.equal(email.length, 255);
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0]?.statusCode, 400);
});

test('forgot-password maps recognized database availability failures to bounded recovery 503', async () => {
  const app = await buildApp({
    $transaction: async () => {
      throw { code: 'P2024' };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'owner@example.org' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: 'Password recovery is temporarily unavailable. Please try again later.',
      code: 'PASSWORD_RECOVERY_UNAVAILABLE',
    });
    assert.equal(response.body.includes('owner@example.org'), false);
  } finally {
    await app.close();
  }
});

test('reset-password rejects malformed bearer tokens generically after durable rate accounting', async () => {
  let rateQueries = 0;
  const app = await buildApp({
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => {
        rateQueries += 1;
        return rateQueries % 5 === 1 ? [CONTROL_ROW] : [{ count: 1 }];
      },
      $executeRaw: async () => 1,
    }),
    passwordRecoveryRequest: {
      findUnique: async () => {
        throw new Error('malformed token must not reach recovery lookup');
      },
    },
  });
  try {
    for (const token of [' bad token ', `bad\u0000token`, 'x'.repeat(513)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token, password: 'NewPassword1' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, 'INVALID_RESET_TOKEN');
      assert.equal(response.body.includes(token), false);
    }
    assert.equal(rateQueries, 15);
  } finally {
    await app.close();
  }
});
