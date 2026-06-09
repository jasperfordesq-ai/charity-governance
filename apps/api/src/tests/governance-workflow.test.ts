import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptTeamInviteSchema,
  ComplianceStatus,
  createCheckoutSchema,
  createRiskRecordSchema,
  inviteTeamMemberSchema,
  refreshSchema,
  upsertAnnualReportReadinessSchema,
  upsertComplianceSignoffSchema,
} from '@charitypilot/shared';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'governance-workflow-test-secret';
process.env.JWT_EXPIRY = process.env.JWT_EXPIRY ?? '1h';

test('risk register validation enforces 1-5 likelihood and impact scores', () => {
  const result = createRiskRecordSchema.safeParse({
    title: 'Late annual filing',
    category: 'GOVERNANCE',
    description: 'Financial statements could be approved too late for annual filing.',
    likelihood: 6,
    impact: 4,
    mitigation: 'Board timetable and finance lead assigned.',
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail('Risk validation should have failed');
  assert.match(result.error.issues[0]?.path.join('.') ?? '', /likelihood/);
});

test('board approval sign-off requires meeting date, minute reference, and approver', () => {
  const result = upsertComplianceSignoffSchema.safeParse({
    reportingYear: 2026,
    status: 'APPROVED',
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail('Approved sign-off without approval fields should fail');
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path.join('.')).sort(),
    ['approvedByName', 'boardMeetingDate', 'minuteReference'],
  );
});

test('annual report readiness accepts the expected governance workflow fields', () => {
  const result = upsertAnnualReportReadinessSchema.safeParse({
    reportingYear: 2026,
    activitiesNarrative: 'Programmes delivered across the year.',
    publicBenefitStatement: 'Activities advanced the charity purpose for public benefit.',
    financialStatementsApproved: true,
    trusteeDetailsReviewed: true,
    filingStatus: 'BOARD_APPROVED',
    boardApprovalDate: '2026-09-15',
  });

  assert.equal(result.success, true);
});

test('team invites restrict assignable roles and enforce invited account password strength', () => {
  assert.equal(inviteTeamMemberSchema.safeParse({ email: 'person@example.org', role: 'OWNER' }).success, false);
  assert.equal(inviteTeamMemberSchema.safeParse({ email: 'person@example.org', role: 'ADMIN' }).success, true);
  assert.equal(
    acceptTeamInviteSchema.safeParse({
      token: 'abc',
      name: 'Invited Trustee',
      password: 'weak',
    }).success,
    false,
  );
});

test('billing checkout accepts only supported plan intervals', () => {
  assert.equal(createCheckoutSchema.safeParse({ plan: 'COMPLETE', interval: 'yearly' }).success, true);
  assert.equal(createCheckoutSchema.safeParse({ plan: 'COMPLETE', interval: 'weekly' }).success, false);
});

test('refresh requests can rely on the secure refresh cookie', () => {
  assert.equal(refreshSchema.safeParse({}).success, true);
  assert.equal(refreshSchema.safeParse({ refreshToken: '' }).success, false);
});

test('Essentials compliance summaries include only core standards even for complex organisations', async () => {
  const { ComplianceService } = await import('../services/compliance.service.js');

  const coreStandard = {
    id: 'standard-core',
    principleId: 'principle-1',
    isCore: true,
    principle: { id: 'principle-1', number: 1, title: 'Advancing charitable purpose' },
  };
  const additionalStandard = {
    id: 'standard-additional',
    principleId: 'principle-1',
    isCore: false,
    principle: { id: 'principle-1', number: 1, title: 'Advancing charitable purpose' },
  };
  const prisma = {
    organisation: {
      findUniqueOrThrow: async () => ({ id: 'org-1', complexity: 'COMPLEX' }),
    },
    subscription: {
      findUnique: async () => ({ plan: 'ESSENTIALS' }),
    },
    governanceStandard: {
      findMany: async (query: { where?: { isCore?: boolean } }) =>
        query.where?.isCore ? [coreStandard] : [coreStandard, additionalStandard],
    },
    complianceRecord: {
      findMany: async () => [
        { standardId: 'standard-core', status: 'COMPLIANT' },
        { standardId: 'standard-additional', status: 'COMPLIANT' },
      ],
    },
  };
  const service = new ComplianceService(prisma as never);

  const summary = await service.getSummary('org-1', 2026);

  assert.equal(summary.totalApplicable, 1);
  assert.equal(summary.compliant, 1);
  assert.equal(summary.percentComplete, 100);
});

test('Essentials organisations cannot write compliance records for additional standards', async () => {
  const { ComplianceService } = await import('../services/compliance.service.js');
  const { AppError } = await import('../utils/errors.js');
  let upsertCalled = false;
  const prisma = {
    organisation: {
      findUniqueOrThrow: async () => ({ id: 'org-1', complexity: 'COMPLEX' }),
    },
    subscription: {
      findUnique: async () => ({ plan: 'ESSENTIALS' }),
    },
    governanceStandard: {
      findUnique: async () => ({ id: 'standard-additional', isCore: false }),
    },
    complianceRecord: {
      upsert: async () => {
        upsertCalled = true;
        return {};
      },
    },
  };
  const service = new ComplianceService(prisma as never);

  await assert.rejects(
    () =>
      service.upsertRecord('org-1', 'standard-additional', 'user-1', {
        reportingYear: 2026,
        status: ComplianceStatus.COMPLIANT,
        actionTaken: 'Additional standard evidence',
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 403 &&
      error.code === 'COMPLIANCE_STANDARD_NOT_INCLUDED_IN_PLAN',
  );
  assert.equal(upsertCalled, false);
});

test('Essentials organisations cannot access Complete-only governance register endpoints', async () => {
  const [{ default: Fastify }, { governanceRegisterRoutes }, { signAccessToken }] = await Promise.all([
    import('fastify'),
    import('../routes/governance-registers/index.js'),
    import('../utils/jwt.js'),
  ]);

  let registerSummaryRead = false;
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    authSession: {
      findFirst: async () => ({ id: 'session-1' }),
    },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        organisationId: 'org-1',
        role: 'OWNER',
        emailVerified: true,
      }),
    },
    subscription: {
      findUnique: async () => ({ status: 'ACTIVE', trialEndsAt: null, plan: 'ESSENTIALS' }),
    },
    conflictRecord: {
      count: async () => {
        registerSummaryRead = true;
        return 0;
      },
    },
    riskRecord: { count: async () => 0 },
    complaintRecord: { count: async () => 0 },
    fundraisingRecord: { count: async () => 0 },
    annualReportReadiness: { findUnique: async () => null },
    financialControlReview: { findUnique: async () => null },
  } as never);
  await app.register(governanceRegisterRoutes, { prefix: '/governance-registers' });

  try {
    const token = signAccessToken({
      userId: 'user-1',
      organisationId: 'org-1',
      role: 'OWNER',
      sessionId: 'session-1',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/governance-registers/summary?year=2026',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'PLAN_FEATURE_UNAVAILABLE');
    assert.equal(registerSummaryRead, false);
  } finally {
    await app.close();
  }
});
