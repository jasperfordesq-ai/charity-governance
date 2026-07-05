import assert from 'node:assert/strict';
import test from 'node:test';
import { IRISH_COMPLIANCE_MATRIX_LAST_CHECKED } from '@charitypilot/shared';

// Set every env var the imported modules read at import/construction time, BEFORE imports.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'export-reliability-test-secret';

const [{ default: Fastify }, { exportRoutes }, { signAccessToken }] = await Promise.all([
  import('fastify'),
  import('../routes/export/index.js'),
  import('../utils/jwt.js'),
]);

function tokenFor(organisationId = 'org-1', role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'ADMIN') {
  return (
    'Bearer ' +
    signAccessToken({ userId: 'user-1', organisationId, role, sessionId: 'session-1' })
  );
}

function authModels(organisationId = 'org-1', role = 'ADMIN', emailVerified = true) {
  return {
    authSession: { findFirst: async () => ({ id: 'session-1' }) },
    user: {
      findUnique: async () => ({ id: 'user-1', organisationId, role, emailVerified }),
    },
  };
}

function activeComplete() {
  return { status: 'ACTIVE', trialEndsAt: null, plan: 'COMPLETE' };
}

function activeEssentials() {
  return { status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' };
}

function falseProfile() {
  return {
    hasPaidStaff: false,
    hasVolunteers: false,
    raisesFundsFromPublic: false,
    worksWithChildrenOrVulnerableAdults: false,
    processesPersonalData: false,
    operatesPremisesOrEvents: false,
    isPublicSectorBody: false,
    usesDataProcessors: false,
  };
}

// Base read mocks that produce an empty-but-valid compliance report.
function emptyComplianceReads(): Record<string, unknown> {
  return {
    governancePrinciple: { findMany: async () => [] },
    governanceStandard: { findMany: async () => [] },
    complianceRecord: { findMany: async () => [] },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  };
}

function emptyOrganisation() {
  return {
    findUniqueOrThrow: async () => ({
      id: 'org-1',
      name: 'Example Charity',
      rcnNumber: 'RCN 123',
      complexity: 'COMPLEX',
      conditionalObligationProfile: falseProfile(),
    }),
  };
}

async function buildApp(prismaOverrides: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', prismaOverrides as never);
  await app.register(exportRoutes);
  return app;
}

test('Complete plan exports include governance registers', async () => {
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeComplete() },
    organisation: emptyOrganisation(),
    ...emptyComplianceReads(),
    conflictRecord: {
      findMany: async () => [
        {
          trusteeName: 'Visible trustee',
          matter: 'Disclosed interest',
          status: 'DECLARED',
          dateDeclared: new Date('2026-01-01'),
          actionTaken: 'Recused',
          minuteReference: null,
        },
      ],
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Governance registers/);
    assert.match(response.body, /Visible trustee/);
    assert.match(response.body, /Source and professional-review appendix/);
    assert.match(response.body, /not legal advice/);
    assert.match(response.body, /not a certificate that the charity is compliant/);
    assert.match(response.body, new RegExp(`Matrix last checked: ${IRISH_COMPLIANCE_MATRIX_LAST_CHECKED}`));
  } finally {
    await app.close();
  }
});

test('export rejects organisation with no subscription', async () => {
  let orgLookupCalled = false;
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => null },
    organisation: {
      findUniqueOrThrow: async () => {
        orgLookupCalled = true;
        return {};
      },
    },
    ...emptyComplianceReads(),
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'NO_SUBSCRIPTION');
    assert.equal(orgLookupCalled, false);
  } finally {
    await app.close();
  }
});

test('export rejects organisation with expired trial', async () => {
  let orgLookupCalled = false;
  const app = await buildApp({
    ...authModels(),
    subscription: {
      findUnique: async () => ({
        status: 'TRIALING',
        trialEndsAt: new Date(Date.now() - 60_000),
        plan: 'ESSENTIALS',
      }),
    },
    organisation: {
      findUniqueOrThrow: async () => {
        orgLookupCalled = true;
        return {};
      },
    },
    ...emptyComplianceReads(),
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'TRIAL_EXPIRED');
    assert.equal(orgLookupCalled, false);
  } finally {
    await app.close();
  }
});

test('export scopes the organisation and compliance reads to the token organisation', async () => {
  let capturedOrgWhere: { id?: string } | undefined;
  let capturedRecordWhere: { organisationId?: string } | undefined;

  const app = await buildApp({
    ...authModels('org-A'),
    subscription: { findUnique: async () => activeEssentials() },
    organisation: {
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        capturedOrgWhere = args.where;
        return { id: 'org-A', name: 'Org A', rcnNumber: 'RCN-A', complexity: 'SIMPLE' };
      },
    },
    ...emptyComplianceReads(),
    complianceRecord: {
      findMany: async (args: { where: { organisationId: string } }) => {
        capturedRecordWhere = args.where;
        return [];
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor('org-A') },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(capturedOrgWhere?.id, 'org-A');
    assert.equal(capturedRecordWhere?.organisationId, 'org-A');
  } finally {
    await app.close();
  }
});

test('Complete plan governance registers are scoped to the token organisation', async () => {
  const captured: Record<string, { organisationId?: string } | undefined> = {};
  const capturedUnique: Record<
    string,
    { organisationId_reportingYear?: { organisationId?: string } } | undefined
  > = {};

  const findManyScoped = (key: string) => async (args: { where: { organisationId: string } }) => {
    captured[key] = args.where;
    return [];
  };
  const findUniqueScoped =
    (key: string) =>
    async (args: { where: { organisationId_reportingYear: { organisationId: string } } }) => {
      capturedUnique[key] = args.where;
      return null;
    };

  const app = await buildApp({
    ...authModels('org-A'),
    subscription: { findUnique: async () => activeComplete() },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-A',
        name: 'Org A',
        rcnNumber: 'RCN-A',
        complexity: 'COMPLEX',
        conditionalObligationProfile: falseProfile(),
      }),
    },
    governancePrinciple: { findMany: async () => [] },
    governanceStandard: { findMany: async () => [] },
    complianceRecord: { findMany: async () => [] },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: findManyScoped('conflict') },
    riskRecord: { findMany: findManyScoped('risk') },
    complaintRecord: { findMany: findManyScoped('complaint') },
    fundraisingRecord: { findMany: findManyScoped('fundraising') },
    annualReportReadiness: { findUnique: findUniqueScoped('annualReport') },
    financialControlReview: { findUnique: findUniqueScoped('financialControl') },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor('org-A') },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(captured.conflict?.organisationId, 'org-A');
    assert.equal(captured.risk?.organisationId, 'org-A');
    assert.equal(captured.complaint?.organisationId, 'org-A');
    assert.equal(captured.fundraising?.organisationId, 'org-A');
    assert.equal(
      capturedUnique.annualReport?.organisationId_reportingYear?.organisationId,
      'org-A',
    );
    assert.equal(
      capturedUnique.financialControl?.organisationId_reportingYear?.organisationId,
      'org-A',
    );
  } finally {
    await app.close();
  }
});

test('export rejects missing token, revoked session, and unverified email', async () => {
  // (a) no authorization header -> 401 UNAUTHORIZED.
  {
    let orgLookupCalled = false;
    const app = await buildApp({
      ...authModels(),
      subscription: { findUnique: async () => activeEssentials() },
      organisation: {
        findUniqueOrThrow: async () => {
          orgLookupCalled = true;
          return {};
        },
      },
      ...emptyComplianceReads(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/compliance-record?year=2026' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, 'UNAUTHORIZED');
      assert.equal(orgLookupCalled, false);
    } finally {
      await app.close();
    }
  }

  // (b) revoked session (authSession.findFirst -> null) -> 401 UNAUTHORIZED.
  {
    let orgLookupCalled = false;
    const app = await buildApp({
      authSession: { findFirst: async () => null },
      user: {
        findUnique: async () => ({
          id: 'user-1',
          organisationId: 'org-1',
          role: 'ADMIN',
          emailVerified: true,
        }),
      },
      subscription: { findUnique: async () => activeEssentials() },
      organisation: {
        findUniqueOrThrow: async () => {
          orgLookupCalled = true;
          return {};
        },
      },
      ...emptyComplianceReads(),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/compliance-record?year=2026',
        headers: { authorization: tokenFor() },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, 'UNAUTHORIZED');
      assert.equal(orgLookupCalled, false);
    } finally {
      await app.close();
    }
  }

  // (c) authenticated but email unverified -> 403 EMAIL_NOT_VERIFIED.
  {
    let orgLookupCalled = false;
    const app = await buildApp({
      ...authModels('org-1', 'ADMIN', false),
      subscription: { findUnique: async () => activeEssentials() },
      organisation: {
        findUniqueOrThrow: async () => {
          orgLookupCalled = true;
          return {};
        },
      },
      ...emptyComplianceReads(),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/compliance-record?year=2026',
        headers: { authorization: tokenFor() },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'EMAIL_NOT_VERIFIED');
      assert.equal(orgLookupCalled, false);
    } finally {
      await app.close();
    }
  }
});

test('export rejects malformed year with 400 VALIDATION_ERROR', async () => {
  const invalidYears = ['abc', '1999', '99999', ''];

  for (const yearValue of invalidYears) {
    let orgLookupCalled = false;
    const app = await buildApp({
      ...authModels(),
      subscription: { findUnique: async () => activeEssentials() },
      organisation: {
        findUniqueOrThrow: async () => {
          orgLookupCalled = true;
          return {};
        },
      },
      ...emptyComplianceReads(),
    });

    try {
      // An empty string represents the omitted-year case (?year=).
      const url = yearValue === '' ? '/compliance-record' : `/compliance-record?year=${yearValue}`;
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: tokenFor() },
      });

      assert.equal(response.statusCode, 400, `year=${yearValue} should be 400`);
      assert.equal(response.json().code, 'VALIDATION_ERROR', `year=${yearValue}`);
      assert.doesNotMatch(response.body, /Internal server error/i);
      assert.equal(orgLookupCalled, false, `year=${yearValue} must not reach the org lookup`);
    } finally {
      await app.close();
    }
  }
});

test('export HTML-escapes stored record and register values', async () => {
  const payload = '<script>alert(1)</script>';
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeComplete() },
    organisation: emptyOrganisation(),
    governancePrinciple: {
      findMany: async () => [
        {
          id: 'p1',
          number: 1,
          title: 'Principle One',
          standards: [{ id: 's1', code: 'S1', title: payload, isCore: true }],
        },
      ],
    },
    governanceStandard: { findMany: async () => [{ id: 's1', code: 'S1', isCore: true }] },
    complianceRecord: {
      findMany: async () => [
        {
          standardId: 's1',
          status: 'COMPLIANT',
          actionTaken: payload,
          evidence: null,
          explanationIfNA: null,
          standard: {},
          updatedBy: null,
        },
      ],
    },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: {
      findMany: async () => [
        {
          trusteeName: 'Trustee',
          matter: payload,
          status: 'DECLARED',
          dateDeclared: new Date('2026-01-01'),
          actionTaken: 'None',
          minuteReference: null,
        },
      ],
    },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(
      !response.body.includes(payload),
      'stored value must be escaped, never embedded as live markup',
    );
  } finally {
    await app.close();
  }
});

test('export includes an escaped approval-readiness warning when explanations are incomplete', async () => {
  const unsafeCode = '1.1 <script>alert(1)</script>';
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeEssentials() },
    organisation: emptyOrganisation(),
    governancePrinciple: {
      findMany: async () => [
        {
          id: 'p1',
          number: 1,
          title: 'Principle One',
          standards: [{ id: 's1', code: '1.1', title: 'Standard one', isCore: true }],
        },
      ],
    },
    governanceStandard: { findMany: async () => [{ id: 's1', code: unsafeCode, isCore: true }] },
    complianceRecord: {
      findMany: async () => [
        {
          standardId: 's1',
          status: 'NOT_APPLICABLE',
          actionTaken: null,
          evidence: null,
          explanationIfNA: '   ',
          standard: { id: 's1', code: unsafeCode, principle: {} },
          updatedBy: null,
        },
      ],
    },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /review-ready/);
    assert.match(response.body, /not board-approval-ready/);
    assert.match(response.body, /NOT APPLICABLE/);
    assert.match(response.body, /1\.1 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!response.body.includes(unsafeCode), 'missing standard code must be escaped in the warning');
  } finally {
    await app.close();
  }
});

test('export includes missing records and evidence gaps in the approval-readiness warning', async () => {
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeEssentials() },
    organisation: emptyOrganisation(),
    governancePrinciple: {
      findMany: async () => [
        {
          id: 'p1',
          number: 1,
          title: 'Principle One',
          standards: [
            { id: 's1', code: '1.1', title: 'Standard one', isCore: true },
            { id: 's2', code: '1.2', title: 'Standard two', isCore: true },
          ],
        },
      ],
    },
    governanceStandard: {
      findMany: async () => [
        { id: 's1', code: '1.1', isCore: true },
        { id: 's2', code: '1.2', isCore: true },
      ],
    },
    complianceRecord: {
      findMany: async () => [
        {
          standardId: 's1',
          status: 'COMPLIANT',
          actionTaken: '',
          evidence: ' ',
          explanationIfNA: null,
          standard: { id: 's1', code: '1.1', principle: {} },
          updatedBy: null,
        },
      ],
    },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Missing action taken and evidence/);
    assert.match(response.body, /No Compliance Record status captured/);
    assert.match(response.body, /1\.1/);
    assert.match(response.body, /1\.2/);
  } finally {
    await app.close();
  }
});

test('export surfaces conditional obligation review prompts from the organisation profile', async () => {
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeEssentials() },
    organisation: {
      findUniqueOrThrow: async () => ({
        id: 'org-1',
        name: 'Example Charity',
        rcnNumber: 'RCN 123',
        complexity: 'SIMPLE',
        conditionalObligationProfile: {
          ...falseProfile(),
          hasPaidStaff: true,
          usesDataProcessors: true,
        },
      }),
    },
    governancePrinciple: {
      findMany: async () => [
        {
          id: 'p1',
          number: 1,
          title: 'Principle One',
          standards: [{ id: 's1', code: '1.1', title: 'Standard one', isCore: true }],
        },
      ],
    },
    governanceStandard: { findMany: async () => [{ id: 's1', code: '1.1', isCore: true }] },
    complianceRecord: {
      findMany: async () => [
        {
          standardId: 's1',
          status: 'COMPLIANT',
          actionTaken: 'Reviewed by trustees',
          evidence: 'Board pack and minutes',
          explanationIfNA: null,
          standard: { id: 's1', code: '1.1', principle: {} },
          updatedBy: null,
        },
      ],
    },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Conditional obligation review prompts/);
    assert.match(response.body, /Employment obligations/);
    assert.match(response.body, /Data processor review/);
    assert.match(response.body, /Professional review/);
  } finally {
    await app.close();
  }
});

test('export omits the approval-readiness warning when explanations are complete', async () => {
  const app = await buildApp({
    ...authModels(),
    subscription: { findUnique: async () => activeEssentials() },
    organisation: emptyOrganisation(),
    governancePrinciple: {
      findMany: async () => [
        {
          id: 'p1',
          number: 1,
          title: 'Principle One',
          standards: [{ id: 's1', code: '1.1', title: 'Standard one', isCore: true }],
        },
      ],
    },
    governanceStandard: { findMany: async () => [{ id: 's1', code: '1.1', isCore: true }] },
    complianceRecord: {
      findMany: async () => [
        {
          standardId: 's1',
          status: 'EXPLAIN',
          actionTaken: null,
          evidence: null,
          explanationIfNA: 'Explained for the trustees',
          standard: { id: 's1', code: '1.1', principle: {} },
          updatedBy: null,
        },
      ],
    },
    complianceSignoff: { findUnique: async () => null },
    conflictRecord: { findMany: async () => [] },
    riskRecord: { findMany: async () => [] },
    complaintRecord: { findMany: async () => [] },
    fundraisingRecord: { findMany: async () => [] },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/compliance-record?year=2026',
      headers: { authorization: tokenFor() },
    });

    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /not board-approval-ready/);
  } finally {
    await app.close();
  }
});
