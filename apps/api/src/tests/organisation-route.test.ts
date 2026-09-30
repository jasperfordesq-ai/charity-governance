import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'organisation-route-test-secret';

const [{ default: Fastify }, { organisationRoutes }, { signAccessToken }, { publicUser }] = await Promise.all([
  import('fastify'),
  import('../routes/organisations/index.js'),
  import('../utils/jwt.js'),
  import('../utils/public-dtos.js'),
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
  'legalFormConfirmedAt',
  'complexity',
  'charitablePurpose',
  'financialYearEnd',
  'registeredAddress',
  'contactEmail',
  'contactPhone',
  'website',
  'dateRegistered',
  'incorporationDate',
  'croAnnualReturnDate',
  'croAnnualReturnDateConfirmedAt',
  'lastActualAgmDate',
  'lastUnanimousAnnualMemberResolutionDate',
  'memberCount',
  'constitutionPermitsWrittenResolutions',
  'conditionalObligationProfile',
  'updatedAt',
] as const;

const EXPECTED_UPDATED_AT = '2026-01-01T00:00:00.000Z';

const conditionalProfile = {
  hasPaidStaff: true,
  hasVolunteers: true,
  raisesFundsFromPublic: true,
  worksWithChildrenOrVulnerableAdults: false,
  processesPersonalData: true,
  operatesPremisesOrEvents: true,
  isPublicSectorBody: false,
  usesDataProcessors: true,
};

// A full organisation record as returned by prisma — includes a forbidden column
// (stripeCustomerId) to prove it never leaks through the public DTO.
function fullOrgRecord() {
  return {
    id: 'org-1',
    name: 'Acme Charity',
    rcnNumber: null,
    croNumber: null,
    legalForm: 'CLG',
    legalFormConfirmedAt: null,
    complexity: 'SIMPLE',
    charitablePurpose: [],
    financialYearEnd: null,
    registeredAddress: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    dateRegistered: null,
    incorporationDate: null,
    croAnnualReturnDate: null,
    croAnnualReturnDateConfirmedAt: null,
    lastActualAgmDate: null,
    lastUnanimousAnnualMemberResolutionDate: null,
    memberCount: null,
    conditionalObligationProfile: null,
    updatedAt: new Date(EXPECTED_UPDATED_AT),
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
    organisationChangeAudit: { create: async () => ({}) },
    ...prismaOverrides,
  } as Record<string, unknown>;
  prisma.$queryRaw = async () => [{ id: 'org-1' }];
  prisma.$transaction = async (callback: (transaction: typeof prisma) => Promise<unknown>) => callback(prisma);
  app.decorate('prisma', prisma as never);
  await app.register(organisationRoutes);
  return app;
}

test('Admin connector cannot read organisation edit history through the direct API', async () => {
  let reads = 0;
  const app = await buildApp({
    authSession: { findFirst: async () => ({ id: 'sess-1', clientKind: 'MCP_CONNECTOR', accessLevel: 'ADMIN' }) },
    organisationChangeAudit: { findMany: async () => { reads += 1; return []; } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/audit', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'WEB_SESSION_REQUIRED');
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

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

test('Member organisation profile omits address, contact details and conditional facts', async () => {
  const record = { ...fullOrgRecord(), registeredAddress: 'PRIVATE_HOME_ADDRESS',
    contactEmail: 'PRIVATE_CONTACT_EMAIL', contactPhone: 'PRIVATE_CONTACT_PHONE',
    conditionalObligationProfile: conditionalProfile };
  let memberSelect: Record<string, boolean> | undefined;
  const app = await buildApp({ organisation: { findUnique: async (args: { select: Record<string, boolean> }) => {
    memberSelect = args.select;
    return record;
  } } }, 'MEMBER');
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(res.statusCode, 200);
    assert.equal(/PRIVATE_/u.test(res.body), false);
    assert.equal(res.json().data.registeredAddress, null);
    assert.equal(res.json().data.contactEmail, null);
    assert.equal(res.json().data.contactPhone, null);
    assert.equal(res.json().data.conditionalObligationProfile, null);
    for (const field of ['registeredAddress', 'contactEmail', 'contactPhone', 'conditionalObligationProfile']) {
      assert.equal(memberSelect?.[field], false, `Member database read must omit ${field}`);
    }
  } finally {
    await app.close();
  }
  const admin = await buildApp({ organisation: { findUnique: async () => record } }, 'ADMIN');
  try {
    const res = await admin.inject({ method: 'GET', url: '/', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.registeredAddress, 'PRIVATE_HOME_ADDRESS');
    assert.deepEqual(res.json().data.conditionalObligationProfile, conditionalProfile);
  } finally {
    await admin.close();
  }
});

test('auth and invitation user DTO uses the same Member organisation boundary', () => {
  const organisation = { ...fullOrgRecord(), registeredAddress: 'PRIVATE_HOME_ADDRESS',
    contactEmail: 'PRIVATE_CONTACT_EMAIL', contactPhone: 'PRIVATE_CONTACT_PHONE',
    conditionalObligationProfile: conditionalProfile };
  const member = publicUser({ id: 'u1', email: 'member@example.ie', name: 'Member',
    role: 'MEMBER', emailVerified: true, organisationId: 'org-1', organisation } as never);
  assert.equal(/PRIVATE_/u.test(JSON.stringify(member)), false);
  assert.equal(member.organisation.registeredAddress, null);
  assert.equal(member.organisation.conditionalObligationProfile, null);
  const admin = publicUser({ id: 'u2', email: 'admin@example.ie', name: 'Admin',
    role: 'ADMIN', emailVerified: true, organisationId: 'org-1', organisation } as never);
  assert.equal(admin.organisation.registeredAddress, 'PRIVATE_HOME_ADDRESS');
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

test('organisation audit is Admin-only and tenant-scoped', async () => {
  let reads = 0;
  const audit = { findMany: async (args: { where: { organisationId: string }; take: number }) => {
    reads += 1;
    assert.deepEqual(args.where, { organisationId: 'org-1' });
    assert.equal(args.take, 100);
    return [{ id: 'audit-1', organisationId: 'org-1', actorUserId: 'u1',
      submittedFields: ['name'], previousUpdatedAt: new Date(EXPECTED_UPDATED_AT),
      nextUpdatedAt: new Date('2026-01-02T00:00:00.000Z'), occurredAt: new Date('2026-01-02T00:00:00.000Z') }];
  } };
  const member = await buildApp({ organisationChangeAudit: audit }, 'MEMBER');
  try {
    const res = await member.inject({ method: 'GET', url: '/audit', headers: { authorization: tokenFor('MEMBER') } });
    assert.equal(res.statusCode, 403);
    assert.equal(reads, 0);
  } finally {
    await member.close();
  }
  const admin = await buildApp({ organisationChangeAudit: audit }, 'ADMIN');
  try {
    const res = await admin.inject({ method: 'GET', url: '/audit', headers: { authorization: tokenFor('ADMIN') } });
    assert.equal(res.statusCode, 200);
    assert.equal(reads, 1);
    assert.deepEqual(res.json().data[0].submittedFields, ['name']);
  } finally {
    await admin.close();
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
      payload: { expectedUpdatedAt: EXPECTED_UPDATED_AT, name: 'Renamed' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalled, true, 'organisation.update must run for an ADMIN');
  } finally {
    await app.close();
  }
});

test('PATCH / accepts and returns conditional obligation profile facts', async () => {
  let updateData: unknown;
  const app = await buildApp(
    {
      organisation: {
        findUnique: async () => fullOrgRecord(),
        update: async (args: { data: unknown }) => {
          updateData = args.data;
          return { ...fullOrgRecord(), conditionalObligationProfile: conditionalProfile };
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
      payload: { expectedUpdatedAt: EXPECTED_UPDATED_AT, conditionalObligationProfile: conditionalProfile },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(updateData, { conditionalObligationProfile: conditionalProfile });
    assert.deepEqual(res.json().data.conditionalObligationProfile, conditionalProfile);
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
  for (const payload of [
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, contactEmail: 'not-an-email' },
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, financialYearEnd: '31-12-2026' },
    { expectedUpdatedAt: EXPECTED_UPDATED_AT, memberCount: 2_147_483_648 },
    {
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      conditionalObligationProfile: { hasPaidStaff: 'yes', unknownTrigger: true },
    },
  ]) {
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
    // when legal-calendar profile inputs change), keeping this focused on the write scope.
    const res = await app.inject({
      method: 'PATCH',
      url: '/',
      headers: { authorization: tokenFor('ADMIN') },
      payload: { expectedUpdatedAt: EXPECTED_UPDATED_AT, name: 'Scoped' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(whereId, 'org-1', 'the update must be scoped to the caller organisationId from the token');
  } finally {
    await app.close();
  }
});
