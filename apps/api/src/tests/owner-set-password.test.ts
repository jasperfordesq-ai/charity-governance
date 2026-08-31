import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-setpw-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-setpw-test';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, bcrypt, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('bcryptjs'),
    import('../routes/owner/index.js'),
  ]);

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const RAW_TOKEN = 'a-valid-reset-token';
const TOKEN_HASH = hashToken(RAW_TOKEN);

interface OperatorRow {
  id: string;
  resetToken: string | null;
  resetTokenExpiry: Date | null;
}

interface FindWhere {
  id?: string;
  resetToken?: string;
  resetTokenExpiry?: { gt?: Date };
}

interface OperatorPrismaStub {
  platformOperator: {
    findFirst: (args: { where: FindWhere }) => Promise<{ id: string } | null>;
    updateMany: (args: { where: FindWhere; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  platformOperatorSession: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: OperatorPrismaStub) => Promise<T>) => Promise<T>;
}

// A stub that honours the `where` clause it is given: it holds one mutable
// operator row and only matches or writes it when the passed filters are
// actually satisfied against that row's real, current data. This is what
// lets the tests below fail for the right reason if the service's query
// regresses -- e.g. drops the hash comparison, or drops the expiry condition
// -- instead of passing regardless of what the service actually queries by.
function buildOperatorStore(initial: OperatorRow | null) {
  let current = initial ? { ...initial } : null;
  const updates: Record<string, unknown>[] = [];
  const sessionRevocations: Record<string, unknown>[] = [];
  let lastFindFirstWhere: FindWhere | undefined;

  function matches(where: FindWhere): boolean {
    if (!current) return false;
    if (where.id !== undefined && where.id !== current.id) return false;
    if (where.resetToken !== undefined && where.resetToken !== current.resetToken) return false;
    if (where.resetTokenExpiry?.gt !== undefined) {
      const gt = where.resetTokenExpiry.gt;
      if (!current.resetTokenExpiry || !(current.resetTokenExpiry.getTime() > gt.getTime())) return false;
    }
    return true;
  }

  const prisma: OperatorPrismaStub = {
    platformOperator: {
      findFirst: async ({ where }) => {
        lastFindFirstWhere = where;
        return matches(where) ? { id: current!.id } : null;
      },
      updateMany: async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        updates.push(data);
        current = {
          ...current!,
          resetToken: 'resetToken' in data ? (data.resetToken as string | null) : current!.resetToken,
          resetTokenExpiry:
            'resetTokenExpiry' in data ? (data.resetTokenExpiry as Date | null) : current!.resetTokenExpiry,
        };
        return { count: 1 };
      },
    },
    platformOperatorSession: {
      updateMany: async ({ where, data }) => {
        sessionRevocations.push({ where, data });
        return { count: 0 };
      },
    },
    async $transaction(fn) {
      return fn(prisma);
    },
  };

  return {
    prisma,
    updates,
    sessionRevocations,
    getLastFindFirstWhere: () => lastFindFirstWhere,
    getCurrentRow: () => current,
  };
}

async function buildApp(row: OperatorRow | null) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  const store = buildOperatorStore(row);
  app.decorate('prisma', store.prisma as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return { app, ...store };
}

function futureDate(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function pastDate(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

test('a valid token sets the password, clears the token, and revokes live sessions', async () => {
  const { app, updates, sessionRevocations } = await buildApp({
    id: 'op-1',
    resetToken: TOKEN_HASH,
    resetTokenExpiry: futureDate(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  assert.equal(res.statusCode, 200);
  const written = updates[0];
  assert.equal(written.resetToken, null, 'the reset token must be single-use');
  assert.equal(written.resetTokenExpiry, null);
  assert.ok(await bcrypt.default.compare('a-long-enough-new-password', written.passwordHash as string));
  assert.equal(sessionRevocations.length, 1, 'live sessions must be revoked alongside the password write');
  assert.equal((sessionRevocations[0].where as Record<string, unknown>).operatorId, 'op-1');
  await app.close();
});

test('a token that does not match any stored hash is refused', async () => {
  // A real row exists, but its stored hash does not match the submitted
  // token. Unlike injecting a null row, this must fail if the service ever
  // stopped hashing the submitted token (or compared it to the wrong thing),
  // because the stub only refuses based on the actual `where` it receives.
  const { app, updates } = await buildApp({
    id: 'op-1',
    resetToken: hashToken('a-different-token-entirely'),
    resetTokenExpiry: futureDate(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: 'wrong', password: 'a-long-enough-new-password' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_RESET_TOKEN');
  assert.equal(updates.length, 0);
  await app.close();
});

test('a short password is refused before any write', async () => {
  const { app, updates } = await buildApp({
    id: 'op-1',
    resetToken: TOKEN_HASH,
    resetTokenExpiry: futureDate(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'short' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(updates.length, 0);
  await app.close();
});

test('an expired token is refused even though its hash matches', async () => {
  // The hash matches exactly, but resetTokenExpiry is in the past. This must
  // fail if the service ever dropped the `resetTokenExpiry: { gt: now } }`
  // condition from its query, since the stub enforces expiry only via the
  // `where` clause it actually received.
  const { app, updates } = await buildApp({
    id: 'op-1',
    resetToken: TOKEN_HASH,
    resetTokenExpiry: pastDate(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_RESET_TOKEN');
  assert.equal(updates.length, 0);
  await app.close();
});

test('the raw token is never used as a lookup key, and expiry is enforced in the same query', async () => {
  const { app, getLastFindFirstWhere } = await buildApp({
    id: 'op-1',
    resetToken: TOKEN_HASH,
    resetTokenExpiry: futureDate(),
  });

  await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  const where = getLastFindFirstWhere();
  assert.equal(where?.resetToken, TOKEN_HASH);
  assert.notEqual(where?.resetToken, RAW_TOKEN);
  assert.ok(where?.resetTokenExpiry?.gt instanceof Date, 'the lookup must also enforce expiry');
  await app.close();
});

test('a second use of the same token is refused', async () => {
  const { app, updates } = await buildApp({
    id: 'op-1',
    resetToken: TOKEN_HASH,
    resetTokenExpiry: futureDate(),
  });

  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'another-long-enough-password' },
  });
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().code, 'INVALID_RESET_TOKEN');
  assert.equal(updates.length, 1, 'the second attempt must not perform a write');
  await app.close();
});
