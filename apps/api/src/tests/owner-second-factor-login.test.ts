import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OWNER_JWT_SECRET =
  process.env.OWNER_JWT_SECRET ?? 'owner-second-factor-login-test-secret-value-here';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'owner-second-factor-login-tenant-secret';
process.env.CHARITYPILOT_TENANCY = process.env.CHARITYPILOT_TENANCY ?? 'multi';

const [
  { default: Fastify },
  { default: cookie },
  { default: rateLimit },
  { ownerRoutes },
  bcrypt,
  { sealTotpSecret },
  { totp, fromBase32, toBase32 },
] = await Promise.all([
  import('fastify'),
  import('@fastify/cookie'),
  import('@fastify/rate-limit'),
  import('../routes/owner/index.js'),
  import('bcryptjs'),
  import('../services/operator-second-factor.service.js'),
  import('../utils/totp.js'),
]);

const PASSWORD = 'correct-horse-battery-staple';
const SECRET = toBase32(Buffer.from('12345678901234567890', 'utf8'));

/** The code an authenticator would be showing right now. */
function currentCode(): string {
  return totp(fromBase32(SECRET));
}

async function buildApp(options: {
  enrolled: boolean;
  recoveryHashes?: string[];
}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const spent: string[] = [];

  app.decorate('prisma', {
    platformOperator: {
      findUnique: async () => ({
        id: 'op-1',
        email: 'operator@example.org',
        name: 'Operator',
        passwordHash: bcrypt.default.hashSync(PASSWORD, 10),
        lifecycleStatus: 'ACTIVE',
        totpSecret: options.enrolled ? sealTotpSecret(SECRET) : null,
        totpEnrolledAt: options.enrolled ? new Date('2026-01-01T00:00:00.000Z') : null,
        totpPendingAt: null,
      }),
      update: async () => ({}),
    },
    platformOperatorRecoveryCode: {
      updateMany: async ({ where }: { where: { codeHash: string } }) => {
        const known = (options.recoveryHashes ?? []).includes(where.codeHash);
        if (!known || spent.includes(where.codeHash)) return { count: 0 };
        spent.push(where.codeHash);
        return { count: 1 };
      },
      count: async () => (options.recoveryHashes ?? []).length - spent.length,
      createMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    platformOperatorSession: {
      create: async ({ data }: { data: unknown }) => ({ id: 's-1', ...(data as object) }),
      findFirst: async () => null,
      update: async () => ({}),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(app.prisma),
  } as never);

  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return { app, spent };
}

function login(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'operator@example.org', password: PASSWORD, ...payload },
  });
}

function cookiesOf(response: { headers: Record<string, unknown> }): string {
  const set = response.headers['set-cookie'] as string[] | string | undefined;
  if (!set) return '';
  return Array.isArray(set) ? set.join(';') : String(set);
}

test('an account with no second factor still signs in on the password alone', async () => {
  // Enrolment is opt-in. Requiring it for everybody in one deployment would
  // lock out whoever had not enrolled yet, quite possibly the only person who
  // could fix it.
  const { app } = await buildApp({ enrolled: false });
  try {
    const response = await login(app, {});

    assert.equal(response.statusCode, 200);
    assert.match(cookiesOf(response), /charitypilot_owner_access=/);
  } finally {
    await app.close();
  }
});

test('an enrolled account gets no session from the password alone', async () => {
  const { app } = await buildApp({ enrolled: true });
  try {
    const response = await login(app, {});

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'SECOND_FACTOR_REQUIRED');
    assert.equal(
      cookiesOf(response),
      '',
      'no session may be issued before the factor is satisfied',
    );
  } finally {
    await app.close();
  }
});

test('the refusal is distinguishable from a wrong password', async () => {
  // The password WAS right. Telling somebody to retype it would send them
  // hunting for a problem that is not there. This leaks only that the account
  // has a second factor, which whoever holds its correct password knows.
  const { app } = await buildApp({ enrolled: true });
  try {
    const missingFactor = await login(app, {});
    const wrongPassword = await login(app, { password: 'not-the-password' });

    assert.equal(missingFactor.json().code, 'SECOND_FACTOR_REQUIRED');
    assert.equal(wrongPassword.json().code, 'INVALID_CREDENTIALS');
  } finally {
    await app.close();
  }
});

test('a wrong password is refused even with a correct code', async () => {
  const { app } = await buildApp({ enrolled: true });
  try {
    const response = await login(app, { password: 'not-the-password', code: currentCode() });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'INVALID_CREDENTIALS');
    assert.equal(cookiesOf(response), '');
  } finally {
    await app.close();
  }
});

test('a correct code signs in', async () => {
  const { app } = await buildApp({ enrolled: true });
  try {
    const response = await login(app, { code: currentCode() });

    assert.equal(response.statusCode, 200);
    assert.match(cookiesOf(response), /charitypilot_owner_access=/);
    assert.equal(response.json().usedRecoveryCode, undefined);
  } finally {
    await app.close();
  }
});

test('a wrong code is refused', async () => {
  const { app } = await buildApp({ enrolled: true });
  try {
    const response = await login(app, { code: '000000' });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'SECOND_FACTOR_REQUIRED');
    assert.equal(cookiesOf(response), '');
  } finally {
    await app.close();
  }
});

test('a recovery code signs in, and the response says one was spent', async () => {
  const { createHash } = await import('node:crypto');
  const code = 'ABCDE-12345';
  const hash = createHash('sha256').update('ABCDE12345').digest('hex');

  const { app } = await buildApp({ enrolled: true, recoveryHashes: [hash] });
  try {
    const response = await login(app, { recoveryCode: code });

    assert.equal(response.statusCode, 200);
    assert.match(cookiesOf(response), /charitypilot_owner_access=/);
    assert.equal(
      response.json().usedRecoveryCode,
      true,
      'a recovery code is one of ten and nobody counts them in their head',
    );
  } finally {
    await app.close();
  }
});

test('a recovery code works once', async () => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('ABCDE12345').digest('hex');

  const { app } = await buildApp({ enrolled: true, recoveryHashes: [hash] });
  try {
    assert.equal((await login(app, { recoveryCode: 'ABCDE-12345' })).statusCode, 200);

    const again = await login(app, { recoveryCode: 'ABCDE-12345' });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().code, 'SECOND_FACTOR_REQUIRED');
  } finally {
    await app.close();
  }
});

test('the second factor routes need a session of their own', async () => {
  const { app } = await buildApp({ enrolled: false });
  try {
    for (const [method, url] of [
      ['GET', '/api/v1/owner/auth/second-factor'],
      ['POST', '/api/v1/owner/auth/second-factor/begin'],
      ['POST', '/api/v1/owner/auth/second-factor/complete'],
      ['POST', '/api/v1/owner/auth/second-factor/remove'],
    ] as Array<[string, string]>) {
      const response = await app.inject({ method: method as 'GET' | 'POST', url, payload: {} });
      assert.equal(response.statusCode, 401, `${method} ${url} must need a session`);
    }
  } finally {
    await app.close();
  }
});
