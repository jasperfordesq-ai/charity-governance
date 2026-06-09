import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'export-csp-test-secret';

const [{ default: Fastify }, { exportRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/export/index.js'),
  import('../utils/jwt.js'),
]);

const authHeader = `Bearer ${signAccessToken({
  userId: 'user-1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'session-1',
})}`;

function subscription() {
  return {
    findUnique: async () => ({ status: 'TRIALING', trialEndsAt: new Date(Date.now() + 60_000) }),
  };
}

test('export HTML route sets a scoped CSP that allows its inline stylesheet', async () => {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'ADMIN', emailVerified: true }) },
    subscription: subscription(),
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: 'Example Charity',
        rcnNumber: 'RCN 123',
        complexity: 'SIMPLE',
      }),
    },
    governancePrinciple: { findMany: async () => [] },
    complianceRecord: { findMany: async () => [] },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  } as never);
  await app.register(exportRoutes);

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(response.headers['content-security-policy']), /style-src 'unsafe-inline'/);
  } finally {
    await app.close();
  }
});

test('Essentials exports do not include Complete-only governance registers', async () => {
  let completeOnlyRegisterRead = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: { findUnique: async () => ({ id: 'user-1', organisationId: 'org-1', role: 'ADMIN', emailVerified: true }) },
    subscription: {
      findUnique: async () => ({
        status: 'ACTIVE',
        trialEndsAt: null,
        plan: 'ESSENTIALS',
      }),
    },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: 'Example Charity',
        rcnNumber: 'RCN 123',
        complexity: 'COMPLEX',
      }),
      findUnique: async () => ({
        complexity: 'COMPLEX',
      }),
    },
    governancePrinciple: { findMany: async () => [] },
    complianceRecord: { findMany: async () => [] },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: {
      findMany: async () => {
        completeOnlyRegisterRead = true;
        return [{ trusteeName: 'Legacy trustee', matter: 'Legacy conflict', status: 'DECLARED', dateDeclared: new Date('2026-01-01'), actionTaken: 'Do not leak', minuteReference: null }];
      },
    },
    riskRecord: {
      findMany: async () => {
        completeOnlyRegisterRead = true;
        return [{ title: 'Legacy high risk', category: 'FINANCIAL', likelihood: 5, impact: 5, mitigation: 'Do not leak', status: 'OPEN', owner: null, reviewDate: null }];
      },
    },
    complaintRecord: {
      findMany: async () => {
        completeOnlyRegisterRead = true;
        return [{ receivedDate: new Date('2026-01-01'), summary: 'Legacy complaint', status: 'OPEN', reviewedByBoard: false, outcome: null }];
      },
    },
    fundraisingRecord: {
      findMany: async () => {
        completeOnlyRegisterRead = true;
        return [{ name: 'Legacy appeal', activityType: 'Street', status: 'OPEN', controls: 'Do not leak', complaintsReceived: false }];
      },
    },
    annualReportReadiness: {
      findUnique: async () => {
        completeOnlyRegisterRead = true;
        return { filingStatus: 'READY' };
      },
    },
    financialControlReview: {
      findUnique: async () => {
        completeOnlyRegisterRead = true;
        return { minuteReference: 'FC-1' };
      },
    },
  } as never);
  await app.register(exportRoutes);

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: authHeader },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(completeOnlyRegisterRead, false);
    assert.doesNotMatch(response.body, /Governance registers|Legacy trustee|Legacy high risk|Legacy complaint|Legacy appeal|FC-1/);
  } finally {
    await app.close();
  }
});
