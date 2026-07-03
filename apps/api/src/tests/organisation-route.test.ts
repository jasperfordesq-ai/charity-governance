import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'organisation-route-test-secret';

const [{ default: Fastify }, { organisationRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/organisations/index.js'),
  import('../utils/jwt.js'),
]);

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

// The publicOrganisation allow-list (utils/public-dtos.ts). The GET/PATCH response
// body must contain exactly these keys — no internal/cross-tenant columns.
const PUBLIC_ORG_KEYS = [
  'id',
  'name',
  'rcnNumber',
  'croNumber',
  'legalForm',
  'complexity',
  'charitablePurpose',
  'financialYearEnd',
  'registeredAddress',
  'contactEmail',
  'contactPhone',
  'website',
  'dateRegistered',
  'lastAgmDate',
] as const;

// A full organisation record as returned by prisma — includes a forbidden column
// (stripeCustomerId) to prove it never leaks through the public DTO.
function fullOrgRecord() {
  return {
    id: 'org-1',
    name: 'Acme Charity',
    rcnNumber: null,
    croNumber: null,
    legalForm: 'CLG',
    complexity: 'SIMPLE',
    charitablePurpose: [],
    financialYearEnd: null,
    registeredAddress: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    dateRegistered: null,
    lastAgmDate: null,
    // forbidden / internal columns that must NOT appear in the response:
    stripeCustomerId: 'cus_secret_123',
    createdAt: new Date(0),
  };
}

function tokenFor(role: Role) {
  return `Bearer ${signAccessToken({ userId: 'u1', organisationId: 'org-1', role, sessionId: 'sess-1' })}`;
}

function activeSubscription() {
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 1_000_000_000), plan: 'ESSENTIALS' };
}

function authModels(role: Role, subscription: unknown) {
  return {
    authSession: { findFirst: async () => ({ id: 'sess-1' }) },
    user: { findUnique: async () => ({ id: 'u1', organisationId: 'org-1', role, emailVerified: true }) },
    subscription: { findUnique: async () => subscription },
  };
}

async function buildApp(
  prismaOverrides: Record<string, unknown>,
  role: Role = 'ADMIN',
  subscription: unknown = activeSubscription(),
) {
  const app = Fastify({ logger: false });
  const prisma = {
    ...authModels(role, subscription),
    ...prismaOverrides,
  } as Record<string, unknown>;
  prisma.$transaction = async (callback: (transaction: typeof prisma) => Promise<unknown>) => callback(prisma);
  app.decorate('prisma', prisma as never);
  await app.register(organisationRoutes);
  return app;
}

// ── tenant isolation / field allow-list ──

test('GET / returns only the public organisation field allow-list', async () => {
  const app = await buildApp(
    { organisation: { findUnique: async () => fullOrgRecord() } },
    'OWNER',
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 200);
    const data = res.json().data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), [...PUBLIC_ORG_KEYS].sort());
    // The forbidden column must never appear, even though the source record carried it.
    assert.equal('stripeCustomerId' in data, false);
  } finally {
    await app.close();
  }
});

// ── authz boundary ──

test('a MEMBER cannot PATCH the organisation (requireAdmin)', async () => {
  let updateCalled = false;
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => fullOrgRecord(),
        update: async () => {
          updateCalled = true;
          return fullOrgRecord();
        },
      },
    },
    'MEMBER',
  );
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/',
      headers: { authorization: tokenFor('MEMBER') },
      payload: { name: 'X' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FORBIDDEN');
    assert.equal(updateCalled, false, 'organisation.update must not run for a MEMBER');
  } finally {
    await app.close();
  }
});

test('an ADMIN may PATCH the organisation', async () => {
  let updateCalled = false;
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => fullOrgRecord(),
        update: async () => {
          updateCalled = true;
          return fullOrgRecord();
        },
      },
    },
    'ADMIN',
  );
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { name: 'Renamed' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalled, true, 'organisation.update must run for an ADMIN');
  } finally {
    await app.close();
  }
});

test('a MEMBER can read the organisation', async () => {
  const app = await buildApp(
    { organisation: { findUnique: async () => fullOrgRecord() } },
    'MEMBER',
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

// ── plan gating (subscriptionGuard) ──

test('organisation routes require an active subscription', async () => {
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => {
          throw new Error('service must not be reached without a subscription');
        },
      },
    },
    'OWNER',
    null,
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'NO_SUBSCRIPTION');
  } finally {
    await app.close();
  }
});

test('organisation routes reject an expired trial', async () => {
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => {
          throw new Error('service must not be reached with an expired trial');
        },
      },
    },
    'OWNER',
    { status: 'TRIALING', trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: null, plan: 'ESSENTIALS' },
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'TRIAL_EXPIRED');
  } finally {
    await app.close();
  }
});

// ── input validation ──

test('PATCH / rejects malformed bodies with VALIDATION_ERROR and skips the write', async () => {
  for (const payload of [{ contactEmail: 'not-an-email' }, { financialYearEnd: '31-12-2026' }]) {
    let updateCalled = false;
    const app = await buildApp(
      {
        organisation: {
          findUnique: async () => fullOrgRecord(),
          update: async () => {
            updateCalled = true;
            return fullOrgRecord();
          },
        },
      },
      'OWNER',
    );
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: { authorization: tokenFor('OWNER') },
        payload,
      });
      assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} must be rejected`);
      assert.equal(res.json().code, 'VALIDATION_ERROR');
      assert.equal(updateCalled, false, 'organisation.update must not run on a validation failure');
    } finally {
      await app.close();
    }
  }
});

// ── auth session ──

test('organisation routes require authentication', async () => {
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => fullOrgRecord(),
        update: async () => fullOrgRecord(),
      },
    },
    'OWNER',
  );
  try {
    for (const route of [
      { method: 'GET' as const, url: '/' },
      { method: 'PATCH' as const, url: '/', payload: { name: 'X' } },
    ]) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} must require auth`);
      assert.equal(res.json().code, 'UNAUTHORIZED');
    }
  } finally {
    await app.close();
  }
});

// ── tenant isolation: the org query is scoped to the caller's organisationId ──
// The route has no client-supplied id; the only org id reachable is the one resolved
// from the authenticated user. These prove the read/write where-clause carries exactly
// that id, so a user in org A can never address org B's organisation record.

test("getOrganisation scopes the lookup to the caller's organisationId", async () => {
  let whereId: unknown;
  const app = await buildApp(
    {
      organisation: {
        findUnique: async (args: { where: { id: string } }) => {
          whereId = args.where.id;
          return fullOrgRecord();
        },
      },
    },
    'OWNER',
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('OWNER') } });
    assert.equal(res.statusCode, 200);
    assert.equal(whereId, 'org-1', 'the lookup must be scoped to the caller organisationId from the token');
  } finally {
    await app.close();
  }
});

test("updateOrganisation scopes the update to the caller's organisationId", async () => {
  let whereId: unknown;
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => fullOrgRecord(),
        update: async (args: { where: { id: string } }) => {
          whereId = args.where.id;
          return fullOrgRecord();
        },
      },
    },
    'ADMIN',
  );
  try {
    // A name-only payload avoids the auto-deadline regeneration branch (which only fires
    // when financialYearEnd / lastAgmDate change), keeping this focused on the write scope.
    const res = await app.inject({
      method: 'PATCH',
      url: '/',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { name: 'Scoped' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(whereId, 'org-1', 'the update must be scoped to the caller organisationId from the token');
  } finally {
    await app.close();
  }
});
