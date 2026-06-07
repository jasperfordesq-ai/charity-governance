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
